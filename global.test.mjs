import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessage, routerInstruction, isRootAgent } from './global.mjs';

test('classifies a parent message with the current session model and parses JSON', async () => {
  const calls = [];
  const llm = { async *stream(options) { calls.push(options); yield { type: 'text-delta', text: '{"action":"revise","reason":"new acceptance criteria"}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const result = await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, message: 'Add an English deliverable', signal: new AbortController().signal });
  assert.deepEqual(result, { action: 'revise', reason: 'new acceptance criteria' });
  assert.equal(calls[0].provider, 'p');
  assert.equal(calls[0].model, 'm');
  assert.equal(calls[0].purpose, undefined);
});

test('does not duplicate final text blocks after streamed deltas', async () => {
  const text = '{"action":"create"}';
  const llm = { async *stream() {
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  assert.deepEqual(await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, message: 'task' }), { action: 'create' });
});

test('falls back to direct handling when classifier output is invalid', async () => {
  const llm = { async *stream() { yield { type: 'text-delta', text: 'not json' }; } };
  assert.deepEqual(await classifyMessage({ llm, config: { provider: 'p', model: 'm' }, message: 'hello' }), { action: 'direct' });
});

test('builds a bounded instruction for creating or revising a workflow', () => {
  assert.match(routerInstruction({ action: 'create' }, { message: 'task' }), /dynamic_workflow/);
  assert.match(routerInstruction({ action: 'revise', reason: 'changed goal' }, { runId: 'r1', path: 'flow.json', message: 'new' }), /r1/);
});

test('recognizes only root agents as global router owners', () => {
  assert.equal(isRootAgent({ id: 'root', session: { header: {} } }), true);
  assert.equal(isRootAgent({ id: 'child', session: { header: { parentSession: 'root' } } }), false);
});
