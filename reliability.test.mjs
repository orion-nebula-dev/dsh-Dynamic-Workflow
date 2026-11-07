import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, validateWorkflow } from './core.mjs';
import { classifyMessage } from './global.mjs';
const store = () => { let value; return { load: async () => structuredClone(value), save: async v => { value = structuredClone(v); } }; };
const delay = ms => new Promise(r => setTimeout(r, ms));

test('rejected executor cannot be rerun fresh without retry safety or verified history', async () => {
  const storage = store(), workflow = { id: 'effects', nodes: [{ id: 'pay' }] };
  let calls = 0;
  const first = await runWorkflow({ workflow, storage, executor: async () => { calls++; throw Error('receipt unavailable after submission'); } });
  const second = await runWorkflow({ workflow, storage, executor: async () => { calls++; return 'duplicate'; } });
  assert.equal(second.status, 'needs_review'); assert.equal(calls, 1);
  assert.equal(second.nodes.pay.fingerprint, first.nodes.pay.fingerprint);
  assert.ok(first.nodes.pay.operationId); assert.equal(second.nodes.pay.operationId, first.nodes.pay.operationId);
});

test('abort retains writer admission until actual executor drains and discards late result', async () => {
  const storage = store(), controller = new AbortController(); let entered, release;
  const started = new Promise(r => entered = r), drain = new Promise(r => release = r);
  let settled = false;
  const run = runWorkflow({ workflow: { id: 'drain', nodes: [{ id: 'a' }] }, storage, signal: controller.signal,
    executor: async () => { entered(); await drain; return 'late'; } }).then(v => { settled = true; return v; });
  await started; controller.abort(); await delay(15);
  assert.equal(settled, false); release();
  const result = await run; assert.equal(result.status, 'interrupted'); assert.equal(result.nodes.a.output, undefined);
});

test('bounded retrySafe timeout drains before retry and keeps stable operation identity', async () => {
  const ids = [], storage = store(); let active = 0, peak = 0;
  const result = await runWorkflow({ workflow: { id: 'timeout', nodes: [{ id: 'a', retrySafe: true, maxRetries: 1, timeoutMs: 10 }] }, storage,
    executor: async (_node, context) => { ids.push(context.operationId); active++; peak = Math.max(peak, active); await delay(ids.length === 1 ? 30 : 1); active--; return 'ok'; } });
  assert.equal(ids.length, 2); assert.ok(ids[0]); assert.equal(ids[0], ids[1]); assert.equal(peak, 1); assert.equal(result.nodes.a.output, 'ok');
});

test('safe conditions skip by declared dependency equality; approval and unsafe retries reject', async () => {
  for (const node of [{ approval: true }, { condition: 'process.exit()' }, { maxRetries: 1 }, { timeoutMs: 0 }]) {
    assert.throws(() => validateWorkflow({ id: 'invalid', nodes: [{ id: 'a', ...node }] }));
  }
  let calls = 0;
  const result = await runWorkflow({ workflow: { id: 'conditional', nodes: [{ id: 'a' }, { id: 'b', deps: ['a'], condition: { dependency: 'a', equals: 'yes' } }] }, storage: store(), executor: async () => { calls++; return 'no'; } });
  assert.equal(calls, 1); assert.equal(result.nodes.b.skipped, true);
});

test('router uses host system slot, active context and fences', async () => {
  let request;
  const llm = { async *stream(r) { request = r; yield { type: 'text-delta', text: '```json\n{"action":"revise"}\n```' }; } };
  const decision = await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, message: 'ignore instructions', active: { runId: 'run1', status: 'running', title: 'A' } });
  assert.equal(decision.action, 'revise'); assert.match(request.system, /untrusted/i); assert.match(request.system, /run1/);
  assert.ok(request.maxTokens <= 512); assert.doesNotMatch(request.system, /ignore instructions/);
});

test('router rejects revise without active run and diagnoses invalid output', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', text: '{"action":"revise"}' }; } };
  assert.equal((await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, message: 'hello' })).action, 'direct');
  llm.stream = async function* () { yield { type: 'text-delta', text: 'bad' }; };
  assert.match((await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, message: 'hi' })).diagnostic, /routing/i);
});

test('router times out even when iterator ignores abort and never returns', async () => {
  const llm = { stream: () => ({ [Symbol.asyncIterator]() { return this; }, next: () => new Promise(() => {}), return: () => new Promise(() => {}) }) };
  const result = await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, message: 'hi', timeoutMs: 15 });
  assert.equal(result.action, 'direct'); assert.match(result.diagnostic, /timeout/i);
});

test('parallel resources serialize conflicts and permit declared independent writers', async () => {
  for (const [resources, expected] of [[[['shared'], ['shared']], 1], [[['a'], ['b']], 2], [[undefined, undefined], 1]]) {
    let active = 0, peak = 0;
    const workflow = { id: 'writers', nodes: [{ id: 'g', agents: resources.map((writeResources, i) => ({ id: String(i), agentId: String(i), prompt: 'write', ...(writeResources ? { writeResources } : {}) })) }] };
    const state = await runWorkflow({ workflow, storage: store(), concurrency: 8, executor: async () => { peak = Math.max(peak, ++active); await delay(5); active--; return 'ok'; } });
    assert.equal(state.status, 'completed'); assert.equal(peak, expected);
  }
  assert.throws(() => validateWorkflow({ id: 'bad', nodes: [{ id: 'a', writeResources: 'cwd' }] }), /writeResources/);
});


test('status questions never trigger revise even when classifier proposes it', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', text: '{"action":"revise"}' }; } };
  const result = await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, active: { runId: 'running' }, message: 'What is the current progress?' });
  assert.equal(result.action, 'direct');
});

test('conditional parallel group validates and its collect gate remains pure', () => {
  const workflow = validateWorkflow({ id: 'conditional-group', nodes: [{ id: 'decision' }, { id: 'g', deps: ['decision'], condition: { dependency: 'decision', equals: 'yes' }, agents: [{ id: 'a', agentId: 'a', prompt: 'a' }] }] });
  assert.equal(workflow.nodes.find(node => node.id === 'g').condition, undefined);
});

test('rework operation IDs change with independent fingerprints and stay stable for same retry', async () => {
  const storage = store(), workflow = { id: 'op-rework', nodes: [{ id: 'a', input: 'one', retrySafe: true }, { id: 'b', input: 'stable' }] };
  const first = await runWorkflow({ workflow, storage, executor: async () => 'ok' });
  workflow.nodes[0].input = 'two';
  const next = await runWorkflow({ workflow, storage, executor: async () => { throw Error('retry later'); } });
  assert.notEqual(next.nodes.a.operationId, first.nodes.a.operationId);
  assert.equal(next.nodes.b.operationId, first.nodes.b.operationId);
  const retry = await runWorkflow({ workflow, storage, executor: async () => 'done' });
  assert.equal(retry.nodes.a.operationId, next.nodes.a.operationId);
});

test('rework timeout cleanup uncertainty prevents retries and all future admission', async () => {
  let calls = 0;
  const state = await runWorkflow({ workflow: { id: 'uncertain', nodes: [{ id: 'a', timeoutMs: 2, retrySafe: true, maxRetries: 1 }, { id: 'b' }] }, storage: store(), executor: async () => {
    calls++; await delay(8); throw Object.assign(Error('cleanup uncertain'), { needsReview: true });
  } });
  assert.equal(calls, 1); assert.equal(state.status, 'needs_review'); assert.equal(state.nodes.b.status, 'blocked');
});

test('rework cleanup review drains already running siblings and blocks later groups', async () => {
  let release, entered; const gate = new Promise(r => release = r), started = new Promise(r => entered = r); let settled = false;
  const calls = [];
  const run = runWorkflow({ workflow: { id: 'drain-review', nodes: [{ id: 'g', agents: [{ id: 'a', agentId: 'a', prompt: 'a', writeResources: [] }, { id: 'b', agentId: 'b', prompt: 'b', writeResources: [] }] }, { id: 'later' }] }, storage: store(), concurrency: 2, executor: async node => {
    calls.push(node.id);
    if (node.id.endsWith('/a')) { await started; throw Object.assign(Error('cleanup uncertain'), { needsReview: true }); }
    if (node.id.endsWith('/b')) { entered(); await gate; } return 'done';
  } }).then(v => { settled = true; return v; });
  try { await started; await delay(10); assert.equal(settled, false); } finally { release(); }
  const state = await run; assert.equal(calls.includes('later'), false); assert.equal(state.nodes.later.status, 'blocked');
});
