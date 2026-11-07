import { randomUUID, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import schema from '@deepseek-ai/schemastery';
import { validateWorkflow, runWorkflow } from './core.mjs';
import { continueNodeSession } from './continuation.mjs';
import { classifyMessage, isRootAgent, routerInstruction } from './global.mjs';

const memberLabel = (runId, nodeId) => `dw-${runId}-${createHash('sha256').update(nodeId).digest('hex').slice(0, 12)}`;

export const inject = ['tools', 'storageDomain', 'commands', 'settings'];
export const Config = schema.object({ globalEnabled: schema.boolean().default(false).description('Classify every human message in root sessions with the current session model before handling it.').volatile() });
const capsuleClaims = new Set();
const reviewError = text => Object.assign(new Error(text), { needsReview: true });
const SCRIPT = 'return await agent(args.prompt, args.options);';
const LIMIT = 12000;

function scoped(agent, name) {
  const service = agent.ctx?.get(name);
  if (!service) throw new Error(`${name} is unavailable in the parent agent context`);
  return service;
}
function nodeRequest(node, dependencies, selection = {}) {
  const prompt = node.prompt ?? (typeof node.input === 'string' ? node.input : undefined);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`Node ${node.id} requires prompt or string input`);
  const options = { label: node.id };
  for (const key of ['provider', 'model']) {
    if (node[key] !== undefined) {
      if (typeof node[key] !== 'string' || !node[key].trim()) throw new Error(`Invalid ${key} for ${node.id}`);
      options[key] = node[key];
    }
  }
  for (const key of ['provider', 'model']) if (selection[key] !== undefined) options[key] = selection[key];
  if (node.schema !== undefined) options.schema = node.schema;
  let text = prompt;
  if (node.prompt !== undefined && node.input !== undefined) text += `\n\nInput:\n${JSON.stringify(node.input)}`;
  if (Object.keys(dependencies).length) text += `\n\nDependencies:\n${JSON.stringify(dependencies)}`;
  return { prompt: text, options };
}
function brief(record, snapshot = record.snapshot, nodeId) {
  const result = { runId: record.id, workflowPath: record.path, status: record.status, restartSupported: true,
    title: record.title ?? record.workflow?.title ?? record.workflow?.id ?? record.path,
    createdAt: record.createdAt, ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}), concurrency: record.concurrency ?? 1,
    resumeSupported: record.workflow !== undefined };
  for (const key of ['resumedFrom', 'model', 'provider', 'contextWarning', 'revisionReason']) if (record[key] !== undefined) result[key] = record[key];
  if (record.error) result.error = record.error.slice(0, LIMIT);
  if (snapshot) {
    const definitions = new Map((Array.isArray(record.workflow?.nodes) ? record.workflow.nodes : []).map(node => [node.id, node]));
    result.nodes = Object.fromEntries(Object.entries(snapshot.nodes || {}).map(([id, node]) => {
      const definition = definitions.get(id), session = record.nodeSessions?.[id];
      return [id, { status: node.status, ...(node.operationId ? { operationId: node.operationId, reconciliation: 'Verify external effects and durable receipts before repeating this operation; session continuity is not exactly-once execution.' } : {}), reused: node.reused === true,
        ...(node.skipped === true ? { skipped: true } : {}),
        ...(definition?.reviewStep ? { reviewStep: definition.reviewStep } : {}),
        ...(definition?.agentStep ? { agentStep: definition.agentStep } : {}),
        ...(typeof definition?.title === 'string' ? { title: definition.title } : {}),
        ...(typeof definition?.agentTitle === 'string' ? { agentTitle: definition.agentTitle } : {}),
        ...(typeof definition?.agentId === 'string' ? { agentId: definition.agentId } : {}),
        ...(typeof definition?.roleTitle === 'string' ? { roleTitle: definition.roleTitle } : {}),
        ...(typeof definition?.role === 'string' ? { role: definition.role } : {}),
        ...(Array.isArray(definition?.deps) ? { deps: definition.deps } : {}),
        ...(session ? { agentSessionId: session.childId, continuations: session.continuations ?? 0 } : {}) }];
    }));
    const failedGate = Object.entries(snapshot.nodes || {}).find(([id, node]) => definitions.get(id)?.reviewStep?.kind === 'gate' && node.status === 'failed');
    if (!result.error && failedGate?.[1].error) result.error = failedGate[1].error.slice(0, LIMIT);
    if (nodeId !== undefined) {
      if (!snapshot.nodes || !Object.hasOwn(snapshot.nodes, nodeId)) throw new Error('Node not found');
      const node = snapshot.nodes[nodeId];
      const text = JSON.stringify(node);
      result.node = text.length > LIMIT ? { preview: text.slice(0, LIMIT), truncated: true } : node;
    }
  }
  return result;
}

/** Host adapter: workflow state lives in the profile storage domain, scoped by Session id. */
export async function apply(ctx, config = {}) {
  const runStatus = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'needs_review']);
  const snapshotSchema = z.object({
    version: z.literal(1), workflowId: z.string(), runId: z.string(),
    status: runStatus,
    nodes: z.record(z.string(), z.object({
      status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted', 'blocked', 'needs_review']),
      fingerprint: z.string().optional(), operationId: z.string().optional(), reused: z.boolean().optional(), skipped: z.boolean().optional(), output: z.json().optional(),
      outputHash: z.string().optional(), error: z.string().optional(),
    }).strict()),
  }).strict();
  const recordSchema = z.object({
    id: z.string(), ownerId: z.string(), key: z.string(), path: z.string(), status: runStatus,
    createdAt: z.number().int().nonnegative(), snapshot: snapshotSchema.optional(), error: z.string().optional(),
    workflow: z.json().optional(), title: z.string().optional(), resumedFrom: z.string().optional(),
    model: z.string().optional(), provider: z.string().optional(), concurrency: z.number().int().min(1).max(8).optional(), revisionReason: z.string().optional(),
    nodeSessions: z.record(z.string(), z.object({ childId: z.string(), fingerprint: z.string(), continuations: z.number().int().nonnegative().optional(), operationId: z.string().optional() }).strict()).optional(),
    contextWarning: z.string().optional(), archivedAt: z.number().optional(), archivePayload: z.string().optional(), archiveHash: z.string().optional(), inputDigests: z.json().optional(),
  }).strict();
  const domain = await ctx.storageDomain.open({ name: 'dynamic_workflow', version: 1, compatibleVersions: [1], tables: {
    runs: { valueSchema: recordSchema },
  } });
  const runsTable = domain.table('runs');
  const records = new Map();
  for (const [id, saved] of runsTable.entries()) {
    records.set(id, { ...saved, owner: { id: saved.ownerId }, handles: new Set(), controller: new AbortController(), status: saved.status === 'running' ? 'interrupted' : saved.status, workflow: saved.workflow });
  }
  function saveRecord(record) {
    const value = structuredClone({ id: record.id, ownerId: record.owner.id, key: record.key, path: record.path, status: record.status, createdAt: record.createdAt, snapshot: record.snapshot, error: record.error,
      workflow: record.workflow, title: record.title, resumedFrom: record.resumedFrom,
      model: record.model, provider: record.provider, concurrency: record.concurrency, revisionReason: record.revisionReason,
      nodeSessions: record.nodeSessions, contextWarning: record.contextWarning, archivedAt: record.archivedAt, archivePayload: record.archivePayload, archiveHash: record.archiveHash, inputDigests: record.inputDigests });
    record.pendingSave = (record.pendingSave ?? Promise.resolve()).then(() => runsTable.put(record.id, value));
    return record.pendingSave;
  }
  const activeMembers = new Map();
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on('workflow/agent-start', (info, child) => {
    const member = activeMembers.get(child.label);
    if (!member || (member.engineId !== undefined && member.engineId !== info.id)) return;
    member.record.nodeSessions[member.nodeId] = { childId: child.childId, fingerprint: member.fingerprint, operationId: member.operationId, continuations: 0 };
    void saveRecord(member.record).catch(error => {
      member.record.error = `Agent checkpoint persistence failed: ${String(error)}`;
      member.record.controller.abort(error);
      for (const handle of member.record.handles) handle.cancel('Agent checkpoint persistence failed');
    });
  }));
  let closed = false;
  const ownerMatches = (record, owner) => record.ownerId === owner.id;
  async function cancel(record) {
    if (!record.done) return;
    record.controller.abort();
    for (const handle of record.handles) handle.cancel('Dynamic workflow stopped');
    await record.done;
  }
  const assembledRoutes = new WeakMap();
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next();
    const scope = context.scope;
    if (scope && typeof scope === 'object') {
      const { provider, model } = result.variables;
      if (provider && model) assembledRoutes.set(scope, { provider, model });
      else assembledRoutes.delete(scope);
    }
    return result;
  }, { prepend: true }));
  const judgedPrompts = new WeakMap();
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const enabled = typeof config.globalEnabled?.get === 'function' ? config.globalEnabled.get() : config.globalEnabled;
    if (enabled !== true) return next();
    const agent = payload?.agent;
    if (!isRootAgent(agent) || !Array.isArray(payload.messages)) return next();
    const prompts = payload.messages.filter(message => message.role === 'user' && message.source?.kind === 'user' && typeof message.id === 'string' && message.id);
    if (!prompts.length) return next();
    let result = await next();
    if (result.kind !== 'enter') return result;
    let judged = judgedPrompts.get(agent);
    if (!judged) judgedPrompts.set(agent, judged = new Set());
    const header = agent.session?.requestHeader?.();
    const route = assembledRoutes.get(agent) ?? header?.config ?? agent.options;
    for (const prompt of prompts) {
      if (judged.has(prompt.id)) continue;
      const text = (Array.isArray(prompt.content) ? prompt.content.filter(block => block.type === 'text').map(block => block.text) : [prompt.content]).filter(Boolean).join('\n');
      if (!text.trim()) continue;
      // The pre-step hook also runs for tool continuations and retries. Claim each
      // submitted message before awaiting the classifier, including direct replies.
      judged.add(prompt.id);
      const active = [...records.values()].filter(record => ownerMatches(record, agent) && record.status === 'running').sort((a, b) => b.createdAt - a.createdAt)[0];
      const decision = await classifyMessage({ llm: agent.ctx.get('llm'), config: route, message: text, active: active ? brief(active) : undefined, signal: payload.signal });
      if (decision.action === 'direct' && !decision.diagnostic) continue;
      if (decision.action === 'revise' && active) await cancel(active);
      const instruction = decision.diagnostic ?? routerInstruction(decision, { message: text, runId: active?.id, path: active?.path });
      const routingMessage = Object.freeze({
        id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'dynamic-workflow' }),
        content: Object.freeze([Object.freeze({ type: 'text', text: instruction })]),
      });
      result = { ...result, messages: [...result.messages, routingMessage] };
    }
    return result;
  }));
  ctx.effect(() => () => {
    closed = true;
    return (async () => {
      const drained = await Promise.allSettled([...records.values()].map(cancel));
      await domain.close();
      const failure = drained.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
  });
  ctx.effect(() => ctx.tools.register({
    name: 'dynamic_workflow',
    description: 'Local 0.5.2 reliability: explicit inputFiles (max16, 1 MiB each/4 MiB total) are rehashed through parent fs each invocation. timeoutMs defaults to 600000 (max3600000), maxRetries 0–3 requires retrySafe:true. Declarative condition uses dependency/equals. writeResources declares logical writer conflicts; omission serializes members. Human approval declarations are unsupported. Stable operationIds require real effect/receipt reconciliation, not exactly-once guarantees. Read-only archive-preview reports exact scope, serialized storage bytes and protected reason. list includeArchived:true with offset discovers archived records. Explicit owner-scoped archive/archive-read/restore compress plugin snapshots without deleting host sessions. revise requires workflowPath for new JSON; runId alone uses the saved definition. Run JSON workflow nodes serially, resume or revise a saved run, inspect progress, message a running Agent, list models, stop execution, or read/update the global workflow setting. Workflow agentId names are not Team teammate targets; use message to steer the existing child. A message receipt confirms inbox acceptance, not task completion. State survives plugin restart. Run reads the current JSON; resume uses the saved definition and snapshot, stopping active execution first. Unchanged completed nodes are reused across model switches. Unfinished nodes resume their original persisted Agent session and history when its identity and fingerprint are verified; a missing saved Agent is an error. Legacy interruptions require review unless retrySafe is true. JSON nodes use id, prompt (or string input), deps, optional provider/model/schema/retrySafe. Nodes run one at a time in stable dependency order. For multiple Agents within one node, use agents:[{id,agentId,prompt,role?,provider?,model?,schema?,retrySafe?}] and optional agentConcurrency (1–8); outputs are collected by member id. Use internal member ids from status for message or member result inspection. For persistent capsules, define agents:{id:{title}}, roles:{id:{prompt,title?,tools?}}, and node agentId/role. The same agentId reuses one Agent across serial stages, applying each role before activation. tools:[] also disables the top-level run_code transport, so the child returns text only; omitted tools inherit. Changed executed shared stages require a new workflow id; appended stages keep the Agent. A node may define reviewLoop:{review:{agentId,prompt,role?},fix:{agentId,prompt,role?},maxRounds:3}. Distinct review/fix Agents run at most maxRounds reviews including the initial review (default 3, range 1–50). Reviews return {verdict:"approved"|"changes-required",findings:[{message,evidence}]}; approval requires empty findings, rejection requires findings. Approval skips unused rounds; exhaustion fails the original node and blocks its dependents.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['run', 'resume', 'revise', 'status', 'stop', 'list', 'models', 'settings', 'message', 'archive', 'archive-preview', 'archive-read', 'restore'] },
        model: { type: 'string', description: 'For run/resume: executor model override; completed nodes retain their fingerprints. Resume defaults to the saved selection.' },
        provider: { type: 'string', description: 'For run/resume: executor provider override; resume defaults to the saved selection.' },
        workflowPath: { type: 'string', description: 'For run or revise: JSON file readable under the current session filesystem policy; relative paths resolve against its working directory.' },
        runId: { type: 'string', description: 'For resume, revise, status, stop, message, archive, archive-read or restore: identifier returned by run.' },
        nodeId: { type: 'string', description: 'For message: required running node id from status. For status: include its result, truncated at 12000 characters.' },
        message: { type: 'string', minLength: 1, maxLength: LIMIT, description: 'For message: required nonblank text to deliver to the running node.' },
         revisionReason: { type: 'string', description: 'For revise: the user message or concise reason that caused the workflow change.' },
        concurrency: { type: 'integer', minimum: 1, maximum: 8, description: 'For run/resume: maximum concurrent Agents within the current node, 1–8, further limited by node.agentConcurrency. Nodes stay serial. Run defaults to 1; resume uses the saved value.' },
        includeArchived: { type: 'boolean', description: 'For list only: include owner-scoped archived previews; default false. Payload storage remains unbounded.' },
        offset: { type: 'integer', minimum: 0, description: 'For list only: page offset, 100 previews per page; use nextOffset to discover all owner records.' },
        globalEnabled: { type: 'boolean', description: 'For settings: optionally set the global workflow switch; omit to read it.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
  }));
  const commandHelp = [
    '工作流命令：',
    '/workflow run <JSON文件路径> — 运行工作流',
    '/workflow list — 查看运行记录',
    '/workflow status <runId> — 查看状态',
    '/workflow resume <runId> — 继续原工作流',
    '/workflow revise <runId> — 使用保存的定义；新定义用 JSON: {"action":"revise","runId":"…","workflowPath":"new.json"}',
    '/workflow archive-preview <runId> — 只读查看归档范围、字节数与保护原因',
    '/workflow {"action":"list","includeArchived":true,"offset":0} — 查看含归档的当前会话记录',
    '/workflow archive|archive-read|restore <runId> — 可逆归档、读取、恢复（不删除会话）',
    '/workflow stop <runId> — 停止运行',
    '/workflow models — 查看可用模型',
    '/workflow {"action":"message","runId":"<runId>","nodeId":"<nodeId>","message":"进度如何？"} — 向运行中的节点发送消息',
    '高级参数可直接使用 JSON，例如 /workflow {"action":"list"}。',
  ].join('\n');
  if (ctx.commands) for (const name of ['dynamic-workflow', 'workflow']) ctx.effect(() => ctx.commands.register({
    name,
    description: '运行、查看、继续或停止工作流；输入 /workflow 查看用法。',
    input: { hint: 'run <JSON文件路径> | list | status <runId> | resume <runId> | stop <runId> | models' },
    async handler(invocation) {
      try {
        const input = invocation.rawInput.trim();
        if (!input || input === 'help') return { kind: 'success', text: commandHelp };
        let args;
        if (input.startsWith('{')) args = JSON.parse(input);
        else {
          const [, action, argument] = /^(\S+)(?:\s+([\s\S]+))?$/.exec(input);
          if (action === 'run' && argument) args = { action, workflowPath: argument.replace(/^(['"])([\s\S]*)\1$/, '$2') };
          else if (['status', 'resume', 'revise', 'stop', 'archive', 'archive-preview', 'archive-read', 'restore'].includes(action) && argument) args = { action, runId: argument };
          else if (['list', 'models'].includes(action) && !argument) args = { action };
          else throw new Error('命令参数不正确。输入 /workflow 查看用法。');
        }
        return { kind: 'success', text: JSON.stringify(await execute(args, invocation)) };
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : String(error) }; }
    },
  }));
  // Connection authenticates these exact Fetch routes and admits owner peers only.
  // Background UI reads must not pass through commands.execute: it logs every call.
  ctx.inject?.(['connection', 'sessionController'], scope => {
    const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/dynamic-workflow/read', methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const url = new URL(request.url);
          const sessionId = url.searchParams.get('sessionId');
          const args = JSON.parse(url.searchParams.get('args') || '{}');
          if (!sessionId || !['list', 'status'].includes(args?.action)) return json({ error: 'A session and read-only action (list/status) are required' }, 400);
          request.signal.throwIfAborted();
          const resolved = await scope.sessionController.resolveAgent(sessionId);
          if (resolved.error) return json({ error: resolved.error.message }, resolved.error.code === 'session/not-found' ? 404 : 409);
          request.signal.throwIfAborted();
          return json(await execute(args, { agent: resolved.agent, signal: request.signal }));
        } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
      },
    }));
  });
  const locks = new Set();
  async function execute(args, exec, resumeSource, revision = false) {
      if (closed) throw new Error('Plugin is unloading');
      const owner = exec.agent;
      if (!owner?.ctx || !owner.id) throw new Error('A parent agent is required');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
      for (const key of Object.keys(args)) if (!['action', 'workflowPath', 'runId', 'nodeId', 'concurrency', 'model', 'provider', 'revisionReason', 'globalEnabled', 'message', 'includeArchived', 'offset'].includes(key)) throw new Error(`Unknown parameter: ${key}`);
      if (args.includeArchived !== undefined && typeof args.includeArchived !== 'boolean') throw new Error('includeArchived must be a boolean');
      if (args.includeArchived !== undefined && args.action !== 'list') throw new Error('includeArchived is only valid for list');
      if (args.offset !== undefined && (args.action !== 'list' || !Number.isSafeInteger(args.offset) || args.offset < 0)) throw new Error('offset must be a nonnegative integer for list only');
      for (const key of ['model', 'provider']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`Invalid ${key}`);
      if (args.action === 'settings') {
        const settings = ctx.settings ?? owner.ctx.get('settings');
        if (!settings) throw new Error('settings is unavailable');
        const read = () => {
          const view = settings.describe({ redactSecrets: true }).find(entry => entry.ns === 'dynamic-workflow');
          if (!view) throw new Error('dynamic-workflow settings namespace not found');
          return view;
        };
        let view = read();
        if (args.globalEnabled !== undefined) {
          if (typeof args.globalEnabled !== 'boolean') throw new Error('globalEnabled must be a boolean');
          await settings.mutate(view.ns, [{ op: 'set', path: ['globalEnabled'], value: args.globalEnabled }], view.revision);
          view = read();
        }
        return { ns: view.ns, globalEnabled: view.value?.globalEnabled === true, revision: view.revision };
      }
      if (args.action === 'models') {
        const llm = scoped(owner, 'llm');
        return { providers: await Promise.all(llm.listProviders().map(async provider => {
          try { return { ...provider, models: await llm.listModels(provider.id) }; }
          catch (error) { return { ...provider, models: [], error: String(error?.message ?? error) }; }
        })) };
      }
      if (args.action === 'restart') throw new Error('Safe restart recovery is unsupported; run again only after reviewing possible side effects');
      if (['archive', 'archive-preview', 'archive-read', 'restore'].includes(args.action)) {
        const record = records.get(args.runId);
        if (!record || !ownerMatches(record, owner)) throw new Error('Run not found for this owner');
        const storageBytes = Buffer.byteLength(JSON.stringify(runsTable.get(record.id)));
        const protectedReason = record.archivedAt ? 'Run is already archived' : record.status === 'running' || record.status === 'needs_review' || Object.values(record.snapshot?.nodes ?? {}).some(node => ['running', 'needs_review', 'interrupted'].includes(node.status)) ? 'Archive protects running, interrupted and needs_review state' : [...records.values()].some(other => ownerMatches(other, owner) && other.resumedFrom === record.id) ? 'Archive protects resume ancestry' : storageBytes > 32 * 1024 * 1024 ? 'Archive exceeds 32 MiB readback limit' : undefined;
        if (args.action === 'archive-preview') return { runId: record.id, ownerId: record.owner.id, workflowPath: record.path, workflowId: record.workflow?.id, status: record.status, isArchived: Boolean(record.archivedAt), archivedAt: record.archivedAt, eligible: !protectedReason, protectedReason: protectedReason ?? null, storageBytes, scope: 'This exact owner/run plugin record only; host sessions are excluded', payloadStorageBounded: false };
        const unpack = () => {
          if (!record.archivePayload) return record; // older metadata-only archives
          const bytes = gunzipSync(Buffer.from(record.archivePayload, 'base64'), { maxOutputLength: 32 * 1024 * 1024 });
          if (createHash('sha256').update(bytes).digest('hex') !== record.archiveHash) throw new Error('Archive checksum mismatch; refusing restore');
          const saved = recordSchema.parse(JSON.parse(bytes.toString('utf8')));
          if (saved.ownerId !== owner.id || saved.id !== record.id) throw new Error('Archive owner/identity mismatch');
          return { ...record, ...saved, owner: record.owner };
        };
        if (args.action === 'archive-read') {
          if (!record.archivedAt) throw new Error('Run is not archived');
          const saved = unpack();
          return { ...brief(saved, saved.snapshot, args.nodeId), workflow: saved.workflow };
        }
        if (locks.has(record.id)) throw new Error('Run archive/restore already in progress');
        locks.add(record.id);
        try {
          if (args.action === 'archive') {
            if (record.archivedAt) return brief(record);
            if (record.status === 'running' || record.status === 'needs_review' || Object.values(record.snapshot?.nodes ?? {}).some(node => ['running', 'needs_review', 'interrupted'].includes(node.status))) throw new Error('Archive protects running, interrupted and needs_review state');
            if ([...records.values()].some(other => ownerMatches(other, owner) && other.resumedFrom === record.id)) throw new Error('Archive protects resume ancestry');
            const bytes = Buffer.from(JSON.stringify(runsTable.get(record.id)));
            if (bytes.length > 32 * 1024 * 1024) throw new Error('Archive exceeds 32 MiB readback limit; inspect individual node results');
            const archivePayload = gzipSync(bytes).toString('base64');
            const archiveHash = createHash('sha256').update(bytes).digest('hex');
            if (!gunzipSync(Buffer.from(archivePayload, 'base64'), { maxOutputLength: 32 * 1024 * 1024 }).equals(bytes)) throw new Error('Archive readback verification failed');
            const compact = { ...record, archivedAt: Date.now(), archivePayload, archiveHash };
            for (const key of ['snapshot', 'workflow', 'nodeSessions', 'inputDigests']) delete compact[key];
            await saveRecord(compact);
            const stored = runsTable.get(record.id);
            if (stored.archiveHash !== archiveHash || stored.archivePayload !== archivePayload) throw new Error('Durable archive readback mismatch');
            for (const key of ['snapshot', 'workflow', 'nodeSessions', 'inputDigests']) delete record[key];
            Object.assign(record, compact);
          } else {
            const restored = { ...unpack() };
            for (const key of ['archivedAt', 'archivePayload', 'archiveHash']) delete restored[key];
            await saveRecord(restored);
            for (const key of ['archivedAt', 'archivePayload', 'archiveHash']) delete record[key];
            Object.assign(record, restored);
          }
          return { ...brief(record), archivalOnly: true, storageLimit: 'Explicit archive compresses plugin snapshots; archives and host session history still grow. No host sessions are deleted.' };
        } finally { locks.delete(record.id); }
      }
      if (args.action === 'list') {
        const all = [...records.values()].filter(record => ownerMatches(record, owner) && (args.includeArchived === true || !record.archivedAt)).sort((a, b) => b.createdAt - a.createdAt);
        const offset = args.offset ?? 0;
        return { runs: all.slice(offset, offset + 100).map(record => ({ ...brief(record), isArchived: Boolean(record.archivedAt) })), ...(args.includeArchived !== undefined || args.offset !== undefined ? { total: all.length, offset, nextOffset: offset + 100 < all.length ? offset + 100 : null } : {}) };
      }
      if (args.action === 'message') {
        const record = records.get(args.runId);
        if (!record || !ownerMatches(record, owner)) throw new Error('Run not found for this owner');
        if (record.status !== 'running') throw new Error('Run is not running');
        if (typeof args.nodeId !== 'string' || !args.nodeId.trim()) throw new Error('nodeId is required');
        const node = record.snapshot?.nodes?.[args.nodeId];
        if (!node) throw new Error('Node not found');
        if (node.status !== 'running') throw new Error('Node is not running');
        if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > LIMIT) throw new Error(`message must be nonblank text of at most ${LIMIT} characters`);
        const childId = record.nodeSessions?.[args.nodeId]?.childId;
        const live = childId && owner.ctx.get('agents')?.get(childId);
        if (!live || live.status !== 'running' || live.session?.header?.parentSession !== owner.id) throw new Error('Node has no live running child; inspect its status before messaging');
        const subagents = scoped(owner, 'subagents');
        if (typeof subagents.sendMessage !== 'function' || typeof ctx.on !== 'function') throw new Error('Native child messaging is unavailable');
        const admission = new AbortController();
        const off = ctx.on('subagent/end', info => {
          if (info.id === childId) admission.abort(new Error('Node stopped before message acceptance'));
        });
        try {
          const signal = AbortSignal.any([exec.signal, record.controller.signal, admission.signal].filter(Boolean));
          signal.throwIfAborted();
          const messageId = await subagents.sendMessage(owner, childId, [{ type: 'text', text: args.message }], { signal });
          return { runId: record.id, nodeId: args.nodeId, agentSessionId: childId, messageId, accepted: true };
        } finally { off(); }
      }
      if (args.action === 'status' || args.action === 'stop') {
        const record = records.get(args.runId);
        if (!record || !ownerMatches(record, owner)) throw new Error('Run not found for this owner');
        if (args.action === 'stop') await cancel(record);
        const value = { ...brief(record, record.snapshot, args.nodeId), ...(record.workflow === undefined ? {} : { workflow: record.workflow }) };
        if (args.nodeId !== undefined) {
          const childId = record.nodeSessions?.[args.nodeId]?.childId;
          const live = childId && owner.ctx.get('agents')?.get(childId);
          if (live?.session?.header.parentSession === owner.id && typeof live.session.deriveMessages === 'function') {
            const last = live.session.deriveMessages().findLast(message => message.role === 'assistant');
            const text = (last?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
            const config = live.session.requestHeader()?.config;
            value.agent = { sessionId: childId, status: live.status, lastAssistantText: text.slice(0, LIMIT),
              ...(typeof config?.provider === 'string' ? { provider: config.provider } : {}),
              ...(typeof config?.model === 'string' ? { model: config.model } : {}) };
          } else if (childId && owner.ctx.get('sessionController')?.inspect) {
            try {
              const inspection = await owner.ctx.get('sessionController').inspect(childId, exec.signal);
              if (inspection.meta.parentSession !== owner.id) throw new Error('Saved Agent parent mismatch');
              const config = inspection.events.findLast(event => event.type === 'request/header')?.data.header.config;
              value.agent = { sessionId: childId, status: 'inactive',
                ...(typeof config?.provider === 'string' ? { provider: config.provider } : {}),
                ...(typeof config?.model === 'string' ? { model: config.model } : {}) };
            } catch (error) { value.agentInspectionError = String(error); }
          }
        }
        return value;
      }
      if (args.action === 'revise') {
        const source = records.get(args.runId);
        if (!source || !ownerMatches(source, owner)) throw new Error('Run not found for this owner');
        if (source.archivedAt) throw new Error('Run is archived; restore it before resume/revise');
        if (!source.workflow) throw new Error('Saved workflow definition is unavailable');
        if (args.workflowPath === undefined) return execute({ ...args, action: 'resume' }, exec);
        if (typeof args.workflowPath !== 'string' || !args.workflowPath.trim()) throw new Error('workflowPath is required for a new revision definition');
        if (locks.has(source.id)) throw new Error('Run revision already in progress');
        locks.add(source.id);
        try {
          if (source.status === 'running') await cancel(source);
          return await execute({ action: 'run', workflowPath: args.workflowPath, concurrency: args.concurrency ?? source.concurrency ?? 1, model: args.model ?? source.model, provider: args.provider ?? source.provider, revisionReason: args.revisionReason }, exec, source, true);
        } finally { locks.delete(source.id); }
      }
      if (args.action === 'resume') {
        const source = records.get(args.runId);
        if (!source || !ownerMatches(source, owner)) throw new Error('Run not found for this owner');
        if (source.archivedAt) throw new Error('Run is archived; restore it before resume/revise');
        if (!source.workflow) throw new Error('Saved workflow definition is unavailable');
        if (locks.has(source.id)) throw new Error('Run resume already in progress');
        locks.add(source.id);
        try {
          if (source.status === 'running') await cancel(source);
          const resumePath = source.path;
          return await execute({ action: 'run', workflowPath: resumePath, concurrency: args.concurrency ?? source.concurrency ?? 1, model: args.model ?? source.model, provider: args.provider ?? source.provider }, exec, source);
        } finally { locks.delete(source.id); }
      }
      if (args.action !== 'run') throw new Error('Unknown action');
      const concurrency = args.concurrency ?? 1;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Concurrency must be 1–8');
      if (typeof args.workflowPath !== 'string' || !args.workflowPath.trim()) throw new Error('workflowPath is required');
      const engine = scoped(owner, 'workflowEngine');
      const fs = scoped(owner, 'fs');
      const cwd = await scoped(owner, 'workingDirectory').ensure(owner, exec.signal);
      const target = resumeSource && !revision ? { targetKey: resumeSource.key, displayPath: resumeSource.path } : await fs.resolve(args.workflowPath, { cwd, signal: exec.signal });
      let loadedWorkflow = resumeSource && !revision ? validateWorkflow(resumeSource.workflow) : undefined;
      if (!loadedWorkflow) {
        const sourceBytes = typeof fs.readBytes === 'function' ? await fs.readBytes(target, exec.signal, 1024 * 1024 + 1) : new TextEncoder().encode(await fs.readText(target, exec.signal));
        if (sourceBytes.byteLength > 1024 * 1024) throw new Error('Workflow exceeds 1 MiB');
        loadedWorkflow = validateWorkflow(JSON.parse(new TextDecoder().decode(sourceBytes)));
      }
      const inputDigests = [];
      let inputBytes = 0;
      for (const path of loadedWorkflow.inputFiles ?? []) {
        try {
          const inputTarget = await fs.resolve(path, { cwd, signal: exec.signal });
          if (typeof fs.readBytes !== 'function') throw new Error('inputFiles requires bounded parent fs.readBytes support');
          const bytes = await fs.readBytes(inputTarget, exec.signal, 1024 * 1024);
          inputBytes += bytes.byteLength;
          if (bytes.byteLength > 1024 * 1024 || inputBytes > 4 * 1024 * 1024) throw new Error('inputFiles exceeds 1 MiB per file or 4 MiB total');
          inputDigests.push({ path, targetKey: inputTarget.targetKey, sha256: createHash('sha256').update(bytes).digest('hex') });
        } catch (error) { throw new Error(`Cannot refresh inputFiles ${path}: ${String(error?.message ?? error)}`); }
      }
      if (loadedWorkflow.nodes.length > 100) throw new Error('Workflow exceeds 100 nodes');
      for (const node of loadedWorkflow.nodes) {
        if (node.agentStep?.kind !== 'collect') nodeRequest(node, {}, { model: args.model, provider: args.provider });
      }
      if (closed || exec.signal?.aborted) throw new Error('Run cancelled before start');
      const matching = [...records.values()].filter(record => ownerMatches(record, owner) && record.key === target.targetKey);
      if (matching.some(record => record.status === 'running')) throw new Error('Workflow is already running');
      const prior = resumeSource ?? matching.sort((a, b) => a.createdAt - b.createdAt).at(-1);
      if (prior?.archivedAt) throw new Error(`Selected prior run ${prior.id} is archived; restore it with /workflow restore ${prior.id} before running this path, including with a new workflow ID`);
      const createdAt = Math.max(Date.now(), (prior?.createdAt ?? 0) + 1);
      const record = { id: randomUUID(), owner, ownerId: owner.id, key: target.targetKey, path: target.displayPath, createdAt, workflow: loadedWorkflow, inputDigests, title: typeof loadedWorkflow.title === 'string' ? loadedWorkflow.title : loadedWorkflow.id, resumedFrom: resumeSource?.id, revisionReason: typeof args.revisionReason === 'string' ? args.revisionReason.slice(0, LIMIT) : undefined, model: args.model, provider: args.provider, concurrency, status: 'running', nodeSessions: structuredClone(prior?.workflow?.id === loadedWorkflow.id ? prior.nodeSessions ?? {} : {}), handles: new Set(), controller: new AbortController() };
      const claims = [...new Set([
        `target:${owner.id}:${target.targetKey}`,
        ...loadedWorkflow.nodes.filter(node => node.agentId).map(node => `capsule:${owner.id}:${loadedWorkflow.id}:${node.agentId}`),
        ...Object.values(record.nodeSessions).map(checkpoint => `child:${checkpoint.childId}`),
      ])];
      if (claims.some(key => capsuleClaims.has(key))) throw new Error('Capsule activation is locked by another run; wait for child drain');
      for (const key of claims) capsuleClaims.add(key);
      // Reserve synchronously before any persistence await; aliases share targetKey.
      records.set(record.id, record);
      const abort = () => { record.controller.abort(); for (const handle of record.handles) handle.cancel('Parent call cancelled'); };
      exec.signal?.addEventListener('abort', abort, { once: true });
      record.done = (async () => {
        let finalStatus;
        try {
          await saveRecord(record);
          record.controller.signal.throwIfAborted();
          const previousDefinitions = new Map((prior?.workflow?.nodes || []).map(node => [node.id, node]));
          if (prior?.workflow?.id === loadedWorkflow.id) {
            const changedInputs = JSON.stringify(prior.inputDigests ?? []) !== JSON.stringify(inputDigests);
            for (const old of prior.workflow.nodes) {
              const next = loadedWorkflow.nodes.find(node => node.id === old.id);
              if ((old.agentId || next?.agentId || record.nodeSessions[old.id]) && prior.snapshot?.nodes?.[old.id]?.fingerprint && (changedInputs || JSON.stringify(old) !== JSON.stringify(next))) {
                record.snapshot = structuredClone(prior.snapshot);
                record.snapshot.status = 'needs_review';
                record.snapshot.nodes[old.id] = { ...record.snapshot.nodes[old.id], status: 'needs_review', error: 'Executed capsule definition or external input changed; preserve original child and reconcile effects. Use a new workflow id only after review.' };
                throw reviewError(`Capsule ${old.id} definition/input fingerprint changed; original child retained; needs_review`);
              }
            }
          }
      const subagents = owner.ctx.get('subagents'), agents = owner.ctx.get('agents');
          const nativeContinuation = typeof ctx.on === 'function' && subagents && agents;
          const available = new Set();
          const resumeNodeIds = [];
          const sameDefinition = prior?.workflow !== undefined && JSON.stringify(validateWorkflow(prior.workflow)) === JSON.stringify(loadedWorkflow);
          if (prior && nativeContinuation) {
            const children = await subagents.listChildren(owner.id, record.controller.signal);
            for (const child of children) if (child.mode === 'continuable') available.add(child.id);
            for (const node of loadedWorkflow.nodes) {
              const old = prior.snapshot?.nodes?.[node.id];
              // The native catalog is durable before accepted input can run. Recover
              // this association even if a process died before its progress event.
              if (!record.nodeSessions[node.id] && old?.fingerprint) {
                const label = `${memberLabel(prior.id, node.id)} child 1`;
                const child = children.find(child => child.mode === 'continuable' && child.label === label);
                if (child) record.nodeSessions[node.id] = { childId: child.id, fingerprint: old.fingerprint, continuations: 0 };
              }
              const checkpoint = record.nodeSessions[node.id];
              if (sameDefinition && checkpoint && old?.status !== 'completed' && !available.has(checkpoint.childId)) throw new Error(`Saved Agent for node ${node.id} is unavailable or not a continuable child`);
              if (sameDefinition && checkpoint?.fingerprint === old?.fingerprint && available.has(checkpoint?.childId)) resumeNodeIds.push(node.id);
            }
          }
          if (resumeSource) {
            const missing = loadedWorkflow.nodes.filter(node => node.reviewStep?.kind !== 'gate' && node.agentStep?.kind !== 'collect'
              && ['running', 'interrupted', 'needs_review', 'failed'].includes(prior.snapshot?.nodes?.[node.id]?.status)
              && !record.nodeSessions[node.id]);
            if (missing.length) record.contextWarning = `Historical Agent identity unavailable for nodes: ${missing.map(node => node.id).join(', ')}. Normal retry/review rules apply.`;
          }
          await saveRecord(record);
          record.snapshot = await runWorkflow({ workflow: loadedWorkflow, inputDigests, resumeNodeIds, storage: {
            load: async () => prior?.snapshot === undefined ? undefined : structuredClone(prior.snapshot),
            save: async snapshot => {
              record.snapshot = structuredClone(snapshot);
              await saveRecord(record);
            },
          }, concurrency, signal: record.controller.signal, executorVersion: 'dynamic-workflow-agent-1',
            executor: async (node, { dependencies, signal, fingerprint, operationId }) => {
              const effectiveSignal = signal ?? record.controller.signal;
              effectiveSignal.throwIfAborted();
              const request = nodeRequest(node, dependencies, record);
              request.prompt += `\n\nStable operation ID: ${operationId}. Before any external action, reconcile this ID against actual external state and durable receipts. Record observed receipt identifiers in your result; do not invent verification. On continuation, inspect previous history and pending effects before repeating anything. Continuation does not guarantee exactly-once effects.`;
              if (inputDigests.length) request.prompt += `\nExplicit external inputs (read current files through permitted tools if needed): ${JSON.stringify(inputDigests)}`;
              const role = { ...(node.rolePrompt === undefined ? {} : { prompt: node.rolePrompt }), ...(node.tools === undefined ? {} : { tools: node.tools }) };
              let checkpoint = record.nodeSessions[node.id];
              if (checkpoint && checkpoint.fingerprint !== fingerprint) throw reviewError(`Saved Agent history fingerprint differs for node ${node.id}; original child retained; review before execution`);
              if (node.agentId) {
                if (!nativeContinuation) throw new Error('Persistent capsule Agents require native continuation services');
                if (checkpoint && checkpoint.fingerprint !== fingerprint) throw reviewError(`Saved capsule Agent history differs for stage ${node.id}; review the changed stage before re-execution`);
                const shared = Object.entries(record.nodeSessions).filter(([id]) => (loadedWorkflow.nodes.find(item => item.id === id) || previousDefinitions.get(id))?.agentId === node.agentId).map(([, session]) => session);
                if (new Set(shared.map(session => session.childId)).size > 1) throw new Error(`Capsule ${node.agentId} has conflicting saved Agent identities`);
                if (!checkpoint && shared.length) {
                  checkpoint = { childId: shared[0].childId, fingerprint, operationId, continuations: 0 };
                  record.nodeSessions[node.id] = checkpoint;
                  await saveRecord(record);
                }
              }
              const continuing = checkpoint?.fingerprint === fingerprint;
              let handle, label;
              if (continuing) {
                if (!nativeContinuation || !available.has(checkpoint.childId)) throw new Error(`Saved Agent for node ${node.id} is unavailable or not a continuable child`);
                handle = continueNodeSession({ ctx, owner, childId: checkpoint.childId, prompt: request.prompt, selection: request.options, schema: node.schema, role, signal: effectiveSignal, subagents, agents });
              } else if (node.agentId || node.rolePrompt !== undefined || node.tools !== undefined) {
                if (!nativeContinuation || typeof subagents.startActivation !== 'function' || !subagents.getProvider('spawn')?.prepareContinuable) throw new Error('Native spawn provider is unavailable for capsule roles');
                const childId = randomUUID();
                label = memberLabel(record.id, node.id);
                checkpoint = { childId, fingerprint, operationId, continuations: 0 };
                record.nodeSessions[node.id] = checkpoint;
                await saveRecord(record);
                let activation;
                const admission = {
                  async sendMessage(_sender, _target, content, options) {
                    activation = await subagents.startActivation({ provider: 'spawn', childId, label, delivery: 'caller', signal: options.signal,
                      request: { parent: owner, prompt: content, agentOptions: Object.fromEntries(['provider', 'model'].filter(key => request.options[key] !== undefined).map(key => [key, request.options[key]])) } });
                    available.add(childId);
                    return activation.messageId;
                  },
                  interrupt: (...args) => subagents.interrupt(...args),
                  drainChildren: (...args) => subagents.drainChildren(...args),
                };
                const session = continueNodeSession({ ctx, owner, childId, prompt: request.prompt, selection: request.options, schema: node.schema, role, signal: effectiveSignal, subagents: admission, agents });
                handle = { result: session.result, cancel: reason => session.cancel(reason), async dispose() { try { await session.dispose(); } finally { await activation?.dispose(); } } };
              } else {
                if (resumeNodeIds.includes(node.id)) throw new Error(`Agent context fingerprint changed for node ${node.id}; review is required before a fresh execution`);
                label = memberLabel(record.id, node.id);
                request.options.label = label;
                const member = { record, nodeId: node.id, fingerprint, operationId };
                activeMembers.set(label, member);
                try {
                  handle = engine.start({ parent: owner, signal: effectiveSignal, script: SCRIPT, args: request, maxTotalAgents: 1, meta: { name: label, description: `Execute node ${node.id}` } });
                  member.engineId = handle.id;
                } catch (error) { activeMembers.delete(label); throw error; }
              }
              let disposal;
              const held = { cancel: reason => handle.cancel(reason), dispose: () => disposal ??= handle.dispose() };
              record.handles.add(held);
              try {
                const result = await handle.result;
                effectiveSignal.throwIfAborted();
                if (result.stopReason !== 'completed' || result.value == null) throw new Error(result.error || `Node ${node.id} did not return a successful result`);
                if (continuing) { checkpoint.continuations = (checkpoint.continuations ?? 0) + 1; await saveRecord(record); }
                return result.value;
              } finally {
                try { await held.dispose(); } catch (error) { throw reviewError(`Child cleanup failed; reconcile before retry: ${String(error)}`); }
                record.handles.delete(held); if (label) activeMembers.delete(label);
              }
            },
          });
          finalStatus = record.controller.signal.aborted ? 'cancelled' : record.snapshot.status;
        } catch (error) {
          finalStatus = record.controller.signal.aborted ? 'cancelled' : error?.needsReview ? 'needs_review' : 'failed';
          record.error = error instanceof Error ? error.message : String(error);
        } finally {
          // Core and host retain admission until executor and child cleanup drain.
          const cleanup = await Promise.allSettled([...record.handles].map(handle => handle.dispose()));
          const failure = cleanup.find(result => result.status === 'rejected');
          if (failure) { finalStatus = 'needs_review'; record.error = `Child cleanup failed: ${String(failure.reason)}. Admission remains quarantined until host teardown is verified.`; }
          if (!failure) for (const key of claims) capsuleClaims.delete(key);
          record.status = finalStatus;
          exec.signal?.removeEventListener('abort', abort);
          try { await saveRecord(record); }
          catch (error) { record.status = 'failed'; record.error = `State persistence failed: ${String(error)}`; }
        }
      })();
      return brief(record);
  }
}
