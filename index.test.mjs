import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import vm from 'node:vm';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
// Optional existing local Zod copy for no-install test environments.
if (process.env.ZOD_TEST_MODULE) registerHooks({ resolve(specifier, context, next) {
  return next(specifier === 'zod' ? pathToFileURL(process.env.ZOD_TEST_MODULE).href : specifier, context);
} });

function durableStore() {
  const tables = new Map(); let opened = false;
  const store = { tables, async open(spec) {
    assert.equal(opened, false); opened = true;
    for (const [name, entry] of Object.entries(spec.tables)) {
      assert.equal(typeof entry.valueSchema.safeParse, 'function');
      if (!tables.has(name)) tables.set(name, new Map());
      for (const value of tables.get(name).values()) entry.valueSchema.parse(value);
    }
    return { table(name) {
      const data = tables.get(name), schema = spec.tables[name].valueSchema;
      return { get: key => structuredClone(data.get(key)), entries: () => structuredClone([...data]).values(),
        async put(key, value) { if (store.failWrites) throw new Error('storage offline'); data.set(key, structuredClone(schema.parse(value))); } };
    }, async close() { opened = false; } };
  } };
  return store;
}

async function fixture(t, execute = async prompt => ({ prompt }), onDispose = async () => {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dynamic-workflow-test-'));
  const effects = []; let tool; let command; const requests = []; let disposed = 0;
  const listeners = new Map(), catalog = new Map(), histories = new Map(), live = new Map(), continuations = [];
  function on(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); return () => listeners.get(name).delete(handler); }
  async function emit(name, ...args) { for (const handler of [...(listeners.get(name) || [])]) await handler(...args); }
  const policyActivations = [];
  function nativeChild(childId) {
    const childListeners = new Map(), policy = {};
    const child = { id: childId, status: 'idle', ctx: {
      effect: fn => fn(), on(name, handler) { childListeners.set(name, handler); return () => childListeners.delete(name); },
      systemPrompt: { section(spec) { policy.prompt = spec.text; return () => { delete policy.prompt; }; } },
      tools: {
        restrict(spec) { policy.tools = [...spec.allow]; return () => { delete policy.tools; }; },
        guard(handler) { policy.guard = handler; return () => { delete policy.guard; }; },
        presentAs() { return () => {}; },
      },
    } };
    return { child, childListeners, policy };
  }
  const subagents = {
    getProvider: name => name === 'spawn' ? { prepareContinuable: async () => ({}) } : undefined,
    async startActivation(spec) {
      const childId = spec.childId;
      const prompt = spec.request.prompt.map(part => part.text).join('\n');
      const request = { args: { prompt, options: spec.request.agentOptions }, meta: { name: spec.label } };
      requests.push(request);
      catalog.set(childId, { id: childId, mode: 'continuable', label: spec.label, createdAt: Date.now() });
      histories.set(childId, [prompt]);
      const { child, childListeners, policy } = nativeChild(childId);
      live.set(childId, child);
      await emit('agent/created', { agent: child, source: 'create' });
      const config = await childListeners.get('agent/request')({}, async () => ({ provider: 'old-provider', model: 'old-model' }));
      policyActivations.push({ childId, prompt: policy.prompt, tools: policy.tools && [...policy.tools] });
      const result = Promise.resolve().then(async () => {
        const value = await execute(prompt, config);
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        live.delete(childId);
        await emit('subagent/end', { id: childId, local: true, runId: `initial-${requests.length}`, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text }] });
        return { stopReason: 'completed', output: [{ type: 'text', text }] };
      });
      return { childId, messageId: 'initial-message', result, async dispose() { await result; } };
    },
    listChildren: async () => [...catalog.values()],
    async sendMessage(parent, childId, content) {
      assert.equal(parent, owner);
      assert.equal(catalog.get(childId)?.mode, 'continuable');
      const { child, childListeners, policy } = nativeChild(childId);
      live.set(childId, child);
      await emit('agent/created', { agent: child, source: 'resume' });
      const config = await childListeners.get('agent/request')({}, async () => ({ provider: 'old-provider', model: 'old-model' }));
      continuations.push({ childId, content, config });
      policyActivations.push({ childId, prompt: policy.prompt, tools: policy.tools && [...policy.tools] });
      histories.get(childId).push(content[0].text);
      live.delete(childId);
      await emit('subagent/end', { id: childId, local: true, runId: `continuation-${continuations.length}`, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: JSON.stringify({ model: config.model, seed: histories.get(childId)[0] }) }] });
      return 'accepted-message';
    },
    interrupt() {}, async drainChildren() {},
  };
  const fs = {
    async resolve(path, options = {}) { const p = await realpath(resolve(options.cwd || root, path)); return { targetKey: p, displayPath: p }; },
    contains(a, b) { const rel = relative(a.targetKey, b.targetKey); return !rel.startsWith('..') && !isAbsolute(rel); },
    readText(target) { return readFile(target.targetKey, 'utf8'); },
  };
  const engine = { start(request) {
    requests.push(request);
    if (options.native) {
      const childId = `child-${requests.length}`, runId = `w${requests.length}`;
      catalog.set(childId, { id: childId, mode: 'continuable', label: `${request.meta.name} child 1`, createdAt: Date.now() });
      histories.set(childId, [`original history for ${childId}`]);
      if (!options.omitChildEvent) queueMicrotask(() => emit('workflow/agent-start', { id: runId }, { seq: 1, label: request.args.options.label, childId }));
    }
    let cancel;
    const cancelled = new Promise(resolve => { cancel = () => resolve({ value: null, stopReason: 'cancelled', agentsStarted: 1 }); });
    const result = Promise.race([cancelled, (async () => {
      try {
        const script = new vm.Script(`(async () => { ${request.script} })()`);
        const value = await script.runInNewContext({ args: request.args, agent: execute });
        return { value, stopReason: 'completed', agentsStarted: 1 };
      } catch (error) { return { value: null, stopReason: 'error', error: error.message, agentsStarted: 1 }; }
    })()]);
    request.signal?.addEventListener('abort', cancel, { once: true });
    return { id: `w${requests.length}`, meta: request.meta, result, cancel, async dispose() { await result; await onDispose(); disposed++; } };
  } };
  const services = { fs, workingDirectory: { ensure: async () => root }, workflowEngine: engine,
    ...(options.native ? { subagents, agents: { get: id => live.get(id) } } : {}) };
  const owner = { id: 'owner', ctx: { get: key => services[key] } };
  const storageDomain = durableStore();
  const ctx = { storageDomain, commands: { register(value) { command = value; return () => { command = undefined; }; } }, tools: { register(value) { tool = value; return () => { tool = undefined; }; } }, effect(fn) { const off = fn(); effects.push(off); return off; }, ...(options.native ? { on } : {}) };
  const module = await import('./index.js').catch(error => error.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(error));
  assert.equal(typeof module.apply, 'function', 'Host plugin must export apply');
  await module.apply(ctx);
  t.after(async () => { for (const effect of effects.reverse()) await effect?.(); await rm(root, { recursive: true, force: true }); });
  return { root, owner, requests, storageDomain, services, native: { catalog, histories, continuations, live, policyActivations }, restart: () => module.apply(ctx), get disposed() { return disposed; },
    get command() { return command; },
    write: workflow => writeFile(join(root, 'flow.json'), JSON.stringify(workflow)),
    call: (args, agent = owner, signal = new AbortController().signal) => tool.execute(args, { agent, signal }),
    unload: async () => { for (const effect of effects.splice(0).reverse()) await effect?.(); },
  };
}
test('one capsule reuses its native Agent for successive stages', async t => {
  const f = await fixture(t, async () => 'stage completed', undefined, { native: true });
  await f.write({ id: 'capsules', nodes: [
    { id: 'plan', agentId: 'writer', prompt: 'Plan the task' },
    { id: 'deliver', agentId: 'writer', prompt: 'Deliver the task', deps: ['plan'] },
  ] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json', concurrency: 2 });
  const result = await finished(f, run.runId);
  assert.equal(result.status, 'completed');
  assert.equal(f.requests.length, 1, 'a later stage must not create another Agent');
  assert.equal(f.native.continuations.length, 1);
  assert.equal(result.nodes.plan.agentSessionId, result.nodes.deliver.agentSessionId);
  assert.equal(result.nodes.deliver.agentId, 'writer');
});

test('each stage installs its role prompt and tools before activating the same capsule Agent', async t => {
  const f = await fixture(t, async () => 'done', undefined, { native: true });
  await f.write({ id: 'stage-roles', agents: { worker: { title: 'Worker' } }, roles: {
    plan: { title: 'Planner', prompt: 'Plan the work', tools: ['read'] },
    review: { title: 'Reviewer', prompt: 'Review without tools', tools: [] },
    deliver: { title: 'Writer', prompt: 'Write the result', tools: ['write'] },
  }, nodes: [
    { id: 'a', agentId: 'worker', role: 'plan', prompt: 'First task' },
    { id: 'b', agentId: 'worker', role: 'review', prompt: 'Second task' },
    { id: 'c', agentId: 'worker', role: 'deliver', prompt: 'Third task' },
  ] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json', concurrency: 3 });
  const result = await finished(f, run.runId);
  assert.equal(result.status, 'completed');
  assert.equal(f.requests.length, 1);
  assert.equal(new Set(Object.values(result.nodes).map(node => node.agentSessionId)).size, 1);
  assert.deepEqual(f.native.policyActivations.map(({ prompt, tools }) => ({ prompt, tools })), [
    { prompt: 'Plan the work', tools: ['read'] }, { prompt: 'Review without tools', tools: [] }, { prompt: 'Write the result', tools: ['write'] },
  ]);
  assert.equal(result.nodes.c.roleTitle, 'Writer');
});

test('a capsule retains its Agent after plugin reload and a newly appended stage', async t => {
  const f = await fixture(t, async () => 'stage completed', undefined, { native: true });
  const first = { id: 'capsules', nodes: [{ id: 'plan', agentId: 'writer', prompt: 'Plan' }] };
  await f.write(first);
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  const original = await finished(f, run.runId);
  await f.unload(); await f.restart();
  await f.write({ ...first, nodes: [...first.nodes, { id: 'deliver', agentId: 'writer', prompt: 'Deliver', deps: ['plan'] }] });
  const next = await f.call({ action: 'run', workflowPath: 'flow.json' });
  const result = await finished(f, next.runId);
  assert.equal(result.status, 'completed');
  assert.equal(f.requests.length, 1);
  assert.equal(result.nodes.plan.reused, true);
  assert.equal(result.nodes.deliver.agentSessionId, original.nodes.plan.agentSessionId);
});

test('revise stops the source run, reads the new definition, and records the trigger', async t => {
  const f = await fixture(t, async prompt => prompt);
  await f.write({ id: 'revision-flow', nodes: [{ id: 'a', prompt: 'old' }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  await finished(f, first.runId);
  await f.write({ id: 'revision-flow', nodes: [{ id: 'a', prompt: 'new' }] });
  const revised = await f.call({ action: 'revise', runId: first.runId, workflowPath: 'flow.json', revisionReason: 'user changed acceptance criteria' });
  const result = await finished(f, revised.runId);
  assert.equal(result.status, 'completed');
  assert.equal(result.revisionReason, 'user changed acceptance criteria');
  assert.equal(result.resumedFrom, first.runId);
  assert.equal(f.requests.at(-1).args.prompt, 'new');
});

test('changed executed capsule history requires a fresh workflow identity', async t => {
  const f = await fixture(t, async () => 'done', undefined, { native: true });
  const original = { id: 'capsule-version-1', nodes: [{ id: 'a', agentId: 'worker', prompt: 'Original task' }] };
  await f.write(original);
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  const firstResult = await finished(f, first.runId);
  const changed = { ...original, nodes: [{ id: 'a', agentId: 'worker', prompt: 'Changed task' }] };
  await f.write(changed);
  const second = await f.call({ action: 'run', workflowPath: 'flow.json' });
  assert.equal((await finished(f, second.runId)).status, 'failed');
  const detail = await f.call({ action: 'status', runId: second.runId, nodeId: 'a' });
  assert.match(detail.node.error, /history differs/i);
  assert.equal(f.requests.length, 1);
  await f.write({ ...changed, id: 'capsule-version-2' });
  const fresh = await f.call({ action: 'run', workflowPath: 'flow.json' });
  const result = await finished(f, fresh.runId);
  assert.equal(result.status, 'completed');
  assert.equal(f.requests.length, 2);
  assert.notEqual(result.nodes.a.agentSessionId, firstResult.nodes.a.agentSessionId);
});

test('a missing saved capsule Agent fails instead of replacing it for the next stage', async t => {
  const f = await fixture(t, async () => 'stage completed', undefined, { native: true });
  const first = { id: 'capsules', nodes: [{ id: 'plan', agentId: 'writer', prompt: 'Plan' }] };
  await f.write(first);
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' }); await finished(f, run.runId);
  f.native.catalog.clear();
  await f.write({ ...first, nodes: [...first.nodes, { id: 'deliver', agentId: 'writer', prompt: 'Deliver', deps: ['plan'] }] });
  const next = await f.call({ action: 'run', workflowPath: 'flow.json' });
  const result = await finished(f, next.runId);
  assert.equal(result.status, 'failed');
  const detail = await f.call({ action: 'status', runId: next.runId, nodeId: 'deliver' });
  assert.match(detail.node.error, /unavailable|missing|continuable/i);
  assert.equal(f.requests.length, 1);
});

async function finished(f, id) {
  for (let i = 0; i < 100; i++) {
    const value = await f.call({ action: 'status', runId: id });
    if (!['running', 'stopping'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('run did not settle');
}

test('persists history across plugin restarts and scopes access to stable session ids', async t => {
  const f = await fixture(t);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  assert.equal((await finished(f, first.runId)).status, 'completed');
  await f.unload();
  await f.restart();
  const resumedOwner = { ...f.owner };
  assert.equal((await f.call({ action: 'status', runId: first.runId, nodeId: 'a' }, resumedOwner)).node.output.prompt, 'hello');
  const next = await f.call({ action: 'run', workflowPath: 'flow.json' }, resumedOwner);
  assert.equal((await finished(f, next.runId)).status, 'completed');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.call({ action: 'list' })).runs.length, 2);
  assert.equal((await f.call({ action: 'status', runId: first.runId })).status, 'completed');
});

test('rejects malformed persisted snapshots without replacing saved records', async t => {
  const f = await fixture(t);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  await finished(f, run.runId);
  await f.unload();
  const table = f.storageDomain.tables.get('runs');
  table.get(run.runId).snapshot = { version: 99 };
  await assert.rejects(f.restart(), /version|invalid|workflowId/i);
  assert.deepEqual(table.get(run.runId).snapshot, { version: 99 });
});

test('crash-left running metadata is discoverable but never restarts execution on inspection', async t => {
  const f = await fixture(t);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  await finished(f, run.runId);
  await f.unload();
  const saved = f.storageDomain.tables.get('runs').get(run.runId);
  saved.status = 'running'; saved.snapshot.nodes.a.status = 'running';
  await f.restart();
  assert.equal((await f.call({ action: 'list' })).runs[0].status, 'interrupted');
  assert.equal((await f.call({ action: 'status', runId: run.runId })).status, 'interrupted');
  assert.equal(f.requests.length, 1);
  const next = await f.call({ action: 'run', workflowPath: 'flow.json' });
  assert.equal((await finished(f, next.runId)).status, 'needs_review');
  assert.equal(f.requests.length, 1);
});

test('different sessions executing the same target cannot reuse or inspect each other outputs', async t => {
  const f = await fixture(t);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  await finished(f, first.runId);
  const other = { ...f.owner, id: 'other-session' };
  const second = await f.call({ action: 'run', workflowPath: 'flow.json' }, other);
  for (let i = 0; i < 100; i++) {
    if ((await f.call({ action: 'status', runId: second.runId }, other)).status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(f.requests.length, 2);
  await assert.rejects(f.call({ action: 'status', runId: first.runId }, other), /not found/);
  assert.equal((await f.call({ action: 'list' }, other)).runs.length, 1);
});

test('storage failure prevents agent side effects and remains visible through status', async t => {
  const f = await fixture(t);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  f.storageDomain.failWrites = true;
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  const result = await finished(f, run.runId);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /storage offline/);
  assert.equal(f.requests.length, 0);
});

test('simultaneous run calls for the same target admit exactly one execution', async t => {
  const f = await fixture(t, () => new Promise(() => {}));
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  const results = await Promise.allSettled([f.call({ action: 'run', workflowPath: 'flow.json' }), f.call({ action: 'run', workflowPath: './flow.json' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /already running/);
});

test('executes dependency outputs as data using the parent engine and reuses unchanged nodes', async t => {
  const f = await fixture(t, async prompt => prompt.includes('Dependencies:') ? { consumed: prompt } : { answer: 7 });
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'first' }, { id: 'b', deps: ['a'], prompt: 'second' }] });
  const start = await f.call({ action: 'run', workflowPath: 'flow.json' });
  assert.equal((await finished(f, start.runId)).status, 'completed');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].parent, f.owner);
  const output = await f.call({ action: 'status', runId: start.runId, nodeId: 'b' });
  assert.match(JSON.stringify(output), /answer/);
  assert.equal(f.disposed, 2);
  const repeat = await f.call({ action: 'run', workflowPath: 'flow.json' });
  assert.equal((await finished(f, repeat.runId)).status, 'completed');
  assert.equal(f.requests.length, 2);
});

test('rejects cross-session access, denied fs reads, arbitrary state paths and missing scoped engine', async t => {
  const f = await fixture(t);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  const other = { ...f.owner, id: 'other-session' };
  await assert.rejects(f.call({ action: 'status', runId: run.runId }, other), /not found|owner/i);
  assert.deepEqual((await f.call({ action: 'list' }, other)).runs, []);
  const denied = { id: 'denied', ctx: { get: key => key === 'fs' ? { ...f.owner.ctx.get(key), readText: async () => { throw new Error('FS policy denied'); } } : f.owner.ctx.get(key) } };
  await assert.rejects(f.call({ action: 'run', workflowPath: 'flow.json' }, denied), /FS policy denied/);
  await assert.rejects(f.call({ action: 'run', workflowPath: 'flow.json', statePath: '/tmp/owned' }), /statePath|unknown/i);
  await assert.rejects(f.call({ action: 'run', workflowPath: 'flow.json' }, { id: 'no-engine', ctx: { get: key => key === 'workflowEngine' ? undefined : f.owner.ctx.get(key) } }), /workflowEngine/i);
  await assert.rejects(f.call({ action: 'restart', runId: run.runId }), /restart|recover/i);
});

test('stop and unload cancel and drain active workflow handles', async t => {
  const f = await fixture(t, () => new Promise(() => {}));
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'wait', retrySafe: true }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(f.call({ action: 'run', workflowPath: 'flow.json' }), /already running/i);
  const stopped = await f.call({ action: 'stop', runId: run.runId });
  assert.equal(stopped.status, 'cancelled');
  assert.equal(f.disposed, 1);
  await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (f.requests.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  await f.unload();
  assert.equal(f.disposed, 2);
});

test('stop waits for asynchronous child disposal after core abort settles', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => new Promise(() => {}), () => gate);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'wait', retrySafe: true }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  let settled = false;
  const stopped = f.call({ action: 'stop', runId: run.runId }).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  try { assert.equal(settled, false, 'stop must await child cleanup'); }
  finally { release(); await stopped; }
  assert.equal(f.disposed, 1);
});

test('resume keeps saved definition and completed fingerprints while applying executor overrides', async t => {
  const f = await fixture(t, async (prompt, options) => {
    if (prompt.startsWith('second') && options.model !== 'new-model') throw new Error('switch model');
    return { prompt };
  });
  const definition = { id: 'flow', title: 'Saved title', nodes: [{ id: 'a', prompt: 'first', model: 'node-model' }, { id: 'b', prompt: 'second', deps: ['a'] }] };
  await f.write(definition);
  const first = await f.call({ action: 'run', workflowPath: 'flow.json', provider: 'old-provider', model: 'old-model' });
  assert.equal((await finished(f, first.runId)).status, 'failed');
  assert.equal(f.requests[0].args.options.model, 'old-model');
  await f.write({ id: 'changed', nodes: [] });
  await f.unload(); await f.restart();
  const resumed = await f.call({ action: 'resume', runId: first.runId, model: 'new-model', concurrency: 2 });
  const status = await finished(f, resumed.runId);
  assert.equal(status.status, 'completed');
  assert.equal(status.nodes.a.reused, true);
  assert.equal(status.resumedFrom, first.runId);
  assert.equal(status.title, 'Saved title');
  assert.equal(status.model, 'new-model');
  assert.equal(status.provider, 'old-provider');
  assert.equal(status.concurrency, 2);
  assert.equal(status.workflow.nodes[0].model, 'node-model');
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].args.options.model, 'new-model');
  const listed = (await f.call({ action: 'list' })).runs.find(run => run.runId === resumed.runId);
  assert.equal(listed.nodes.a.status, 'completed');
  assert.equal(listed.title, 'Saved title');
});

test('human command shares operations and reports JSON success or errors', async t => {
  const f = await fixture(t);
  assert.equal(f.command.name, 'workflow');
  const result = await f.command.handler({ agent: f.owner, rawInput: '{"action":"list"}', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.deepEqual(JSON.parse(result.text), { runs: [] });
  const bad = await f.command.handler({ agent: f.owner, rawInput: '{bad', signal: new AbortController().signal });
  assert.equal(bad.kind, 'error');
  assert.equal(typeof bad.text, 'string');
});

test('/workflow without arguments explains the human command syntax', async t => {
  const f = await fixture(t);
  const result = await f.command.handler({ agent: f.owner, rawInput: '', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /\/workflow run/);
  assert.match(result.text, /\/workflow resume/);
  assert.equal(f.requests.length, 0);
});

test('/workflow shorthand runs a file and queries its saved result', async t => {
  const f = await fixture(t, async () => 'done');
  await f.write({ id: 'short-command', nodes: [{ id: 'a', prompt: 'hello' }] });
  const invoke = rawInput => f.command.handler({ agent: f.owner, rawInput, signal: new AbortController().signal });
  const started = await invoke('run "flow.json"');
  assert.equal(started.kind, 'success');
  const run = JSON.parse(started.text);
  assert.equal((await finished(f, run.runId)).status, 'completed');
  const result = await invoke(`status ${run.runId}`);
  assert.equal(JSON.parse(result.text).status, 'completed');
  const listed = await invoke('list');
  assert.equal(JSON.parse(listed.text).runs[0].runId, run.runId);
  assert.equal((await invoke('run')).kind, 'error');
  assert.equal((await invoke('list unexpected')).kind, 'error');
});

test('resume drains running work and serializes simultaneous resume requests', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => new Promise(() => {}), () => gate);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'wait' }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  let settled = false;
  const attempts = Promise.allSettled([f.call({ action: 'resume', runId: first.runId }), f.call({ action: 'resume', runId: first.runId })]).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  try { assert.equal(settled, false); } finally { release(); }
  const results = await attempts;
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /already|progress/i);
  const resumed = results.find(r => r.status === 'fulfilled').value;
  assert.equal((await finished(f, resumed.runId)).status, 'needs_review');
  assert.equal(f.requests.length, 1);
});

test('models returns advertised provider choices and contains individual catalog failures', async t => {
  const f = await fixture(t);
  const owner = { id: f.owner.id, ctx: { get: key => key === 'llm' ? {
    listProviders: () => [{ id: 'one', name: 'One' }, { id: 'offline', name: 'Offline' }],
    listModels: async provider => { if (provider === 'offline') throw new Error('catalog offline'); return [{ provider: 'one', id: 'model-a', name: 'Model A' }]; },
  } : f.owner.ctx.get(key) } };
  assert.deepEqual(await f.call({ action: 'models' }, owner), { providers: [
    { id: 'one', name: 'One', models: [{ provider: 'one', id: 'model-a', name: 'Model A' }] },
    { id: 'offline', name: 'Offline', models: [], error: 'catalog offline' },
  ] });
});

test('legacy records remain inspectable and cannot resume without saved definitions', async t => {
  const f = await fixture(t);
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'hello' }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  await finished(f, run.runId); await f.unload();
  const saved = f.storageDomain.tables.get('runs').get(run.runId);
  for (const key of ['workflow', 'title', 'resumedFrom', 'model', 'provider', 'concurrency']) delete saved[key];
  await f.restart();
  assert.equal((await f.call({ action: 'status', runId: run.runId })).resumeSupported, false);
  await assert.rejects(f.call({ action: 'resume', runId: run.runId }), /definition.*unavailable/);
  assert.equal((await f.call({ action: 'list' })).runs[0].nodes.a.status, 'completed');
});

test('resume retries interrupted nodes only when retrySafe was saved in the workflow', async t => {
  let attempts = 0;
  const f = await fixture(t, async () => ++attempts === 1 ? new Promise(() => {}) : { safe: true });
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'wait', retrySafe: true }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  const resumed = await f.call({ action: 'resume', runId: first.runId, model: 'replacement' });
  assert.equal((await finished(f, resumed.runId)).status, 'completed');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].args.options.model, 'replacement');
});

for (const omitChildEvent of [false, true]) test(`model resume continues the exact persistent Agent after restart (missing progress event: ${omitChildEvent})`, async t => {
  const f = await fixture(t, () => new Promise(() => {}), async () => {}, { native: true, omitChildEvent });
  await f.write({ id: 'flow', nodes: [{ id: 'a', title: 'Implementation', agentTitle: '方案设计师', prompt: 'Complete the original task' }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await f.call({ action: 'stop', runId: first.runId });
  await f.unload(); await f.restart();
  const resumed = await f.call({ action: 'resume', runId: first.runId, provider: 'new-provider', model: 'new-model' });
  const status = await finished(f, resumed.runId);
  assert.equal(status.status, 'completed');
  assert.equal(status.nodes.a.agentSessionId, 'child-1');
  assert.equal(status.nodes.a.continuations, 1);
  assert.equal(status.nodes.a.title, 'Implementation');
  assert.equal(status.nodes.a.agentTitle, '方案设计师');
  assert.equal(f.requests.length, 1, 'the original task must not be replayed in a new Agent');
  assert.equal(f.native.continuations[0].childId, 'child-1');
  assert.deepEqual(f.native.continuations[0].config, { provider: 'new-provider', model: 'new-model' });
  const detail = await f.call({ action: 'status', runId: resumed.runId, nodeId: 'a' });
  assert.deepEqual(JSON.parse(detail.node.output), { model: 'new-model', seed: 'original history for child-1' });
});

test('node details include bounded live context only for the exact parent-owned Agent', async t => {
  const f = await fixture(t, () => new Promise(() => {}), async () => {}, { native: true });
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'Task' }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  const session = { header: { parentSession: 'owner' }, requestHeader: () => ({ config: { provider: 'actual-provider', model: 'actual-model' } }), deriveMessages: () => [
    { role: 'assistant', content: [{ type: 'text', text: 'old message' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(13000) }] },
  ] };
  f.native.live.set('child-1', { id: 'child-1', status: 'running', session });
  const detail = await f.call({ action: 'status', runId: run.runId, nodeId: 'a' });
  assert.deepEqual(detail.agent, { sessionId: 'child-1', status: 'running', lastAssistantText: 'x'.repeat(12000), provider: 'actual-provider', model: 'actual-model' });
  session.header.parentSession = 'someone-else';
  assert.equal(Object.hasOwn(await f.call({ action: 'status', runId: run.runId, nodeId: 'a' }), 'agent'), false);
  assert.equal(Object.hasOwn(await f.call({ action: 'status', runId: run.runId }), 'agent'), false);
});

test('completed node diagnostics read the persisted actual model without activating its Agent', async t => {
  const f = await fixture(t, undefined, undefined, { native: true });
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'Task' }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json', model: 'requested-model' });
  await finished(f, run.runId);
  let parentSession = 'owner', inspected = 0;
  f.services.sessionController = { async inspect(id) {
    assert.equal(id, 'child-1'); inspected++;
    return { meta: { parentSession }, events: [
      { type: 'request/header', data: { header: { config: { provider: 'old', model: 'old' } } } },
      { type: 'request/header', data: { header: { config: { provider: 'actual-provider', model: 'actual-model' } } } },
    ] };
  } };
  const detail = await f.call({ action: 'status', runId: run.runId, nodeId: 'a' });
  assert.deepEqual(detail.agent, { sessionId: 'child-1', status: 'inactive', provider: 'actual-provider', model: 'actual-model' });
  assert.equal(inspected, 1);
  assert.equal(f.requests.length, 1);
  parentSession = 'another-parent';
  const denied = await f.call({ action: 'status', runId: run.runId, nodeId: 'a' });
  assert.equal(denied.status, 'completed');
  assert.equal(Object.hasOwn(denied, 'agent'), false);
  assert.match(denied.agentInspectionError, /parent/i);
});

test('an unavailable saved Agent never silently replays a retryable task in a fresh Agent', async t => {
  const f = await fixture(t, () => new Promise(() => {}), async () => {}, { native: true });
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'Task', retrySafe: true }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await f.call({ action: 'stop', runId: first.runId });
  f.native.catalog.get('child-1').mode = 'external';
  const resumed = await f.call({ action: 'resume', runId: first.runId });
  const status = await finished(f, resumed.runId);
  assert.equal(status.status, 'failed');
  assert.match(status.error, /continuable|unavailable/i);
  assert.equal(f.requests.length, 1);
  assert.equal(f.native.continuations.length, 0);
});

test('an interrupted Agent checkpoint with a changed fingerprint still requires review', async t => {
  const f = await fixture(t, () => new Promise(() => {}), async () => {}, { native: true });
  await f.write({ id: 'flow', nodes: [{ id: 'a', prompt: 'Task' }] });
  const first = await f.call({ action: 'run', workflowPath: 'flow.json' });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await f.call({ action: 'stop', runId: first.runId });
  await f.unload();
  f.storageDomain.tables.get('runs').get(first.runId).nodeSessions.a.fingerprint = 'changed';
  await f.restart();
  const resumed = await f.call({ action: 'resume', runId: first.runId });
  assert.equal((await finished(f, resumed.runId)).status, 'needs_review');
  assert.equal(f.requests.length, 1);
  assert.equal(f.native.continuations.length, 0);
});

test('treats null agent results as failures and never executes input as JavaScript', async t => {
  const f = await fixture(t, async prompt => { assert.match(prompt, /globalThis/); return null; });
  await f.write({ id: 'flow', nodes: [{ id: 'a', input: 'globalThis.compromised = true; ${evil}' }] });
  const run = await f.call({ action: 'run', workflowPath: 'flow.json' });
  assert.equal((await finished(f, run.runId)).status, 'failed');
});
