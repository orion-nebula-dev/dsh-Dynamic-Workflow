import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { validateWorkflow, runWorkflow } from './core.mjs';
import { continueNodeSession } from './continuation.mjs';

const memberLabel = (runId, nodeId) => `dw-${runId}-${createHash('sha256').update(nodeId).digest('hex').slice(0, 12)}`;

export const inject = ['tools', 'storageDomain', 'commands'];
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
    createdAt: record.createdAt, concurrency: record.concurrency ?? 1,
    resumeSupported: record.workflow !== undefined };
  for (const key of ['resumedFrom', 'model', 'provider', 'contextWarning']) if (record[key] !== undefined) result[key] = record[key];
  if (record.error) result.error = record.error.slice(0, LIMIT);
  if (snapshot) {
    const definitions = new Map((Array.isArray(record.workflow?.nodes) ? record.workflow.nodes : []).map(node => [node.id, node]));
    result.nodes = Object.fromEntries(Object.entries(snapshot.nodes || {}).map(([id, node]) => {
      const definition = definitions.get(id), session = record.nodeSessions?.[id];
      return [id, { status: node.status, reused: node.reused === true,
        ...(typeof definition?.title === 'string' ? { title: definition.title } : {}),
        ...(typeof definition?.agentTitle === 'string' ? { agentTitle: definition.agentTitle } : {}),
        ...(typeof definition?.agentId === 'string' ? { agentId: definition.agentId } : {}),
        ...(typeof definition?.roleTitle === 'string' ? { roleTitle: definition.roleTitle } : {}),
        ...(typeof definition?.role === 'string' ? { role: definition.role } : {}),
        ...(Array.isArray(definition?.deps) ? { deps: definition.deps } : {}),
        ...(session ? { agentSessionId: session.childId, continuations: session.continuations ?? 0 } : {}) }];
    }));
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
export async function apply(ctx) {
  const runStatus = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'needs_review']);
  const snapshotSchema = z.object({
    version: z.literal(1), workflowId: z.string(), runId: z.string(),
    status: runStatus,
    nodes: z.record(z.string(), z.object({
      status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted', 'blocked', 'needs_review']),
      fingerprint: z.string().optional(), reused: z.boolean().optional(), output: z.json().optional(),
      outputHash: z.string().optional(), error: z.string().optional(),
    }).strict()),
  }).strict();
  const recordSchema = z.object({
    id: z.string(), ownerId: z.string(), key: z.string(), path: z.string(), status: runStatus,
    createdAt: z.number().int().nonnegative(), snapshot: snapshotSchema.optional(), error: z.string().optional(),
    workflow: z.json().optional(), title: z.string().optional(), resumedFrom: z.string().optional(),
    model: z.string().optional(), provider: z.string().optional(), concurrency: z.number().int().min(1).max(8).optional(),
    nodeSessions: z.record(z.string(), z.object({ childId: z.string(), fingerprint: z.string(), continuations: z.number().int().nonnegative().optional() }).strict()).optional(),
    contextWarning: z.string().optional(),
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
      model: record.model, provider: record.provider, concurrency: record.concurrency,
      nodeSessions: record.nodeSessions, contextWarning: record.contextWarning });
    record.pendingSave = (record.pendingSave ?? Promise.resolve()).then(() => runsTable.put(record.id, value));
    return record.pendingSave;
  }
  const activeMembers = new Map();
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on('workflow/agent-start', (info, child) => {
    const member = activeMembers.get(child.label);
    if (!member || (member.engineId !== undefined && member.engineId !== info.id)) return;
    member.record.nodeSessions[member.nodeId] = { childId: child.childId, fingerprint: member.fingerprint, continuations: 0 };
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
    description: 'Run a JSON DAG, resume a saved run with a selected model, inspect progress or one node result, list runs or available models, or stop execution. State survives plugin restart. Run reads the current JSON; resume uses the saved definition and snapshot, stopping active execution first. Unchanged completed nodes are reused across model switches. Unfinished nodes resume their original persisted Agent session and history when its identity and fingerprint are verified; a missing saved Agent is an error. Legacy interruptions require review unless retrySafe is true. JSON nodes use id, prompt (or string input), deps, optional provider/model/schema/retrySafe. For persistent capsules, define agents:{id:{title}}, roles:{id:{prompt,title?,tools?}}, and node agentId/role. The same agentId reuses one Agent across serial stages, applying each role before activation. tools:[] denies tools; omitted tools inherit. Changed executed shared stages require a new workflow id; appended stages keep the Agent.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['run', 'resume', 'status', 'stop', 'list', 'models'] },
        model: { type: 'string', description: 'For run/resume: executor model override; completed nodes retain their fingerprints. Resume defaults to the saved selection.' },
        provider: { type: 'string', description: 'For run/resume: executor provider override; resume defaults to the saved selection.' },
        workflowPath: { type: 'string', description: 'For run: JSON file readable under the current session filesystem policy; relative paths resolve against its working directory.' },
        runId: { type: 'string', description: 'For resume, status or stop: identifier returned by run.' },
        nodeId: { type: 'string', description: 'For status: include this node result, truncated at 12000 characters.' },
        concurrency: { type: 'integer', minimum: 1, maximum: 8, description: 'For run/resume: simultaneous nodes, 1–8; run defaults to 1, resume to the saved value.' },
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
    '/workflow stop <runId> — 停止运行',
    '/workflow models — 查看可用模型',
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
          else if (['status', 'resume', 'stop'].includes(action) && argument) args = { action, runId: argument };
          else if (['list', 'models'].includes(action) && !argument) args = { action };
          else throw new Error('命令参数不正确。输入 /workflow 查看用法。');
        }
        return { kind: 'success', text: JSON.stringify(await execute(args, invocation)) };
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : String(error) }; }
    },
  }));
  const locks = new Set();
  async function execute(args, exec, resumeSource) {
      if (closed) throw new Error('Plugin is unloading');
      const owner = exec.agent;
      if (!owner?.ctx || !owner.id) throw new Error('A parent agent is required');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
      for (const key of Object.keys(args)) if (!['action', 'workflowPath', 'runId', 'nodeId', 'concurrency', 'model', 'provider'].includes(key)) throw new Error(`Unknown parameter: ${key}`);
      for (const key of ['model', 'provider']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`Invalid ${key}`);
      if (args.action === 'models') {
        const llm = scoped(owner, 'llm');
        return { providers: await Promise.all(llm.listProviders().map(async provider => {
          try { return { ...provider, models: await llm.listModels(provider.id) }; }
          catch (error) { return { ...provider, models: [], error: String(error?.message ?? error) }; }
        })) };
      }
      if (args.action === 'restart') throw new Error('Safe restart recovery is unsupported; run again only after reviewing possible side effects');
      if (args.action === 'list') return { runs: [...records.values()].filter(record => ownerMatches(record, owner)).map(record => brief(record)) };
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
      if (args.action === 'resume') {
        const source = records.get(args.runId);
        if (!source || !ownerMatches(source, owner)) throw new Error('Run not found for this owner');
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
      const target = resumeSource ? { targetKey: resumeSource.key, displayPath: resumeSource.path } : await fs.resolve(args.workflowPath, { cwd, signal: exec.signal });
      let loadedWorkflow = resumeSource ? validateWorkflow(resumeSource.workflow) : undefined;
      if (!loadedWorkflow) {
        const sourceBytes = typeof fs.readBytes === 'function' ? await fs.readBytes(target, exec.signal, 1024 * 1024 + 1) : new TextEncoder().encode(await fs.readText(target, exec.signal));
        if (sourceBytes.byteLength > 1024 * 1024) throw new Error('Workflow exceeds 1 MiB');
        loadedWorkflow = validateWorkflow(JSON.parse(new TextDecoder().decode(sourceBytes)));
      }
      if (loadedWorkflow.nodes.length > 100) throw new Error('Workflow exceeds 100 nodes');
      for (const node of loadedWorkflow.nodes) nodeRequest(node, {}, { model: args.model, provider: args.provider });
      if (closed || exec.signal?.aborted) throw new Error('Run cancelled before start');
      const matching = [...records.values()].filter(record => ownerMatches(record, owner) && record.key === target.targetKey);
      if (matching.some(record => record.status === 'running')) throw new Error('Workflow is already running');
      const prior = resumeSource ?? matching.sort((a, b) => a.createdAt - b.createdAt).at(-1);
      const createdAt = Math.max(Date.now(), (prior?.createdAt ?? 0) + 1);
      const record = { id: randomUUID(), owner, ownerId: owner.id, key: target.targetKey, path: target.displayPath, createdAt, workflow: loadedWorkflow, title: typeof loadedWorkflow.title === 'string' ? loadedWorkflow.title : loadedWorkflow.id, resumedFrom: resumeSource?.id, model: args.model, provider: args.provider, concurrency, status: 'running', nodeSessions: structuredClone(prior?.workflow?.id === loadedWorkflow.id ? prior.nodeSessions ?? {} : {}), handles: new Set(), controller: new AbortController() };
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
      for (const node of loadedWorkflow.nodes) {
        if (node.agentId && (prior?.workflow?.id !== loadedWorkflow.id || previousDefinitions.get(node.id)?.agentId !== node.agentId)) delete record.nodeSessions[node.id];
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
            const missing = loadedWorkflow.nodes.filter(node => prior.snapshot?.nodes?.[node.id]?.status !== 'completed' && !record.nodeSessions[node.id]);
            if (missing.length) record.contextWarning = `Historical Agent identity unavailable for nodes: ${missing.map(node => node.id).join(', ')}. Normal retry/review rules apply.`;
          }
          await saveRecord(record);
          record.snapshot = await runWorkflow({ workflow: loadedWorkflow, resumeNodeIds, storage: {
            load: async () => prior?.snapshot === undefined ? undefined : structuredClone(prior.snapshot),
            save: async snapshot => {
              record.snapshot = structuredClone(snapshot);
              await saveRecord(record);
            },
          }, concurrency, signal: record.controller.signal, executorVersion: 'dynamic-workflow-agent-1',
            executor: async (node, { dependencies, signal, fingerprint }) => {
              const effectiveSignal = signal ?? record.controller.signal;
              effectiveSignal.throwIfAborted();
              const request = nodeRequest(node, dependencies, record);
              const role = { ...(node.rolePrompt === undefined ? {} : { prompt: node.rolePrompt }), ...(node.tools === undefined ? {} : { tools: node.tools }) };
              let checkpoint = record.nodeSessions[node.id];
              if (node.agentId) {
                if (!nativeContinuation) throw new Error('Persistent capsule Agents require native continuation services');
                if (checkpoint && checkpoint.fingerprint !== fingerprint) throw new Error(`Saved capsule Agent history differs for stage ${node.id}; review the changed stage before re-execution`);
                const shared = Object.entries(record.nodeSessions).filter(([id]) => (loadedWorkflow.nodes.find(item => item.id === id) || previousDefinitions.get(id))?.agentId === node.agentId).map(([, session]) => session);
                if (new Set(shared.map(session => session.childId)).size > 1) throw new Error(`Capsule ${node.agentId} has conflicting saved Agent identities`);
                if (!checkpoint && shared.length) {
                  checkpoint = { childId: shared[0].childId, fingerprint, continuations: 0 };
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
                checkpoint = { childId, fingerprint, continuations: 0 };
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
                const member = { record, nodeId: node.id, fingerprint };
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
              } finally { await held.dispose(); record.handles.delete(held); if (label) activeMembers.delete(label); }
            },
          });
          finalStatus = record.controller.signal.aborted ? 'cancelled' : record.snapshot.status;
        } catch (error) {
          finalStatus = record.controller.signal.aborted ? 'cancelled' : 'failed';
          record.error = error instanceof Error ? error.message : String(error);
        } finally {
          // Core abort settles early; the Host still owns child cleanup.
          const cleanup = await Promise.allSettled([...record.handles].map(handle => handle.dispose()));
          const failure = cleanup.find(result => result.status === 'rejected');
          if (failure) { finalStatus = 'failed'; record.error = `Child cleanup failed: ${String(failure.reason)}`; }
          record.status = finalStatus;
          exec.signal?.removeEventListener('abort', abort);
          try { await saveRecord(record); }
          catch (error) { record.status = 'failed'; record.error = `State persistence failed: ${String(error)}`; }
        }
      })();
      return brief(record);
  }
}
