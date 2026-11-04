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
  const nodes = new Map();
  for (const node of workflow.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim() || nodes.has(node.id)) {
      throw new TypeError('Node IDs must be nonempty and unique');
    }
    if (Object.hasOwn(node, 'tools')) validateTools(node.tools, node.id);
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
  for (const node of ordered) {
    if (!Object.hasOwn(node, 'agentId')) continue;
    const previous = preceding.get(node.agentId);
    if (previous !== undefined && !node.deps.includes(previous)) node.deps.push(previous);
    preceding.set(node.agentId, node.id);
  }
  return workflow;
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
export async function runWorkflow({ workflow: definition, workflowPath, statePath, storage, executor, executorVersion = '1', concurrency = 1, resumeNodeIds = [], signal = new AbortController().signal }) {
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
      node.retrySafe !== true && !resumable.has(node.id) && ['running', 'interrupted', 'needs_review'].includes(previous?.nodes?.[node.id]?.status)
        ? { status: 'needs_review', error: 'Manual review required: previous execution may have produced side effects; declare retrySafe: true only after verifying retry safety.' }
        : { status: 'pending' },
    ])) };
    let writes = Promise.resolve();
    const save = () => {
      const snapshot = copy(state);
      writes = writes.then(() => storage !== undefined ? storage.save(snapshot) : persist(statePath, snapshot));
      return writes;
    };
    await save();
    const pending = new Map(workflow.nodes.filter(node => state.nodes[node.id].status === 'pending').map(node => [node.id, node]));
    const running = new Map();
    async function runNode(node) {
      const id = node.id;
      const dependencies = Object.fromEntries(node.deps.map(dep => [dep, copy(state.nodes[dep].output)]));
      const fingerprint = hash({ workflowId: workflow.id, executorVersion, node: { ...node, deps: [...node.deps].sort() }, dependencies: Object.fromEntries(node.deps.map(dep => [dep, { fingerprint: state.nodes[dep].fingerprint, outputHash: state.nodes[dep].outputHash }])) });
      const old = previous?.nodes?.[id];
      if (old?.status === 'completed' && old.fingerprint === fingerprint && Object.hasOwn(old, 'output') && old.outputHash === hash(old.output)) {
        state.nodes[id] = { ...copy(old), reused: true };
        await save();
        return;
      }
      state.nodes[id] = { status: 'running', fingerprint, reused: false };
      await save();
      try {
        const output = copy(await abortable(() => executor(copy(node), { dependencies, fingerprint, runId: state.runId, signal }), signal));
        if (signal.aborted) throw new Error('Interrupted');
        state.nodes[id] = { status: 'completed', fingerprint, reused: false, output, outputHash: hash(output) };
      } catch (error) {
        state.nodes[id] = { status: signal.aborted ? 'interrupted' : 'failed', fingerprint, reused: false, error: String(error?.message ?? error) };
      }
      await save();
    }
    try {
      while (pending.size || running.size) {
        if (!signal.aborted) {
          for (const [id, node] of pending) {
            if (running.size >= concurrency) break;
            if (node.deps.some(dep => ['failed', 'blocked', 'needs_review'].includes(state.nodes[dep].status))) {
              state.nodes[id] = { status: 'blocked' };
              pending.delete(id);
              continue;
            }
            if (!node.deps.every(dep => state.nodes[dep].status === 'completed')) continue;
            pending.delete(id);
            const task = runNode(node).finally(() => running.delete(id));
            running.set(id, task);
          }
        }
        if (running.size) await Promise.race(running.values());
        else if (signal.aborted) break;
        else if (pending.size) continue; // Propagate blocking through arbitrary node order.
      }
    } catch (error) {
      await Promise.allSettled(running.values());
      await writes.catch(() => {});
      throw error;
    }
    state.status = signal.aborted ? 'interrupted'
      : Object.values(state.nodes).some(node => node.status === 'needs_review') ? 'needs_review'
      : Object.values(state.nodes).some(node => node.status === 'failed') ? 'failed' : 'completed';
    await save();
    return copy(state);
  }
}

function abortable(invoke, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Interrupted'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason ?? new Error('Interrupted');
      return invoke();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
