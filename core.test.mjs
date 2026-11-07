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

test('runs nodes serially and collects multiple agents in one node concurrently', async () => {
  const { statePath } = await fixture();
  let active = 0, maximum = 0, order = [];
  const workflow = {
    id: 'serial-nodes',
    nodes: [
      { id: 'first' },
      { id: 'second', deps: ['first'], agents: [
        { id: 'review', agentId: 'reviewer', prompt: 'Review', writeResources: [] },
        { id: 'audit', agentId: 'auditor', prompt: 'Audit', writeResources: [] },
      ] },
      { id: 'third', deps: ['second'] },
    ],
  };
  const state = await core.runWorkflow({ workflow, statePath, concurrency: 8, executor: async node => {
    order.push(node.id);
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return node.id;
  } });
  assert.equal(maximum, 2);
  assert.deepEqual(order, ['first', 'second/agent/review', 'second/agent/audit', 'third']);
  assert.deepEqual(state.nodes.second.output, { review: 'second/agent/review', audit: 'second/agent/audit' });
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
    assert.equal(context.signal.aborted, controller.signal.aborted);
    entered.resolve();
    return late.promise;
  } });
  // Fails immediately on the old implementation rather than waiting for a missing signal.
  const started = await Promise.race([entered.promise.then(() => true), firstRun.then(() => false, () => false)]);
  assert.equal(started, true);
  controller.abort();
  late.resolve('stale');
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
  const workflow = { id: 'failure', nodes: [{ id: 'bad', retrySafe: true }, { id: 'child', deps: ['bad'] }, { id: 'good' }] };
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

test('serializes logical nodes even for distinct agent identities', async () => {
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
  assert.equal(maximum, 1);
  assert.deepEqual(completed, ['first', 'second', 'other']);
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

test('expands reviewLoop into bounded review fix gate nodes with fixed schema', () => {
  const workflow = { id: 'review-expand', agents: { dev: {}, rev: {} }, roles: { review: { prompt: 'review' }, fix: { prompt: 'fix' } }, nodes: [
    { id: 'quality', deps: ['input'], agentId: 'dev', reviewLoop: {
      review: { agentId: 'rev', role: 'review', prompt: 'Check ${input}' },
      fix: { agentId: 'dev', role: 'fix', prompt: 'Fix ${findings}' },
    } },
    { id: 'input' },
  ] };
  const result = core.validateWorkflow(workflow);
  assert.deepEqual(result.nodes.map(node => node.id), ['quality/review/1', 'quality/fix/1', 'quality/review/2', 'quality/fix/2', 'quality/review/3', 'quality', 'input']);
  assert.deepEqual(result.nodes.find(node => node.id === 'quality/review/1').deps, ['input']);
  assert.deepEqual(result.nodes.find(node => node.id === 'quality/fix/1').deps, ['input', 'quality/review/1']);
  assert.deepEqual(result.nodes.find(node => node.id === 'quality/review/2').deps, ['quality/fix/1', 'quality/review/1']);
  assert.deepEqual(result.nodes.find(node => node.id === 'quality').deps, ['quality/review/3']);
  assert.equal(result.nodes.find(node => node.id === 'quality/review/1').reviewStep.kind, 'review');
  assert.deepEqual(core.validateWorkflow(result), result);
  assert.deepEqual(result.nodes.find(node => node.id === 'quality/review/1').schema, {
    type: 'object', description: 'approved requires empty findings; changes-required requires non-empty findings; evidence must be verifiable.', properties: { verdict: { enum: ['approved', 'changes-required'] }, findings: { type: 'array', items: { type: 'object', properties: { message: { type: 'string' }, evidence: { type: 'string' } }, required: ['message', 'evidence'] } } }, required: ['verdict', 'findings'],
  });
});

test('rejects reviewLoop invalid bounds and same agent identities', () => {
  const base = { id: 'invalid-loop', agents: { a: {}, b: {} }, roles: { review: { prompt: 'r' }, fix: { prompt: 'f' } }, nodes: [{ id: 'q', agentId: 'a', reviewLoop: { review: { agentId: 'a', role: 'review', prompt: 'r' }, fix: { agentId: 'a', role: 'fix', prompt: 'f' } } }] };
  assert.throws(() => core.validateWorkflow(base), /different|agent/i);
  for (const maxRounds of [0, -1, 1.2, 51]) assert.throws(() => core.validateWorkflow({ ...base, nodes: [{ ...base.nodes[0], reviewLoop: { maxRounds, review: { agentId: 'b', prompt: 'r' }, fix: { agentId: 'a', prompt: 'f' } } }] }), /maxRounds|integer|range/i);
});

test('passes original dependencies to a fresh fixer alongside review findings', async () => {
  const { statePath } = await fixture();
  const workflow = { id: 'fresh-fixer', agents: { impl: {}, rev: {}, fix: {} }, roles: { review: { prompt: 'review' }, fix: { prompt: 'fix' } }, nodes: [{ id: 'implement', input: 'draft' }, { id: 'quality', deps: ['implement'], reviewLoop: { maxRounds: 2, review: { agentId: 'rev', role: 'review', prompt: 'r' }, fix: { agentId: 'fix', role: 'fix', prompt: 'f' } } }] };
  let fixerDeps;
  await core.runWorkflow({ workflow, statePath, executor: async (node, { dependencies }) => {
    if (node.reviewStep?.kind === 'fix') { fixerDeps = dependencies; return 'fixed'; }
    if (node.reviewStep?.kind === 'review') return { verdict: node.reviewStep.round === 1 ? 'changes-required' : 'approved', findings: node.reviewStep.round === 1 ? [{ message: 'm', evidence: 'e' }] : [] };
    return node.id === 'implement' ? node.input : 1;
  } });
  assert.equal(fixerDeps.implement, 'draft');
  assert.deepEqual(fixerDeps['quality/review/1'].findings, [{ message: 'm', evidence: 'e' }]);
});

test('executes review fix cycles, skips after approval, and fails gate at limit', async () => {
  const { statePath } = await fixture();
  const workflow = { id: 'review-run', agents: { dev: {}, rev: {} }, roles: { review: { prompt: 'review' }, fix: { prompt: 'fix' } }, nodes: [{ id: 'quality', reviewLoop: { maxRounds: 2, review: { agentId: 'rev', role: 'review', prompt: 'r' }, fix: { agentId: 'dev', role: 'fix', prompt: 'f' } } }, { id: 'deliver', deps: ['quality'] }] };
  const calls = [];
  const approved = await core.runWorkflow({ workflow, statePath, executor: async node => { calls.push(node.id); return node.reviewStep?.kind === 'review' ? { verdict: 'approved', findings: [] } : 1; } });
  assert.equal(approved.status, 'completed');
  assert.equal(approved.nodes['quality'].status, 'completed');
  assert.equal(approved.nodes['quality/fix/1'].skipped, true);
  assert.equal(approved.nodes['quality/review/2'].skipped, true);
  assert.deepEqual(calls, ['quality/review/1', 'deliver']);
  const failFixture = await fixture();
  const fail = await core.runWorkflow({ workflow: { ...workflow, id: 'review-fail' }, statePath: failFixture.statePath, executor: async node => node.reviewStep?.kind === 'review' ? { verdict: 'changes-required', findings: [{ message: 'x', evidence: 'y' }] } : 1 });
  assert.equal(fail.status, 'failed');
  assert.equal(fail.nodes.quality.status, 'failed');
  assert.match(fail.nodes.quality.error, /limit 2/i);
  assert.equal(fail.nodes.deliver.status, 'blocked');
  assert.equal(fail.nodes['quality/fix/1'].status, 'completed');
});

test('rejects invalid review verdicts and findings', async () => {
  for (const output of [{ verdict: 'wat', findings: [] }, { verdict: 'approved', findings: [{ message: 'x', evidence: 'y' }] }, { verdict: 'changes-required', findings: [] }]) {
    const badFixture = await fixture();
    const result = await core.runWorkflow({ statePath: badFixture.statePath, workflow: { id: `bad-${Math.random()}`, nodes: [{ id: 'q', reviewLoop: { review: { agentId: 'r', role: 'review', prompt: 'r' }, fix: { agentId: 'f', role: 'fix', prompt: 'f' } } }], agents: { r: {}, f: {} }, roles: { review: { prompt: 'r' }, fix: { prompt: 'f' } } }, executor: async () => output });
    assert.equal(result.status, 'failed');
    assert.equal(result.nodes['q/review/1'].status, 'failed');
  }
});

const reviewWorkflow = (maxRounds = 3) => ({ id: 'review-fixture', nodes: [{ id: 'implement', input: 'draft' }, { id: 'q', deps: ['implement'], reviewLoop: { maxRounds, review: { agentId: 'r', prompt: 'review' }, fix: { agentId: 'f', prompt: 'fix' } } }, { id: 'after', deps: ['q'] }] });
const approvedReport = { verdict: 'approved', findings: [] };
const changeReport = { verdict: 'changes-required', findings: [{ message: 'repair', evidence: 'line 1' }] };
const memoryStorage = () => { let value; return { async load() { return value; }, async save(snapshot) { value = structuredClone(snapshot); } }; };

test('supports round limits one two and three with no final fix', async () => {
  for (const maxRounds of [1, 2, 3]) {
    const calls = [];
    const result = await core.runWorkflow({ workflow: reviewWorkflow(maxRounds), storage: memoryStorage(), executor: async node => { calls.push(node.id); return node.reviewStep?.kind === 'review' ? changeReport : 'done'; } });
    assert.equal(result.nodes.q.status, 'failed');
    assert.match(result.nodes.q.error, new RegExp(`limit ${maxRounds}`, 'i'));
    assert.equal(calls.filter(id => id.includes('/review/')).length, maxRounds);
    assert.equal(calls.filter(id => id.includes('/fix/')).length, maxRounds - 1);
    assert.equal(result.nodes.after.status, 'blocked');
  }
});

test('normalizes bare and fenced JSON review reports and keeps warning fields', async () => {
  for (const output of [JSON.stringify(approvedReport), `\u0060\u0060\u0060json\n${JSON.stringify({ ...approvedReport, warnings: ['note'] })}\n\u0060\u0060\u0060`]) {
    const result = await core.runWorkflow({ workflow: reviewWorkflow(1), storage: memoryStorage(), executor: async node => node.reviewStep?.kind === 'review' ? output : 'done' });
    assert.equal(result.status, 'completed');
    assert.equal(result.nodes.q.output.verdict, 'approved');
    assert.equal(typeof result.nodes['q/review/1'].output, 'object');
  }
});

test('reuses stored completed fixes and retries only the failed review then invalidates changed inputs', async () => {
  const workflow = reviewWorkflow(3), storage = memoryStorage(), firstCalls = [];
  workflow.nodes[1].reviewLoop.review.retrySafe = true;
  const first = await core.runWorkflow({ workflow, storage, executor: async node => {
    firstCalls.push(node.id);
    if (node.id === 'q/review/2') throw new Error('network unavailable');
    return node.reviewStep?.kind === 'review' ? changeReport : 'done';
  } });
  assert.equal(first.nodes['q/review/2'].status, 'failed');
  const calls = [];
  const second = await core.runWorkflow({ workflow: core.validateWorkflow(workflow), storage, executor: async node => { calls.push(node.id); return node.reviewStep?.kind === 'review' ? approvedReport : 'done'; } });
  assert.deepEqual(calls, ['q/review/2', 'after']);
  assert.equal(second.nodes['q/fix/1'].reused, true);
  assert.equal(second.nodes['q/review/3'].skipped, true);
  calls.length = 0;
  await core.runWorkflow({ workflow, storage, executor: async () => assert.fail('reused executor') });
  workflow.nodes[0].input = 'changed';
  await core.runWorkflow({ workflow, storage, executor: async node => { calls.push(node.id); return node.reviewStep?.kind === 'review' ? approvedReport : 'done'; } });
  assert.deepEqual(calls, ['implement', 'q/review/1', 'after']);
});

test('cancellation interrupts current review without starting a fix and resumes completed history', async () => {
  const workflow = reviewWorkflow(3), storage = memoryStorage(), controller = new AbortController();
  const result = await core.runWorkflow({ workflow, storage, signal: controller.signal, executor: async node => {
    if (node.id === 'q/review/2') { controller.abort(); return approvedReport; }
    return node.reviewStep?.kind === 'review' ? changeReport : 'done';
  } });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.nodes['q/review/2'].status, 'interrupted');
  assert.equal(result.nodes['q/fix/2'].status, 'pending');
  const calls = [];
  await core.runWorkflow({ workflow, storage, resumeNodeIds: ['q/review/2'], executor: async node => { calls.push(node.id); return node.reviewStep?.kind === 'review' ? approvedReport : 'done'; } });
  assert.deepEqual(calls, ['q/review/2', 'after']);
});

test('pure gate can recover a running snapshot without manual side effect review', async () => {
  const workflow = reviewWorkflow(1), storage = memoryStorage();
  await core.runWorkflow({ workflow, storage, executor: async node => node.reviewStep?.kind === 'review' ? approvedReport : 'done' });
  const saved = await storage.load(); saved.nodes.q.status = 'running';
  delete saved.nodes.q.output; delete saved.nodes.q.outputHash;
  await storage.save(saved);
  const result = await core.runWorkflow({ workflow, storage, executor: async () => assert.fail('completed executor replayed') });
  assert.equal(result.status, 'completed');
  assert.equal(result.nodes.q.status, 'completed');
  assert.equal(result.nodes.q.skipped, undefined);
});

test('rejects template structural fields schema overrides and generated ID collisions', () => {
  for (const field of ['id', 'deps', 'reviewLoop', 'reviewStep', 'schema']) {
    const workflow = reviewWorkflow(); workflow.nodes[1].reviewLoop.review[field] = field === 'id' ? 'override' : {};
    assert.throws(() => core.validateWorkflow(workflow), /template field/);
  }
  const collision = reviewWorkflow(); collision.nodes.push({ id: 'q/review/2' });
  assert.throws(() => core.validateWorkflow(collision), /collision/);
  const missing = reviewWorkflow(); delete missing.nodes[1].reviewLoop.fix.agentId;
  assert.throws(() => core.validateWorkflow(missing), /template/);
  const unknown = reviewWorkflow(); unknown.nodes[1].reviewLoop.review.role = 'missing';
  assert.throws(() => core.validateWorkflow(unknown), /role/);
  const maximum = core.validateWorkflow(reviewWorkflow(50));
  assert.equal(maximum.nodes.filter(node => node.reviewStep?.kind === 'review').length, 50);
});

test('review loop IDs containing fix segments preserve their exact dependency prefix', () => {
  const id = 'quality/fix/2';
  const workflow = core.validateWorkflow({ id: 'nested-loop-id', nodes: [{ id, reviewLoop: {
    review: { agentId: 'reviewer', prompt: 'Check artifact' }, fix: { agentId: 'developer', prompt: 'Repair artifact' },
  } }] });
  assert.deepEqual(workflow.nodes.find(node => node.id === `${id}/review/2`).deps, [`${id}/fix/1`, `${id}/review/1`]);
  assert.deepEqual(core.validateWorkflow(workflow), workflow);
});

const agentGroup = () => ({ id: 'members', nodes: [
  { id: 'group', agents: [{ id: 'a', agentId: 'alice', prompt: 'A', retrySafe: true, writeResources: ['a'] }, { id: 'b', agentId: 'bob', prompt: 'B', writeResources: ['b'] }] },
  { id: 'after', deps: ['group'] }, { id: 'independent' },
] });

test('agent groups expand idempotently with resolved roles and pure collect gates', () => {
  const workflow = agentGroup();
  workflow.roles = { writer: { prompt: 'Write', tools: [] } };
  workflow.nodes[0].agents[0].role = 'writer';
  const normalized = core.validateWorkflow(workflow);
  assert.deepEqual(normalized.nodes.map(node => node.id), ['group/agent/a', 'group/agent/b', 'group', 'after', 'independent']);
  assert.deepEqual(core.validateWorkflow(normalized), normalized);
  assert.equal(normalized.nodes[0].rolePrompt, 'Write');
  assert.deepEqual(normalized.nodes[0].tools, []);
  assert.deepEqual(normalized.nodes[0].agentStep, { groupId: 'group', memberId: 'a', kind: 'member' });
  assert.deepEqual(normalized.nodes[2].agentStep, { groupId: 'group', kind: 'collect', members: ['a', 'b'] });
  assert.deepEqual(normalized.nodes[2].deps, ['group/agent/a', 'group/agent/b']);
  assert.equal(normalized.nodes[2].retrySafe, true);
});

test('member limits honor global and local concurrency while independent logical nodes wait', async () => {
  for (const [global, local, expected] of [[8, undefined, 2], [1, undefined, 1], [8, 1, 1]]) {
    const workflow = agentGroup();
    if (local !== undefined) workflow.nodes[0].agentConcurrency = local;
    let active = 0, maximum = 0;
    const calls = [];
    const state = await core.runWorkflow({ workflow, storage: memoryStorage(), concurrency: global, executor: async node => {
      calls.push(node.id);
      if (!node.agentStep) assert.equal(active, 0);
      active++; maximum = Math.max(active, maximum);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return node.id;
    } });
    assert.equal(maximum, expected);
    assert.deepEqual(calls, ['group/agent/a', 'group/agent/b', 'after', 'independent']);
    assert.deepEqual(state.nodes.group.output, { a: 'group/agent/a', b: 'group/agent/b' });
  }
});

test('failed members settle before independent work and successful checkpoints survive retry', async () => {
  const workflow = agentGroup(), storage = memoryStorage();
  let active = 0;
  const first = await core.runWorkflow({ workflow, storage, concurrency: 8, executor: async node => {
    if (node.id === 'group/agent/a') throw new Error('member failed');
    if (node.id === 'group/agent/b') {
      active++; await new Promise(resolve => setTimeout(resolve, 10)); active--; return 'saved';
    }
    assert.equal(active, 0); return 'independent';
  } });
  assert.equal(first.nodes['group/agent/a'].status, 'failed');
  assert.equal(first.nodes['group/agent/b'].status, 'completed');
  assert.equal(first.nodes.group.status, 'blocked');
  assert.equal(first.nodes.after.status, 'blocked');
  assert.equal(first.nodes.independent.status, 'completed');
  const calls = [];
  const second = await core.runWorkflow({ workflow, storage, concurrency: 8, executor: async node => { calls.push(node.id); return 'new'; } });
  assert.deepEqual(calls, ['group/agent/a', 'after']);
  assert.equal(second.nodes['group/agent/b'].reused, true);
  assert.deepEqual(second.nodes.group.output, { a: 'new', b: 'saved' });
});

test('agent group cancellation preserves completed members and resumes only verified interrupted identities', async () => {
  const workflow = agentGroup(), storage = memoryStorage(), controller = new AbortController(), entered = deferred(), late = deferred();
  const running = core.runWorkflow({ workflow, storage, concurrency: 1, signal: controller.signal, executor: async node => {
    if (node.id === 'group/agent/a') return 'saved';
    entered.resolve(); return late.promise;
  } });
  await entered.promise; controller.abort();
  late.resolve('late');
  const interrupted = await running;
  assert.equal(interrupted.nodes['group/agent/a'].status, 'completed');
  assert.equal(interrupted.nodes['group/agent/b'].status, 'interrupted');
  assert.equal(interrupted.nodes.group.status, 'pending');
  const calls = [];
  const resumed = await core.runWorkflow({ workflow, storage, resumeNodeIds: ['group/agent/b'], executor: async node => { calls.push(node.id); return 'new'; } });
  assert.deepEqual(calls, ['group/agent/b', 'after', 'independent']);
  assert.deepEqual(resumed.nodes.group.output, { a: 'saved', b: 'new' });
  late.resolve('late'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await storage.load(), resumed);
});

test('rejects invalid agent group configuration, structural fields, IDs and schemas', () => {
  const changes = [
    group => { group.agents = []; },
    group => { group.agentId = 'x'; },
    group => { group.role = 'x'; },
    group => { group.reviewLoop = { review: { agentId: 'r', prompt: 'r' }, fix: { agentId: 'f', prompt: 'f' } }; },
    group => { group.agents[1].id = 'a'; },
    group => { group.agents[1].agentId = 'alice'; },
    ...[0, 9, 1.2, null].map(value => group => { group.agentConcurrency = value; }),
    ...['deps', 'agents', 'reviewLoop', 'agentStep', 'reviewStep'].map(field => group => { group.agents[0][field] = []; }),
    group => { group.schema = { type: 'object' }; group.agents[0].schema = { type: 'string' }; },
  ];
  for (const change of changes) {
    const workflow = agentGroup(); change(workflow.nodes[0]);
    assert.throws(() => core.validateWorkflow(workflow));
  }
  const collision = agentGroup(); collision.nodes.push({ id: 'group/agent/a' });
  assert.throws(() => core.validateWorkflow(collision), /collision/i);
});

test('a review loop remains one logical node before unrelated ready work', async () => {
  const workflow = reviewWorkflow(2);
  workflow.nodes.splice(2, 0, { id: 'independent' });
  const calls = [];
  const result = await core.runWorkflow({ workflow, storage: memoryStorage(), concurrency: 8, executor: async node => {
    calls.push(node.id);
    return node.reviewStep?.kind === 'review' ? (node.reviewStep.round === 1 ? changeReport : approvedReport) : 'done';
  } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['implement', 'q/review/1', 'q/fix/1', 'q/review/2', 'independent', 'after']);
});

test('group validation rejects malformed dependencies and generated metadata', () => {
  for (const deps of ['', 'x', ['x', 'x'], 1, null, {}]) {
    const workflow = agentGroup();
    workflow.nodes[0].deps = deps; workflow.nodes.push({ id: 'x' });
    assert.throws(() => core.validateWorkflow(workflow), /dependencies/i);
  }
  for (const value of [null, {}, { groupId: 'group', kind: 'collect', members: [] }]) {
    assert.throws(() => core.validateWorkflow({ id: 'invalid-metadata', nodes: [{ id: 'group', agentStep: value }] }), /agentStep|agentConcurrency/i);
  }
});

test('validates group and member role tools titles and schema defaults without silent overrides', () => {
  for (const patch of [{ role: 'missing' }, { tools: ['read', 'read'] }, { agentTitle: 5 }, { agentId: '' }]) {
    const workflow = agentGroup(); Object.assign(workflow.nodes[0].agents[0], patch);
    assert.throws(() => core.validateWorkflow(workflow));
  }
  const invalid = agentGroup(); invalid.nodes[0].tools = 'invalid';
  for (const member of invalid.nodes[0].agents) member.tools = [];
  assert.throws(() => core.validateWorkflow(invalid), /tools/i);
  const workflow = agentGroup(); workflow.nodes[0].schema = { type: 'object' };
  workflow.nodes[0].agents[0].schema = { type: 'object' };
  const result = core.validateWorkflow(workflow);
  assert.deepEqual(result.nodes[0].schema, { type: 'object' });
  assert.deepEqual(result.nodes[1].schema, { type: 'object' });
});

test('review templates reject nested groups and agent step metadata', () => {
  for (const kind of ['review', 'fix']) {
    for (const field of ['agents', 'agentStep', 'agentConcurrency']) {
      const workflow = reviewWorkflow();
      workflow.nodes[1].reviewLoop[kind][field] = [];
      assert.throws(() => core.validateWorkflow(workflow), /template field/);
    }
  }
});

test('logical group scheduling uses stable topology without adding unrelated dependencies', async () => {
  const workflow = agentGroup();
  workflow.nodes[0].deps = ['input'];
  workflow.nodes.splice(2, 0, { id: 'input' });
  const calls = [], contexts = {};
  const first = await core.runWorkflow({ workflow, storage: memoryStorage(), concurrency: 8, executor: async (node, context) => {
    calls.push(node.id); contexts[node.id] = Object.keys(context.dependencies); return node.id;
  } });
  assert.equal(first.status, 'completed');
  assert.deepEqual(calls, ['input', 'group/agent/a', 'group/agent/b', 'after', 'independent']);
  assert.deepEqual(contexts['group/agent/a'], ['input']);
  assert.deepEqual(contexts.independent, []);
});

test('changing one member preserves independent sibling checkpoints and pure collect resume', async () => {
  const workflow = agentGroup(), storage = memoryStorage(), calls = [];
  const executor = async node => { calls.push(node.id); return node.prompt ?? node.id; };
  await core.runWorkflow({ workflow, storage, concurrency: 8, executor });
  calls.length = 0;
  workflow.nodes[0].agents[0].prompt = 'changed';
  const next = await core.runWorkflow({ workflow, storage, concurrency: 8, executor });
  assert.deepEqual(calls, ['group/agent/a', 'after']);
  assert.equal(next.nodes['group/agent/b'].reused, true);
  const snapshot = await storage.load(); snapshot.nodes.group.status = 'running';
  delete snapshot.nodes.group.output; delete snapshot.nodes.group.outputHash;
  await storage.save(snapshot);
  calls.length = 0;
  const resumed = await core.runWorkflow({ workflow, storage, executor });
  assert.deepEqual(calls, []);
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.nodes.group.output, { a: 'changed', b: 'B' });
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
