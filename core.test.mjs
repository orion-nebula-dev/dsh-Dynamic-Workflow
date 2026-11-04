import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Dynamic import lets the first RED report a missing API assertion, not an import error.
const core = await import('./core.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('core.mjs')) return {};
  throw error;
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-core-'));
  return { dir, statePath: join(dir, 'state.json'), workflowPath: join(dir, 'workflow.json') };
};

test('loads a JSON DAG and rejects cycles, duplicate IDs and missing dependencies', async () => {
  assert.equal(typeof core.validateWorkflow, 'function');
  assert.equal(typeof core.loadWorkflow, 'function');
  const f = await fixture();
  const workflow = { id: 'example', nodes: [{ id: 'b', deps: ['a'] }, { id: 'a', input: 2 }] };
  await writeFile(f.workflowPath, JSON.stringify(workflow));
  assert.deepEqual(await core.loadWorkflow(f.workflowPath), core.validateWorkflow(workflow));
  for (const nodes of [
    [{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }],
    [{ id: 'a' }, { id: 'a' }],
    [{ id: 'a', deps: ['missing'] }],
    [{ id: '' }],
    [{ id: 'a', deps: ['a'] }],
  ]) assert.throws(() => core.validateWorkflow({ id: 'example', nodes }));
});

test('persists outputs and reuses stable IDs across ordering and JSON key ordering', async () => {
  assert.equal(typeof core.runWorkflow, 'function');
  const f = await fixture();
  let calls = [];
  const executor = async (node, { dependencies }) => {
    calls.push(node.id);
    return node.id === 'a' ? node.input.x : dependencies.a + 1;
  };
  const workflow = { id: 'reuse', nodes: [{ id: 'b', deps: ['a'] }, { id: 'a', input: { x: 4, y: 2 } }] };
  await writeFile(f.workflowPath, JSON.stringify(workflow));
  const first = await core.runWorkflow({ ...f, executor });
  assert.equal(first.status, 'completed');
  assert.equal(first.nodes.b.output, 5);
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')), first);
  workflow.nodes = [{ input: { y: 2, x: 4 }, id: 'a' }, { deps: ['a'], id: 'b' }];
  calls = [];
  const second = await core.runWorkflow({ workflow, statePath: f.statePath, executor });
  assert.deepEqual(calls, []);
  assert.equal(second.nodes.b.reused, true);
  assert.notEqual(first.runId, second.runId);
});

test('propagates changed inputs through descendants even when output is unchanged', async () => {
  assert.equal(typeof core.runWorkflow, 'function');
  const { statePath } = await fixture();
  const workflow = { id: 'impact', nodes: [{ id: 'a', input: 1 }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }, { id: 'unrelated' }] };
  let calls = [];
  const executor = async node => { calls.push(node.id); return 10; };
  await core.runWorkflow({ workflow, statePath, executor });
  workflow.nodes[0].input = 2;
  calls = [];
  const next = await core.runWorkflow({ workflow, statePath, executor });
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.equal(next.nodes.unrelated.reused, true);
  calls = [];
  await core.runWorkflow({ workflow, statePath, executor, executorVersion: 'changed' });
  assert.equal(calls.length, 4);
});

test('does not reuse corrupted output or results belonging to another workflow', async () => {
  assert.equal(typeof core.runWorkflow, 'function');
  const { statePath } = await fixture();
  const workflow = { id: 'first', nodes: [{ id: 'a' }, { id: 'b', deps: ['a'] }] };
  let calls = [];
  const executor = async node => { calls.push(node.id); return { value: 7 }; };
  await core.runWorkflow({ workflow, statePath, executor });
  const disk = JSON.parse(await readFile(statePath, 'utf8'));
  disk.nodes.a.output.value = 999;
  await writeFile(statePath, JSON.stringify(disk));
  calls = [];
  const result = await core.runWorkflow({ workflow, statePath, executor });
  assert.deepEqual(result.nodes.a.output, { value: 7 });
  assert.ok(calls.includes('a'));
  workflow.id = 'second';
  calls = [];
  await core.runWorkflow({ workflow, statePath, executor });
  assert.deepEqual(calls, ['a', 'b']);
});

test('runs independent nodes concurrently without exceeding the limit', async () => {
  const { statePath } = await fixture();
  let active = 0, maximum = 0;
  const workflow = { id: 'parallel', nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })) };
  const state = await core.runWorkflow({ workflow, statePath, concurrency: 2, executor: async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--; return 1;
  } });
  assert.equal(maximum, 2);
  assert.equal(state.status, 'completed');
  for (const concurrency of [0, -1, 1.2, Infinity]) {
    await assert.rejects(core.runWorkflow({ workflow, statePath, concurrency, executor: async () => 1 }), /concurrency/i);
  }
});

test('interruption persists in-flight state and discards late results after successor execution', async () => {
  const { statePath } = await fixture();
  const controller = new AbortController(), entered = deferred(), late = deferred();
  const workflow = { id: 'resume', nodes: [{ id: 'done' }, { id: 'slow', deps: ['done'], retrySafe: true }, { id: 'after', deps: ['slow'] }] };
  const firstRun = core.runWorkflow({ workflow, statePath, signal: controller.signal, executor: async (node, context) => {
    if (node.id === 'done') return 'saved';
    assert.equal(context.signal, controller.signal);
    entered.resolve();
    return late.promise;
  } });
  // Fails immediately on the old implementation rather than waiting for a missing signal.
  const started = await Promise.race([entered.promise.then(() => true), firstRun.then(() => false, () => false)]);
  assert.equal(started, true);
  controller.abort();
  const first = await firstRun;
  assert.equal(first.status, 'interrupted');
  assert.equal(first.nodes.slow.status, 'interrupted');
  assert.equal(first.nodes.after.status, 'pending');
  assert.equal(Object.hasOwn(first.nodes.slow, 'output'), false);
  const calls = [];
  const second = await core.runWorkflow({ workflow, statePath, executor: async node => { calls.push(node.id); return 'new'; } });
  assert.deepEqual(calls, ['slow', 'after']);
  assert.equal(second.nodes.done.reused, true);
  late.resolve('stale');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), second);
  assert.equal(first.nodes.slow.status, 'interrupted');
});

test('failed nodes block descendants while independent work survives for retry', async () => {
  const { statePath } = await fixture();
  const workflow = { id: 'failure', nodes: [{ id: 'bad' }, { id: 'child', deps: ['bad'] }, { id: 'good' }] };
  const first = await core.runWorkflow({ workflow, statePath, executor: async node => {
    if (node.id === 'bad') throw new Error('expected failure');
    return 1;
  } });
  assert.equal(first.status, 'failed');
  assert.equal(first.nodes.bad.status, 'failed');
  assert.equal(first.nodes.child.status, 'blocked');
  assert.equal(first.nodes.good.status, 'completed');
  const calls = [];
  const second = await core.runWorkflow({ workflow, statePath, executor: async node => { calls.push(node.id); return 2; } });
  assert.deepEqual(calls, ['bad', 'child']);
  assert.equal(second.status, 'completed');
});

test('rejects lossy non-JSON inputs and outputs instead of caching a different value', async () => {
  for (const input of [NaN, Infinity, undefined, () => 1, new Date(), { nested: undefined }]) {
    assert.throws(() => core.validateWorkflow({ id: 'json', nodes: [{ id: 'a', input }] }), /JSON/i);
  }
  const { statePath } = await fixture();
  const state = await core.runWorkflow({ workflow: { id: 'json', nodes: [{ id: 'a' }] }, statePath, executor: async () => NaN });
  assert.equal(state.status, 'failed');
  assert.equal(Object.hasOwn(state.nodes.a, 'output'), false);
});

test('recovers a disk snapshot left running and never trusts an in-flight output', async () => {
  const { statePath } = await fixture();
  const workflow = { id: 'crash', nodes: [{ id: 'a' }, { id: 'b', deps: ['a'], retrySafe: true }] };
  const initial = await core.runWorkflow({ workflow, statePath, executor: async () => 1 });
  initial.status = 'running';
  initial.nodes.b.status = 'running';
  initial.nodes.b.output = 'uncommitted';
  await writeFile(statePath, JSON.stringify(initial));
  const calls = [];
  const result = await core.runWorkflow({ workflow, statePath, executor: async node => { calls.push(node.id); return 2; } });
  assert.deepEqual(calls, ['b']);
  assert.equal(result.nodes.a.reused, true);
  assert.equal(result.nodes.b.output, 2);
});

test('executor mutations cannot alter sibling inputs, saved outputs or the definition', async () => {
  const { statePath } = await fixture();
  const workflow = { id: 'isolate', nodes: [{ id: 'a', input: { value: 3 } }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['a'] }] };
  const result = await core.runWorkflow({ workflow, statePath, executor: async (node, { dependencies }) => {
    if (node.id === 'a') { node.input.value = 9; return { value: 3 }; }
    if (node.id === 'b') { dependencies.a.value = 99; return 0; }
    return dependencies.a.value;
  } });
  assert.equal(workflow.nodes[0].input.value, 3);
  assert.deepEqual(result.nodes.a.output, { value: 3 });
  assert.equal(result.nodes.c.output, 3);
});

test('an already aborted run starts no executor and returns a recoverable snapshot', async () => {
  const { statePath } = await fixture();
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await core.runWorkflow({ workflow: { id: 'abort', nodes: [{ id: 'a' }] }, statePath, signal: controller.signal, executor: async () => { calls++; return 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.nodes.a.status, 'pending');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), result);
});

test('injected storage survives new processes and reuses completed outputs', async () => {
  const { statePath } = await fixture();
  const script = `
    import { readFile, writeFile } from 'node:fs/promises';
    import { runWorkflow } from ${JSON.stringify(new URL('./core.mjs', import.meta.url).href)};
    const storage = {
      async load() {
        try { return JSON.parse(await readFile(process.argv[1], 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      },
      async save(snapshot) { await writeFile(process.argv[1], JSON.stringify(snapshot)); }
    };
    const calls = [];
    const result = await runWorkflow({ storage,
      workflow: { id: 'storage', nodes: [{ id: 'a' }, { id: 'b', deps: ['a'] }] },
      executor: async (node, { dependencies }) => { calls.push(node.id); return node.id === 'a' ? 4 : dependencies.a + 1; }
    });
    console.log(JSON.stringify({ calls, result }));
  `;
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, statePath])).stdout);
  const first = await run();
  assert.deepEqual(first.calls, ['a', 'b']);
  assert.equal(first.result.nodes.b.output, 5);
  const second = await run();
  assert.deepEqual(second.calls, []);
  assert.equal(second.result.nodes.b.reused, true);
  assert.notEqual(first.result.runId, second.result.runId);
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), second.result);
});

test('recreated storage adapters isolate snapshots and serialize saves', async () => {
  let saved, saving = false;
  const storage = () => ({
    async load() { return saved; },
    async save(snapshot) {
      assert.equal(saving, false);
      saving = true;
      await new Promise(resolve => setImmediate(resolve));
      saved = structuredClone(snapshot);
      snapshot.nodes.a.status = 'tampered';
      saving = false;
    },
  });
  const workflow = { id: 'adapter', nodes: [{ id: 'a' }, { id: 'b' }] };
  const first = await core.runWorkflow({ workflow, storage: storage(), concurrency: 2, executor: async () => 7 });
  assert.equal(first.nodes.a.status, 'completed');
  const previous = structuredClone(saved);
  const second = await core.runWorkflow({ workflow, storage: storage(), executor: async () => assert.fail('cached executor ran') });
  assert.equal(second.nodes.a.reused, true);
  assert.equal(previous.nodes.a.reused, false);
});

test('storage errors reject before starting side effects and missing statePath still rejects', async () => {
  const workflow = { id: 'errors', nodes: [{ id: 'a' }] };
  const executor = async () => assert.fail('executor must not run');
  await assert.rejects(core.runWorkflow({ workflow, executor }), { code: 'ERR_INVALID_ARG_TYPE' });
  await assert.rejects(core.runWorkflow({ workflow, executor, storage: { async load() { throw new Error('load failed'); }, async save() {} } }), /load failed/);
  await assert.rejects(core.runWorkflow({ workflow, executor, storage: { async load() {}, async save() { throw new Error('save failed'); } } }), /save failed/);
});

test('unfinished side effects require review across resumes and block descendants', async () => {
  for (const historicalStatus of ['running', 'interrupted']) {
    const { statePath } = await fixture();
    const workflow = { id: 'review', nodes: [{ id: 'grandchild', deps: ['child'] }, { id: 'effect' }, { id: 'child', deps: ['effect'] }, { id: 'independent' }] };
    const firstCalls = [];
    const first = await core.runWorkflow({ workflow, statePath, executor: async node => { firstCalls.push(node.id); return 1; } });
    assert.equal(first.status, 'completed');
    assert.equal(firstCalls.length, 4); // First execution never needs retry opt-in.
    first.status = historicalStatus;
    first.nodes.effect.status = historicalStatus;
    await writeFile(statePath, JSON.stringify(first));
    for (let attempt = 0; attempt < 2; attempt++) {
      const calls = [];
      const result = await core.runWorkflow({ workflow, statePath, executor: async node => { calls.push(node.id); return 2; } });
      assert.deepEqual(calls, []);
      assert.equal(result.status, 'needs_review');
      assert.equal(result.nodes.effect.status, 'needs_review');
      assert.match(result.nodes.effect.error, /manual|review/i);
      assert.equal(Object.hasOwn(result.nodes.effect, 'output'), false);
      assert.equal(result.nodes.child.status, 'blocked');
      assert.equal(result.nodes.grandchild.status, 'blocked');
      assert.equal(result.nodes.independent.reused, true);
    }
    workflow.nodes[1].retrySafe = true;
    const calls = [];
    const retried = await core.runWorkflow({ workflow, statePath, executor: async node => { calls.push(node.id); return 2; } });
    assert.equal(retried.status, 'completed');
    assert.deepEqual(calls, ['effect', 'child', 'grandchild']);
  }
});

test('a verified existing Agent session can continue an interrupted non-retryable node', async () => {
  let snapshot;
  const storage = { async load() { return snapshot; }, async save(value) { snapshot = structuredClone(value); } };
  const workflow = { id: 'session-continuation', nodes: [{ id: 'a', prompt: 'Complete the original task' }] };
  const first = await core.runWorkflow({ workflow, storage, executor: async () => 'original result' });
  snapshot.status = 'interrupted'; snapshot.nodes.a.status = 'interrupted';
  delete snapshot.nodes.a.output; delete snapshot.nodes.a.outputHash;
  let continuedFingerprint;
  const next = await core.runWorkflow({ workflow, storage, resumeNodeIds: ['a'], executor: async (_node, context) => {
    continuedFingerprint = context.fingerprint;
    return 'continued in the original session';
  } });
  assert.equal(next.status, 'completed');
  assert.equal(next.nodes.a.output, 'continued in the original session');
  assert.equal(continuedFingerprint, first.nodes.a.fingerprint);
});

test('resolves roster and role defaults on detached, idempotent nodes', () => {
  const workflow = { id: 'roles', agents: { alice: { title: 'Alice' }, bob: {}, carol: {} },
    roles: { writer: { title: 'Writer', prompt: 'Write carefully', tools: ['read'] }, reviewer: { prompt: 'Review carefully' } },
    nodes: [
      { id: 'a', agentId: 'alice', agentTitle: 'Old title', role: 'writer' },
      { id: 'b', agentId: 'bob', agentTitle: 'Bob', role: 'writer', tools: [] },
      { id: 'c', agentId: 'carol', role: 'reviewer' },
      { id: 'legacy', input: { nested: [1] } },
    ] };
  const before = structuredClone(workflow);
  const normalized = core.validateWorkflow(workflow);
  assert.deepEqual(normalized.nodes[0], { id: 'a', agentId: 'alice', agentTitle: 'Alice', role: 'writer', rolePrompt: 'Write carefully', roleTitle: 'Writer', tools: ['read'], deps: [] });
  assert.deepEqual(normalized.nodes[1].tools, []);
  assert.equal(normalized.nodes[1].agentTitle, 'Bob');
  assert.equal(normalized.nodes[2].agentTitle, 'carol');
  assert.equal(normalized.nodes[2].roleTitle, 'reviewer');
  assert.equal(Object.hasOwn(normalized.nodes[2], 'tools'), false);
  assert.deepEqual(normalized.nodes[3], { ...before.nodes[3], deps: [] });
  assert.deepEqual(core.validateWorkflow(normalized), normalized);
  normalized.nodes[0].tools.push('write');
  normalized.nodes[3].input.nested.push(2);
  assert.deepEqual(normalized.roles.writer.tools, ['read']);
  assert.deepEqual(workflow, before);
  assert.equal(core.validateWorkflow({ id: 'free', nodes: [{ id: 'a', agentId: 'unlisted' }] }).nodes[0].agentTitle, 'unlisted');
});

test('rejects invalid roster, role, identity and tool declarations', () => {
  const invalid = [
    { agents: [] }, { agents: null }, { agents: { ' ': {} } }, { agents: { a: [] } }, { agents: { a: { title: 1 } } },
    { roles: [] }, { roles: null }, { roles: { '': { prompt: 'x' } } }, { roles: { r: null } },
    { roles: { r: { prompt: ' ' } } }, { roles: { r: { prompt: 1 } } }, { roles: { r: { title: false, prompt: 'x' } } },
    { roles: { r: { prompt: 'x', tools: ['read', 'read'] } } },
    ...[null, '', ' ', 1].map(agentId => ({ nodes: [{ id: 'a', agentId }] })),
    ...[null, '', ' ', 1, 'missing'].map(role => ({ nodes: [{ id: 'a', role }] })),
    ...[null, 'read', [1], [''], [' '], ['read', 'read']].map(tools => ({ nodes: [{ id: 'a', tools }] })),
    { agents: {}, nodes: [{ id: 'a', agentId: 'missing' }] },
    { agents: {}, nodes: [{ id: 'a', agentId: 'toString' }] },
    { roles: {}, nodes: [{ id: 'a', role: 'toString' }] },
    { nodes: [{ id: 'a', agentId: 'x', agentTitle: 1 }] },
  ];
  for (const value of invalid) assert.throws(() => core.validateWorkflow({ id: 'invalid', nodes: [{ id: 'a' }], ...value }), undefined, JSON.stringify(value));
});

test('chains explicit agents in stable topological order for unordered definitions', () => {
  const workflow = { id: 'unordered', nodes: [
    { id: 'last', agentId: 'x', deps: ['middle'] },
    { id: 'middle', agentId: 'x', deps: ['first'] },
    { id: 'independent', agentId: 'x' },
    { id: 'first', agentId: 'x' },
    { id: 'legacy' },
  ] };
  const normalized = core.validateWorkflow(workflow);
  assert.deepEqual(normalized.nodes.map(node => [node.id, node.deps]), [
    ['last', ['middle']], ['middle', ['first']], ['independent', []], ['first', ['independent']], ['legacy', []],
  ]);
  assert.deepEqual(core.validateWorkflow(normalized), normalized);
  assert.equal(Object.hasOwn(workflow.nodes[2], 'deps'), false);
});

test('serializes one agent while distinct agents execute in parallel', async () => {
  const { statePath } = await fixture();
  const active = new Set();
  let maximum = 0;
  const completed = [];
  const workflow = { id: 'identities', nodes: [
    { id: 'first', agentId: 'x' }, { id: 'second', agentId: 'x' }, { id: 'other', agentId: 'y' },
  ] };
  const result = await core.runWorkflow({ workflow, statePath, concurrency: 3, executor: async (node, { dependencies }) => {
    assert.equal(active.has(node.agentId), false, 'same Agent overlapped');
    active.add(node.agentId); maximum = Math.max(maximum, active.size);
    if (node.id === 'second') { assert.ok(completed.includes('first')); assert.deepEqual(dependencies, { first: 'first' }); }
    await new Promise(resolve => setTimeout(resolve, 10));
    active.delete(node.agentId); completed.push(node.id);
    return node.id;
  } });
  assert.equal(result.status, 'completed');
  assert.equal(maximum, 2);
  assert.deepEqual(new Set(completed), new Set(['first', 'second', 'other']));
});

test('earlier same-agent input and role changes invalidate later cached history', async () => {
  const { statePath } = await fixture();
  const workflow = { id: 'history', roles: { writer: { prompt: 'Write' } }, nodes: [
    { id: 'first', agentId: 'x', role: 'writer', input: 1 },
    { id: 'second', agentId: 'x' }, { id: 'downstream', deps: ['second'] }, { id: 'unrelated' },
  ] };
  let calls = [];
  const executor = async node => { calls.push(node.id); return 'unchanged output'; };
  await core.runWorkflow({ workflow, statePath, executor });
  for (const change of [() => {}, () => { workflow.nodes[0].input = 2; }, () => { workflow.roles.writer.prompt = 'Write differently'; }]) {
    change(); calls = [];
    const result = await core.runWorkflow({ workflow, statePath, executor });
    assert.deepEqual(calls, workflow.nodes[0].input === 1 ? [] : ['first', 'second', 'downstream']);
    assert.equal(result.nodes.unrelated.reused, true);
  }
});

test('rejects overlapping runs against the same state file', async () => {
  const { statePath } = await fixture();
  const entered = deferred(), release = deferred();
  const workflow = { id: 'lock', nodes: [{ id: 'a' }] };
  const first = core.runWorkflow({ workflow, statePath, executor: async () => { entered.resolve(); return release.promise; } });
  await entered.promise;
  try {
    await assert.rejects(core.runWorkflow({ workflow, statePath, executor: async () => 2 }), /already running|locked/i);
  } finally { release.resolve(1); await first; }
});
