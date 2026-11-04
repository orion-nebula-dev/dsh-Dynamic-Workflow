import test from 'node:test';
import assert from 'node:assert/strict';

import { continueNodeSession, installNodeRole } from './continuation.mjs';

function bus() {
  const listeners = new Map(), sections = new Map(), restrictions = new Set(), guards = new Set(), effects = new Set();
  const names = ['read', 'write', 'search'];
  let presentation = 'ptc';
  return {
    systemPrompt: {
      section(section) {
        if (sections.has(section.name)) throw new Error('duplicate section');
        sections.set(section.name, section);
        return () => sections.delete(section.name);
      },
    },
    presentation() { return presentation; },
    tools: {
      presentAs(mode) { const previous = presentation; presentation = mode; return () => { presentation = previous; }; },
      restrict(filter) {
        assert.ok(Array.isArray(filter.allow));
        for (const name of filter.allow) if (!names.includes(name)) throw new Error(`unknown tool ${name}`);
        restrictions.add(filter);
        return () => restrictions.delete(filter);
      },
      guard(fn) { guards.add(fn); return () => guards.delete(fn); },
    },
    roleText() { return [...sections.values()].map(section => section.text); },
    availableTools() { return names.filter(name => [...restrictions].every(filter => filter.allow.includes(name))); },
    denied(name) { return [...guards].some(guard => guard({ name }) !== undefined); },
    registrations() { return sections.size + restrictions.size + guards.size; },
    on(name, fn) { const set = listeners.get(name) || new Set(); listeners.set(name, set); set.add(fn); return () => set.delete(fn); },
    effect(fn) {
      const off = fn();
      let active = true;
      const dispose = () => { if (active) { active = false; effects.delete(dispose); off(); } };
      effects.add(dispose);
      return dispose;
    },
    disposeEffects() { for (const off of [...effects]) off(); },
    async emit(name, ...args) { for (const fn of [...listeners.get(name) || []]) await fn(...args); },
    async waterfall(name, initial, ...args) {
      const handlers = [...listeners.get(name) || []];
      const next = i => i === handlers.length ? Promise.resolve(initial) : handlers[i](initial, ...args, () => next(i + 1));
      return next(0);
    },
    count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
  };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ live = false, running = false, sendGate, drainGate, fast = false, sendError, drainError } = {}) {
  const ctx = bus(), owner = { id: 'parent' }, child = { id: 'persisted-child', status: running ? 'running' : 'idle', ctx: bus() };
  const other = { id: 'other', status: 'idle', ctx: bus() };
  const history = ['previous user task', 'interrupted tool operation'];
  const calls = [];
  const subagents = {
    async sendMessage(sender, id, blocks, options) {
      calls.push(['send', sender, id, options.signal]);
      assert.equal(id, 'persisted-child');
      if (!live) await ctx.emit('agent/created', { agent: other, source: 'resume' });
      if (!live) await ctx.emit('agent/created', { agent: child, source: 'resume' });
      if (sendGate) await sendGate.promise;
      if (sendError) throw sendError;
      history.push(...blocks.map(b => b.text));
      if (fast) await end();
      return 'message-2';
    },
    interrupt(id, authority) { calls.push(['interrupt', id, authority]); },
    async drainChildren(parent, ids) { calls.push(['drain', parent, ids]); if (drainGate) await drainGate.promise; if (drainError) throw drainError; },
  };
  function end(text = 'finished', stopReason = 'completed', id = child.id) {
    return ctx.emit('subagent/end', { id, runId: 'activation-2', provider: 'local', local: true, stopReason, lastAssistantMessage: [{ type: 'reasoning', text: 'private' }, { type: 'text', text }] });
  }
  const args = { ctx, owner, childId: child.id, prompt: 'finish current work', subagents, agents: { get: id => live && id === child.id ? child : undefined } };
  return { ctx, child, other, owner, args, calls, history, end, run: extra => continueNodeSession({ ...args, ...extra }) };
}

test('cold resumes the same durable child and appends continuation instructions to its history', async () => {
  const f = fixture({ fast: true });
  const run = f.run({ selection: { provider: 'new-provider', model: 'new-model' } });
  assert.equal(typeof run.then, 'undefined');
  assert.deepEqual(await run.result, { stopReason: 'completed', value: 'finished' });
  assert.equal(f.calls[0][1], f.owner);
  assert.deepEqual(f.history.slice(0, 2), ['previous user task', 'interrupted tool operation']);
  assert.match(f.history[2], /new-provider/); assert.match(f.history[2], /new-model/);
  assert.match(f.history[2], /历史/); assert.match(f.history[2], /核实/); assert.match(f.history[2], /重复/);
  assert.ok(f.history[2].endsWith('finish current work'));
  assert.equal(f.ctx.count() + f.child.ctx.count() + f.other.ctx.count(), 0);
  await run.dispose(); assert.equal(f.calls.length, 1);
});

test('rejects a running target without sending or installing model hooks', async () => {
  const f = fixture({ live: true, running: true }); const run = f.run();
  assert.equal((await run.result).stopReason, 'error');
  assert.equal(f.calls.length, 0); assert.equal(f.ctx.count() + f.child.ctx.count(), 0);
});

test('scopes route overrides to the target, preserves controls and drops reasoning only on route changes', async () => {
  const f = fixture(); const run = f.run({ selection: { model: 'new-model' } }); await tick();
  const config = { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high', temperature: 0.2, maxTokens: 123, stop: ['END'] };
  assert.deepEqual(await f.child.ctx.waterfall('agent/request', config), { provider: 'old-provider', model: 'new-model', temperature: 0.2, maxTokens: 123, stop: ['END'] });
  assert.deepEqual(await f.other.ctx.waterfall('agent/request', config), config);
  const unchanged = { ...config, model: 'new-model' };
  assert.deepEqual(await f.child.ctx.waterfall('agent/request', unchanged), unchanged);
  const assembly = { sections: ['section'], contexts: ['context'], tools: ['tool'], variables: { provider: 'old-provider', model: 'old-model', extra: 'keep' } };
  assert.deepEqual(await f.child.ctx.waterfall('system-prompt/assemble', assembly, {}), { ...assembly, variables: { provider: 'old-provider', model: 'new-model', extra: 'keep' } });
  await f.end(); await run.result; assert.equal(f.ctx.count() + f.child.ctx.count(), 0);
});

test('installs overrides on an already idle child and ignores unrelated end events', async () => {
  const f = fixture({ live: true }); const run = f.run({ selection: { provider: 'chosen' } }); await tick();
  assert.equal((await f.child.ctx.waterfall('agent/request', { provider: 'old', model: 'm' })).provider, 'chosen');
  let settled = false; run.result.then(() => { settled = true; });
  await f.end('unrelated', 'completed', 'other'); await tick(); assert.equal(settled, false);
  await f.end(); await run.result;
});

test('abort after acceptance interrupts with ancestor authority and waits for asynchronous drain', async () => {
  const drainGate = deferred(), controller = new AbortController(); const f = fixture({ drainGate });
  const run = f.run({ signal: controller.signal }); await tick(); controller.abort(); await tick();
  assert.deepEqual(f.calls.slice(1), [['interrupt', f.child.id, { kind: 'ancestor', agent: f.owner }], ['drain', f.owner, [f.child.id]]]);
  let settled = false; run.result.then(() => { settled = true; }); const disposed = run.dispose();
  await f.end('', 'aborted'); await tick(); assert.equal(settled, false);
  drainGate.resolve(); await disposed; assert.deepEqual(await run.result, { stopReason: 'cancelled' });
  assert.equal(f.ctx.count() + f.child.ctx.count(), 0);
});

test('startup cancellation waits for send acceptance then interrupts and drains the newly materialized child', async () => {
  const sendGate = deferred(), drainGate = deferred(); const f = fixture({ sendGate, drainGate });
  const run = f.run(); await tick(); run.cancel('stop'); const disposed = run.dispose();
  let cleaned = false; disposed.then(() => { cleaned = true; }); await tick(); assert.equal(cleaned, false);
  sendGate.resolve(); await tick(); assert.equal(f.calls[1][0], 'interrupt'); assert.equal(f.calls[2][0], 'drain');
  await tick(); assert.equal(cleaned, false); drainGate.resolve(); await disposed;
  assert.deepEqual(await run.result, { stopReason: 'cancelled' });
  assert.equal(f.ctx.count() + f.child.ctx.count(), 0);
});

test('pre-aborted signals never deliver work', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture(); const run = f.run({ signal: controller.signal });
  assert.deepEqual(await run.result, { stopReason: 'cancelled' }); assert.equal(f.calls.length, 0); await run.dispose();
});

test('dispose after natural completion never cancels a later activation with the same child id', async () => {
  const f = fixture(); const run = f.run(); await tick(); await f.end(); await run.result;
  f.child.status = 'running'; run.cancel(); await run.dispose(); assert.equal(f.calls.length, 1);
});

const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false };
for (const [name, text, want] of [
  ['fenced JSON', '```json\n{"count":3}\n```', { stopReason: 'completed', value: { count: 3 } }],
  ['malformed JSON', 'not JSON', { stopReason: 'error' }],
  ['schema mismatch', '{"count":"three"}', { stopReason: 'error' }],
]) test(`structured completion validates ${name}`, async () => {
  const f = fixture(); const run = f.run({ schema }); await tick();
  assert.match(f.history[2], /JSON/); assert.match(f.history[2], /"count"/);
  await f.end(text); const result = await run.result;
  if (want.value) assert.deepEqual(result, want); else { assert.equal(result.stopReason, 'error'); assert.equal(typeof result.error, 'string'); }
  assert.equal(f.ctx.count() + f.child.ctx.count(), 0);
});

test('send failures become result errors and remove installed hooks', async () => {
  const f = fixture({ sendError: new Error('admission failed') }); const run = f.run();
  assert.deepEqual(await run.result, { stopReason: 'error', error: 'admission failed' }); await run.dispose();
  assert.equal(f.ctx.count() + f.child.ctx.count(), 0);
});

test('model failure is an ordinary result error', async () => {
  const f = fixture(); const run = f.run(); await tick(); await f.end('model failed', 'error');
  assert.equal((await run.result).stopReason, 'error'); await run.dispose();
});

test('an explicit stage tool policy uses native tools instead of an inaccessible PTC transport', () => {
  const f = fixture();
  const off = installNodeRole(f.ctx, f.child, { tools: ['read'] });
  assert.equal(f.child.ctx.presentation(), 'native');
  assert.equal(f.ctx.presentation(), 'ptc');
  off();
  assert.equal(f.child.ctx.presentation(), 'ptc');
});

test('role helper replaces the active system section and old disposers cannot clear the new phase', () => {
  const f = fixture();
  const first = installNodeRole(f.ctx, f.child, { prompt: 'Research role', tools: [] });
  assert.deepEqual(f.child.ctx.roleText(), ['Research role']);
  assert.deepEqual(f.child.ctx.availableTools(), []);
  const second = installNodeRole(f.ctx, f.child, { prompt: 'Review role', tools: ['read'] });
  first(); first();
  assert.deepEqual(f.child.ctx.roleText(), ['Review role']);
  assert.deepEqual(f.child.ctx.availableTools(), ['read']);
  second(); second();
  assert.deepEqual(f.child.ctx.roleText(), []);
  assert.deepEqual(f.child.ctx.availableTools(), ['read', 'write', 'search']);
  assert.equal(f.child.ctx.registrations(), 0);
});

for (const [label, role, expected] of [
  ['omitted tools', { prompt: 'Current role' }, ['read', 'write', 'search']],
  ['empty tools', { prompt: 'Current role', tools: [] }, []],
  ['subset tools', { prompt: 'Current role', tools: ['read', 'search'] }, ['read', 'search']],
]) test(`role helper scopes ${label} to its child and blocks out-of-policy local tools`, () => {
  const f = fixture();
  const off = installNodeRole(f.ctx, f.child, role);
  assert.deepEqual(f.child.ctx.availableTools(), expected);
  assert.equal(f.child.ctx.denied('write'), role.tools !== undefined);
  assert.equal(f.child.ctx.denied('scope-local'), role.tools !== undefined);
  assert.deepEqual(f.ctx.roleText(), []);
  assert.deepEqual(f.other.ctx.roleText(), []);
  assert.deepEqual(f.ctx.availableTools(), ['read', 'write', 'search']);
  assert.deepEqual(f.other.ctx.availableTools(), ['read', 'write', 'search']);
  off();
  assert.equal(f.child.ctx.registrations(), 0);
});

for (const live of [false, true]) test(`role is installed before ${live ? 'live' : 'cold'} request admission and restored on native end`, async () => {
  const gate = deferred(), f = fixture({ live, sendGate: gate });
  const run = f.run({ role: { prompt: 'Activation only', tools: [] } });
  await tick();
  assert.deepEqual(f.child.ctx.roleText(), ['Activation only']);
  assert.deepEqual(f.child.ctx.availableTools(), []);
  assert.equal(f.child.ctx.denied('run_code'), true);
  gate.resolve(); await tick();
  await f.end();
  assert.deepEqual(f.child.ctx.roleText(), []);
  assert.deepEqual(f.child.ctx.availableTools(), ['read', 'write', 'search']);
  assert.equal((await run.result).stopReason, 'completed');
  assert.equal(f.child.ctx.registrations(), 0);
  const next = f.run({ role: { prompt: 'Next phase' } }); await tick();
  assert.deepEqual(f.child.ctx.roleText(), ['Next phase']);
  assert.deepEqual(f.child.ctx.availableTools(), ['read', 'write', 'search']);
  await f.end(); await next.result;
});

test('partial role installation failures unwind sections and deny policies before admission', async () => {
  const f = fixture({ live: true });
  const run = f.run({ role: { prompt: 'Invalid phase', tools: ['missing'] } });
  assert.equal((await run.result).stopReason, 'error');
  assert.equal(f.calls.length, 0);
  assert.equal(f.child.ctx.registrations(), 0);
  assert.deepEqual(f.child.ctx.roleText(), []);
});

for (const scope of ['plugin', 'child']) test(`${scope} teardown removes its owned role registrations`, () => {
  const f = fixture();
  const off = installNodeRole(f.ctx, f.child, { prompt: 'Owned activation', tools: [] });
  (scope === 'plugin' ? f.ctx : f.child.ctx).disposeEffects();
  assert.equal(f.child.ctx.registrations(), 0);
  const next = installNodeRole(f.ctx, f.child, { prompt: 'Replacement' });
  off();
  assert.deepEqual(f.child.ctx.roleText(), ['Replacement']);
  next();
});

test('failure to install the tool guard unwinds the prompt and global restriction', () => {
  const f = fixture();
  f.child.ctx.tools.guard = () => { throw new Error('guard failed'); };
  assert.throws(() => installNodeRole(f.ctx, f.child, { prompt: 'Temporary', tools: [] }), /guard failed/);
  assert.equal(f.child.ctx.registrations(), 0);
});

test('send failure removes role registrations', async () => {
  const f = fixture({ sendError: new Error('admission failed') });
  const run = f.run({ role: { prompt: 'Temporary', tools: [] } });
  assert.equal((await run.result).stopReason, 'error');
  assert.equal(f.child.ctx.registrations(), 0);
});

test('cancellation retains the role until native work drains and then restores it', async () => {
  const gate = deferred(), f = fixture({ drainGate: gate });
  const run = f.run({ role: { prompt: 'Temporary', tools: [] } }); await tick();
  const disposal = run.dispose(); await tick();
  assert.deepEqual(f.child.ctx.availableTools(), []);
  gate.resolve(); await disposal;
  assert.equal(f.child.ctx.registrations(), 0);
  assert.deepEqual(f.child.ctx.availableTools(), ['read', 'write', 'search']);
});

test('cleanup failure rejects dispose while result remains handled', async () => {
  const f = fixture({ drainError: new Error('drain failed') }); const run = f.run(); await tick();
  await assert.rejects(run.dispose(), /drain failed/);
  assert.equal((await run.result).stopReason, 'error'); assert.equal(f.ctx.count() + f.child.ctx.count(), 0);
});
