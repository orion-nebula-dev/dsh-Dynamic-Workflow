import { readFile, writeFile, rename, mkdir, open, unlink, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function copy(value) {
  const ancestors = new Set();
  function check(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new TypeError('Expected finite, acyclic JSON data');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('Expected plain JSON objects');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) check(item[i]);
    } else {
      for (const value of Object.values(item)) check(value);
    }
    ancestors.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value));
}

async function persist(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2));
  await rename(temporary, path);
}

const nonempty = value => typeof value === 'string' && !!value.trim();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const REVIEW_SCHEMA = { type: 'object', description: 'approved requires empty findings; changes-required requires non-empty findings; evidence must be verifiable.', properties: { verdict: { enum: ['approved', 'changes-required'] }, findings: { type: 'array', items: { type: 'object', properties: { message: { type: 'string' }, evidence: { type: 'string' } }, required: ['message', 'evidence'] } } }, required: ['verdict', 'findings'] };
function validateTools(tools, label) {
  if (!Array.isArray(tools) || tools.some(tool => !nonempty(tool)) || new Set(tools).size !== tools.length) {
    throw new TypeError(`Invalid tools for ${label}: expected unique nonempty names`);
  }
}

/** Validate and detach a JSON DAG, resolving roles and explicit Agent identities.
 * Same-Agent nodes gain predecessor dependencies in stable topological order
 * (original array position breaks ready-node ties); the node array stays intact.
 */
export function validateWorkflow(definition) {
  const workflow = copy(definition);
  if (!workflow || typeof workflow.id !== 'string' || !workflow.id.trim() || !Array.isArray(workflow.nodes)) {
    throw new TypeError('Workflow requires a nonempty id and nodes array');
  }
  for (const name of ['agents', 'roles']) {
    if (!Object.hasOwn(workflow, name)) continue;
    if (!object(workflow[name])) throw new TypeError(`${name} must be an object`);
    for (const [id, entry] of Object.entries(workflow[name])) {
      if (!nonempty(id) || !object(entry)) throw new TypeError(`Invalid ${name} entry: ${id}`);
      if (Object.hasOwn(entry, 'title') && typeof entry.title !== 'string') throw new TypeError(`Invalid title for ${name}.${id}`);
      if (name === 'roles') {
        if (!nonempty(entry.prompt)) throw new TypeError(`Role ${id} requires a nonempty prompt`);
        if (Object.hasOwn(entry, 'tools')) validateTools(entry.tools, `role ${id}`);
      }
    }
  }
  if (Object.hasOwn(workflow, 'approval') || Object.hasOwn(workflow, 'humanApproval')) throw new TypeError('Human approval is unsupported: no verified human-source authority');
  if (workflow.inputFiles !== undefined && (!Array.isArray(workflow.inputFiles) || workflow.inputFiles.length > 16 || workflow.inputFiles.some(path => !nonempty(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) || new Set(workflow.inputFiles).size !== workflow.inputFiles.length)) throw new TypeError('inputFiles requires at most 16 unique local file paths; URLs are unsupported');
  const nodes = new Map();
  const sourceNodes = workflow.nodes;
  for (const node of sourceNodes) {
    if (node && Object.hasOwn(node, 'deps') && (!Array.isArray(node.deps) || node.deps.some(id => typeof id !== 'string') || new Set(node.deps).size !== node.deps.length)) {
      throw new TypeError(`Invalid dependencies for ${node.id}`);
    }
  }
  const loopIds = new Set(sourceNodes.filter(node => node && object(node) && Object.hasOwn(node, 'reviewLoop')).map(node => node.id));
  const expanded = [];
  for (const source of sourceNodes) {
    if (!source || !object(source) || !Object.hasOwn(source, 'reviewLoop')) { expanded.push(source); continue; }
    if (Object.hasOwn(source, 'agents')) throw new TypeError(`agents and reviewLoop are mutually exclusive for ${source.id}`);
    const loop = source.reviewLoop;
    if (!object(loop)) throw new TypeError(`Invalid reviewLoop for ${source.id}`);
    const maxRounds = loop.maxRounds === undefined ? 3 : loop.maxRounds;
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) throw new TypeError(`Invalid maxRounds for ${source.id}`);
    for (const kind of ['review', 'fix']) {
      const template = loop[kind];
      if (!object(template) || !nonempty(template.agentId) || !nonempty(template.prompt) || (Object.hasOwn(template, 'role') && !nonempty(template.role))) throw new TypeError(`Invalid ${kind} template for ${source.id}`);
      const forbidden = ['id', 'deps', 'reviewLoop', 'reviewStep', 'agents', 'agentStep', 'agentConcurrency', ...(kind === 'review' ? ['schema'] : [])];
      for (const field of forbidden) if (Object.hasOwn(template, field)) throw new TypeError(`Invalid ${kind} template field: ${field}`);
    }
    if (loop.review.agentId === loop.fix.agentId) throw new TypeError(`review and fix agents must be different for ${source.id}`);
    const reviewIds = [];
    let previousReview;
    for (let round = 1; round <= maxRounds; round++) {
      const reviewId = `${source.id}/review/${round}`;
      const fixId = `${source.id}/fix/${round}`;
      if (loopIds.has(reviewId) || loopIds.has(fixId) || sourceNodes.some(node => node?.id === reviewId || node?.id === fixId)) throw new TypeError(`Generated node ID collision: ${reviewId}`);
      const review = { ...loop.review, id: reviewId, deps: round === 1 ? [...(source.deps ?? [])] : [`${source.id}/fix/${round - 1}`, previousReview], schema: copy(REVIEW_SCHEMA), reviewStep: { loopId: source.id, kind: 'review', round, maxRounds, ...(previousReview ? { previousReview } : {}) } };
      expanded.push(review);
      reviewIds.push(reviewId); previousReview = reviewId;
      if (round < maxRounds) {
        const fix = { ...loop.fix, id: fixId, deps: [...new Set([...(source.deps ?? []), reviewId])], reviewStep: { loopId: source.id, kind: 'fix', round, maxRounds, previousReview: reviewId } };
        expanded.push(fix);
      }
    }
    const gate = { ...source, deps: [reviewIds.at(-1)], reviewLoop: undefined, reviewStep: { loopId: source.id, kind: 'gate', round: maxRounds, maxRounds, reviewNodeId: reviewIds.at(-1) }, retrySafe: true, prompt: `Review gate for ${source.id}` };
    delete gate.reviewLoop; delete gate.agentId; delete gate.agentTitle; delete gate.role; delete gate.rolePrompt; delete gate.roleTitle; delete gate.tools;
    expanded.push(gate);
  }
  // Expand agent groups into independent member nodes plus a pure collect gate.
  // Keeping this in the validated DAG makes checkpoints, fingerprints and resume IDs stable.
  const staticExpanded = [];
  const generatedIds = new Set();
  for (const source of expanded) {
    if (!source || !object(source) || !Object.hasOwn(source, 'agents')) {
      staticExpanded.push(source);
      continue;
    }
    if (Object.hasOwn(source, 'agentId') || Object.hasOwn(source, 'role') || Object.hasOwn(source, 'reviewLoop') || !Array.isArray(source.agents) || source.agents.length < 1) {
      throw new TypeError(`Invalid agent group for ${source.id}`);
    }
    if (Object.hasOwn(source, 'tools')) validateTools(source.tools, source.id);
    const limit = source.agentConcurrency === undefined ? Math.min(8, source.agents.length) : source.agentConcurrency;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new TypeError(`Invalid agentConcurrency for ${source.id}`);
    const memberIds = new Set();
    const memberAgents = new Set();
    const memberNodes = [];
    for (const agent of source.agents) {
      if (!object(agent) || !nonempty(agent.id) || memberIds.has(agent.id) || !nonempty(agent.agentId) || !nonempty(agent.prompt) || ['deps', 'agents', 'reviewLoop', 'agentStep', 'reviewStep', 'agentConcurrency'].some(field => Object.hasOwn(agent, field))) {
        throw new TypeError(`Invalid node agent for ${source.id}`);
      }
      if (memberAgents.has(agent.agentId)) throw new TypeError(`Duplicate agentId in group ${source.id}: ${agent.agentId}`);
      memberIds.add(agent.id);
      memberAgents.add(agent.agentId);
      if (Object.hasOwn(source, 'schema') && Object.hasOwn(agent, 'schema') && canonical(source.schema) !== canonical(agent.schema)) {
        throw new TypeError(`Conflicting schema for ${source.id}/${agent.id}`);
      }
      const memberId = `${source.id}/agent/${agent.id}`;
      if (generatedIds.has(memberId) || expanded.some(node => node?.id === memberId)) throw new TypeError(`Generated node ID collision: ${memberId}`);
      generatedIds.add(memberId);
      const member = { ...source, ...agent, id: memberId, deps: [...(source.deps ?? [])], agentStep: { groupId: source.id, memberId: agent.id, kind: 'member' } };
      delete member.agents;
      delete member.agentConcurrency;
      memberNodes.push(member);
      staticExpanded.push(member);
    }
    const gate = { ...source, id: source.id, deps: memberNodes.map(node => node.id), agentStep: { groupId: source.id, kind: 'collect', members: [...memberIds] }, retrySafe: true };
    delete gate.agents;
    gate.agentConcurrency = limit;
    delete gate.condition; // Conditions apply to members; collection remains a pure gate.
    delete gate.agentId;
    delete gate.agentTitle;
    delete gate.role;
    delete gate.rolePrompt;
    delete gate.roleTitle;
    delete gate.tools;
    delete gate.prompt;
    staticExpanded.push(gate);
  }
  workflow.nodes = staticExpanded;
  for (const node of workflow.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim() || nodes.has(node.id)) {
      throw new TypeError('Node IDs must be nonempty and unique');
    }
    if (Object.hasOwn(node, 'approval') || Object.hasOwn(node, 'humanApproval')) throw new TypeError(`Human approval is unsupported for ${node.id}: no verified human-source authority`);
    if (node.retrySafe !== undefined && typeof node.retrySafe !== 'boolean') throw new TypeError(`retrySafe must be boolean for ${node.id}`);
    if (node.timeoutMs !== undefined && (!Number.isSafeInteger(node.timeoutMs) || node.timeoutMs < 1 || node.timeoutMs > 3600000)) throw new TypeError(`timeoutMs must be 1–3600000 for ${node.id}`);
    if (node.maxRetries !== undefined && (!Number.isSafeInteger(node.maxRetries) || node.maxRetries < 0 || node.maxRetries > 3 || (node.maxRetries > 0 && node.retrySafe !== true))) throw new TypeError(`maxRetries must be 0–3 and requires retrySafe:true for ${node.id}`);
    if (node.writeResources !== undefined && (!Array.isArray(node.writeResources) || node.writeResources.some(resource => !nonempty(resource) || !/^(\*|[a-zA-Z0-9_.:/-]+)$/.test(resource)) || new Set(node.writeResources).size !== node.writeResources.length)) throw new TypeError(`writeResources must be unique resource names (or *) for ${node.id}`);
    if (node.condition !== undefined && (!object(node.condition) || Object.keys(node.condition).some(key => !['dependency', 'equals'].includes(key)) || !(node.deps ?? []).includes(node.condition.dependency) || !Object.hasOwn(node.condition, 'equals'))) throw new TypeError(`condition for ${node.id} requires a declared dependency and equals JSON value; expressions are unsupported`);
    if (Object.hasOwn(node, 'tools')) validateTools(node.tools, node.id);
    if (Object.hasOwn(node, 'agentStep')) {
      const step = node.agentStep;
      if (!object(step) || !nonempty(step.groupId) || !['member', 'collect'].includes(step.kind) || Object.hasOwn(node, 'reviewStep')) throw new TypeError(`Invalid agentStep for ${node.id}`);
      if (step.kind === 'member') {
        if (!nonempty(step.memberId) || node.id !== `${step.groupId}/agent/${step.memberId}` || !nonempty(node.agentId)) throw new TypeError(`Invalid agentStep member for ${node.id}`);
      } else if (node.id !== step.groupId || !Array.isArray(step.members) || !step.members.length || step.members.some(id => !nonempty(id)) || new Set(step.members).size !== step.members.length || !Number.isSafeInteger(node.agentConcurrency) || node.agentConcurrency < 1 || node.agentConcurrency > 8 || node.agentId !== undefined || node.retrySafe !== true) {
        throw new TypeError(`Invalid agentStep collect or agentConcurrency for ${node.id}`);
      }
    } else if (Object.hasOwn(node, 'agentConcurrency')) {
      throw new TypeError(`agentConcurrency requires an agent group: ${node.id}`);
    }
    if (Object.hasOwn(node, 'role')) {
      if (!nonempty(node.role) || !workflow.roles || !Object.hasOwn(workflow.roles, node.role)) {
        throw new TypeError(`Unknown role for ${node.id}: ${node.role}`);
      }
      const role = workflow.roles[node.role];
      node.rolePrompt = role.prompt;
      node.roleTitle = role.title || node.role;
      if (node.tools === undefined && role.tools !== undefined) node.tools = [...role.tools];
    }
    if (Object.hasOwn(node, 'agentId')) {
      if (!nonempty(node.agentId)) throw new TypeError(`Invalid agentId for ${node.id}`);
      if (workflow.agents && !Object.hasOwn(workflow.agents, node.agentId)) throw new TypeError(`Unknown agentId for ${node.id}: ${node.agentId}`);
      if (Object.hasOwn(node, 'agentTitle') && typeof node.agentTitle !== 'string') throw new TypeError(`Invalid agentTitle for ${node.id}`);
      node.agentTitle = workflow.agents?.[node.agentId]?.title || node.agentTitle || node.agentId;
    }
    node.deps ??= [];
    if (!Array.isArray(node.deps) || node.deps.some(id => typeof id !== 'string') || new Set(node.deps).size !== node.deps.length) {
      throw new TypeError(`Invalid dependencies for ${node.id}`);
    }
    nodes.set(node.id, node);
  }
  for (const node of nodes.values()) {
    for (const dep of node.deps) if (!nodes.has(dep)) throw new Error(`Missing dependency: ${dep}`);
  }
  // Determine the original DAG's order before adding any shared-history edges.
  const remaining = new Map(nodes), ordered = [];
  while (remaining.size) {
    const next = [...remaining.values()].find(node => node.deps.every(dep => !remaining.has(dep)));
    if (!next) throw new Error(`Dependency cycle: ${remaining.keys().next().value}`);
    ordered.push(next);
    remaining.delete(next.id);
  }
  const preceding = new Map();
  for (const node of logicalGroups(workflow.nodes).flatMap(group => ordered.filter(node => logicalId(node) === group.id))) {
    if (!Object.hasOwn(node, 'agentId')) continue;
    const previous = preceding.get(node.agentId);
    if (previous !== undefined && !node.deps.includes(previous)) node.deps.push(previous);
    preceding.set(node.agentId, node.id);
  }
  return workflow;
}

const logicalId = node => node.agentStep?.groupId ?? node.reviewStep?.loopId ?? node.id;

// Scheduling order is separate from dependency edges: unrelated work must not
// affect prompts, cache fingerprints or failure propagation.
function logicalGroups(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const groups = new Map();
  for (const node of nodes) {
    const id = logicalId(node);
    if (!groups.has(id)) groups.set(id, { id, nodes: [], deps: new Set() });
    groups.get(id).nodes.push(node);
    for (const dep of node.deps) {
      const depGroup = logicalId(byId.get(dep));
      if (depGroup !== id) groups.get(id).deps.add(depGroup);
    }
  }
  const remaining = new Map(groups), ordered = [];
  while (remaining.size) {
    const next = [...remaining.values()].find(group => [...group.deps].every(dep => !remaining.has(dep)));
    if (!next) throw new Error('Dependency cycle between logical nodes');
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
}

function reviewReport(value) {
  let report = value;
  if (typeof report === 'string') {
    try {
      const fenced = report.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
      report = JSON.parse(fenced ? fenced[1] : report.trim());
    }
    catch { throw new Error('Invalid review result: expected JSON object'); }
  }
  if (!object(report) || !['approved', 'changes-required'].includes(report.verdict) || !Array.isArray(report.findings)) throw new Error('Invalid review result: verdict and findings are required');
  if (report.findings.some(item => !object(item) || !nonempty(item.message) || !nonempty(item.evidence))) throw new Error('Invalid review result: findings require message and evidence');
  if (report.verdict === 'approved' && report.findings.length) throw new Error('Invalid review result: approved review must have empty findings');
  if (report.verdict === 'changes-required' && !report.findings.length) throw new Error('Invalid review result: changes-required review needs findings');
  return copy(report);
}

export async function loadWorkflow(path) {
  return validateWorkflow(JSON.parse(await readFile(path, 'utf8')));
}

/** Execute JSON nodes; bump executorVersion whenever executor semantics change.
 * Node errors return a failed state; configuration, locking and disk errors reject.
 * Abort returns an interrupted state and ignores late executor results. Executors
 * remain responsible for stopping external side effects when signal aborts.
 * storage optionally replaces statePath with { load(): Promise<snapshot|undefined>,
 * save(snapshot): Promise<void> }. Saves are awaited and serialized per run.
 * The caller must ensure exclusive use of each storage domain across instances,
 * processes and plugin reloads; injected storage has no built-in locking.
 * Without storage, statePath is required and uses the existing file lock.
 * Historical running/interrupted/needs_review nodes require manual review unless
 * the node declares retrySafe: true, or the caller authorizes same-session
 * continuation through resumeNodeIds after verifying durable Agent history.
 * Executors must reject a continuation fingerprint mismatch, never retry it
 * with a fresh Agent. Their descendants are blocked otherwise. First runs
 * and previously pending nodes do not require this opt-in.
 */
export async function runWorkflow({ workflow: definition, workflowPath, statePath, storage, inputDigests = [], executor, executorVersion = '1', concurrency = 1, resumeNodeIds = [], signal = new AbortController().signal }) {
  const workflow = definition ? validateWorkflow(definition) : await loadWorkflow(workflowPath);
  if (typeof executor !== 'function') throw new TypeError('executor must be a function');
  if (!Array.isArray(resumeNodeIds) || resumeNodeIds.some(id => typeof id !== 'string' || !workflow.nodes.some(node => node.id === id))) throw new TypeError('resumeNodeIds must name existing nodes');
  const resumable = new Set(resumeNodeIds);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  if (storage !== undefined) {
    if (!storage || typeof storage.load !== 'function' || typeof storage.save !== 'function') {
      throw new TypeError('storage requires load and save functions');
    }
    return execute();
  }
  statePath = resolve(statePath);
  await mkdir(dirname(statePath), { recursive: true });
  statePath = resolve(await realpath(dirname(statePath)), statePath.slice(dirname(statePath).length + 1));
  const lockPath = `${statePath}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`State is locked or already running: ${statePath}`);
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    return await execute();
  } finally {
    await lock.close();
    // lockPath is the exact adjacent lock successfully created above.
    await unlink(lockPath);
  }

  async function execute() {
    let previous;
    if (storage !== undefined) {
      const loaded = await storage.load();
      previous = loaded === undefined ? undefined : copy(loaded);
    } else {
      try { previous = JSON.parse(await readFile(statePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (previous?.version !== 1 || previous.workflowId !== workflow.id) previous = undefined;
    const state = { version: 1, workflowId: workflow.id, runId: randomUUID(), status: 'running', nodes: Object.fromEntries(workflow.nodes.map(node => [node.id,
      node.retrySafe !== true && !resumable.has(node.id) && ['running', 'interrupted', 'needs_review', 'failed'].includes(previous?.nodes?.[node.id]?.status)
        ? { ...copy(previous.nodes[node.id]), status: 'needs_review', error: 'Manual review required: previous execution may have produced side effects; declare retrySafe: true only after verifying retry safety.' }
        : { status: 'pending' },
    ])) };
    for (const node of Object.values(state.nodes)) if (node.status === 'needs_review') { delete node.output; delete node.outputHash; node.operationId ??= randomUUID(); }
    let writes = Promise.resolve();
    const save = () => {
      const snapshot = copy(state);
      writes = writes.then(() => storage !== undefined ? storage.save(snapshot) : persist(statePath, snapshot));
      return writes;
    };
    await save();
    const pending = new Map(workflow.nodes.filter(node => state.nodes[node.id].status === 'pending').map(node => [node.id, node]));
    const running = new Map();
    let admissionClosed = false;
    async function runNode(node) {
      const id = node.id;
      const dependencies = Object.fromEntries(node.deps.map(dep => [dep, copy(state.nodes[dep].output)]));
      const fingerprint = hash({ workflowId: workflow.id, executorVersion, ...(inputDigests.length ? { inputDigests } : {}), node: { ...node, deps: [...node.deps].sort() }, dependencies: Object.fromEntries(node.deps.map(dep => [dep, { fingerprint: state.nodes[dep].fingerprint, outputHash: state.nodes[dep].outputHash }])) });
      const old = previous?.nodes?.[id];
      if (old?.status === 'completed' && old.fingerprint === fingerprint && Object.hasOwn(old, 'output') && old.outputHash === hash(old.output)) {
        state.nodes[id] = { ...copy(old), reused: true };
        await save();
        return;
      }
      const operationId = (old?.fingerprint === fingerprint ? old.operationId : undefined) ?? randomUUID();
      state.nodes[id] = { status: 'running', fingerprint, operationId, reused: false };
      await save();
      try {
        const step = node.reviewStep;
        if (node.condition && canonical(dependencies[node.condition.dependency]) !== canonical(node.condition.equals)) {
          state.nodes[id] = { status: 'completed', fingerprint, operationId, reused: false, skipped: true, output: null, outputHash: hash(null) };
        } else if (node.agentStep?.kind === 'collect') {
          const output = Object.fromEntries(node.agentStep.members.map(memberId => [memberId, copy(dependencies[`${id}/agent/${memberId}`])]));
          state.nodes[id] = { status: 'completed', fingerprint, operationId, reused: false, output, outputHash: hash(output) };
        } else if (step?.kind === 'gate') {
          const report = copy(dependencies[step.reviewNodeId]);
          const failed = report?.verdict !== 'approved';
          state.nodes[id] = { status: failed ? 'failed' : 'completed', fingerprint, operationId, reused: false, output: report, outputHash: hash(report), ...(failed ? { error: `Review limit ${step.maxRounds} reached: changes-required` } : {}) };
        } else {
          const previousReport = step && step.kind === 'review' ? dependencies[step.previousReview] : step?.kind === 'fix' ? dependencies[step.previousReview] : undefined;
          if (previousReport?.verdict === 'approved') {
            const output = copy(previousReport);
            state.nodes[id] = { status: 'completed', fingerprint, operationId, reused: false, skipped: true, output, outputHash: hash(output) };
          } else {
            let output;
            for (let attempt = 0; ; attempt++) {
              const timeout = new AbortController();
              const attemptSignal = AbortSignal.any([signal, timeout.signal]);
              const timer = setTimeout(() => timeout.abort(new Error(`Node ${id} timeout after ${node.timeoutMs ?? 600000} ms; reconcile operation ${operationId}`)), node.timeoutMs ?? 600000);
              try {
                output = copy(await abortable(() => executor(copy(node), { dependencies, fingerprint, operationId, attempt, runId: state.runId, signal: attemptSignal }), attemptSignal));
                break;
              } catch (error) {
                if (signal.aborted || node.retrySafe !== true || attempt >= (node.maxRetries ?? 0) || error?.needsReview) throw error;
              } finally { clearTimeout(timer); }
            }
            if (signal.aborted) throw new Error('Interrupted');
            if (step?.kind === 'review') output = reviewReport(output);
            state.nodes[id] = { status: 'completed', fingerprint, operationId, reused: false, output, outputHash: hash(output) };
          }
        }
      } catch (error) {
        if (error?.needsReview) {
          admissionClosed = true;
          for (const pendingId of pending.keys()) state.nodes[pendingId] = { status: 'blocked', error: 'Admission closed: executor cleanup or history requires review' };
          pending.clear();
        }
        state.nodes[id] = { status: error?.needsReview ? 'needs_review' : signal.aborted ? 'interrupted' : 'failed', fingerprint, operationId, reused: false, error: String(error?.message ?? error) };
      }
      await save();
    }
    try {
      for (const group of logicalGroups(workflow.nodes)) {
        const gate = group.nodes.find(node => node.agentStep?.kind === 'collect');
        const limit = gate ? Math.min(concurrency, gate.agentConcurrency) : 1;
        while (group.nodes.some(node => pending.has(node.id)) || running.size) {
          if (!signal.aborted && !admissionClosed) {
            for (const node of group.nodes) {
              const id = node.id;
              if (!pending.has(id)) continue;
              if (node.deps.some(dep => ['failed', 'blocked', 'needs_review'].includes(state.nodes[dep].status))) {
                state.nodes[id] = { status: 'blocked' };
                pending.delete(id);
                continue;
              }
              if (running.size >= limit) continue;
              const resources = node.writeResources ?? ['*'];
              if ([...running.keys()].some(runningId => {
                const other = workflow.nodes.find(item => item.id === runningId)?.writeResources ?? ['*'];
                return resources.length && other.length && (resources.includes('*') || other.includes('*') || resources.some(item => other.includes(item)));
              })) continue;
              if (!node.deps.every(dep => state.nodes[dep].status === 'completed')) continue;
              pending.delete(id);
              const task = runNode(node).finally(() => running.delete(id));
              running.set(id, task);
            }
          }
          if (running.size) await Promise.race(running.values());
          else if (signal.aborted) break;
        }
        if (signal.aborted) break;
      }
    } catch (error) {
      await Promise.allSettled(running.values());
      await writes.catch(() => {});
      throw error;
    }
    state.status = admissionClosed ? 'needs_review' : signal.aborted ? 'interrupted'
      : Object.values(state.nodes).some(node => node.status === 'needs_review') ? 'needs_review'
      : Object.values(state.nodes).some(node => node.status === 'failed') ? 'failed' : 'completed';
    await save();
    return copy(state);
  }
}

async function abortable(invoke, signal) {
  signal.throwIfAborted();
  // Await actual executor settlement even after abort. No successor writer or retry
  // may be admitted while the previous executor still owns external effects.
  try {
    const value = await invoke();
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (error?.needsReview) throw error;
    if (signal.aborted) throw signal.reason ?? new Error('Interrupted');
    throw error;
  }
}
