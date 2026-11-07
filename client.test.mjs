import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(hooks = {}, remote = {}, globals = {}, uiWorkspace = { openSession() {} }) {
  let plugin;
  const registrations = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => [initial, () => {}], useRef: current => ({ current }),
    useCallback: callback => callback, useEffect() {}, ...hooks,
  };
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { AbortController, ...globals, window: { __ModuleLoader__: { load(definition) {
    plugin = definition.factory(name => { assert.equal(name, 'react'); return React; });
  } } } });
  plugin.apply({ remote, uiWorkspace, effect: setup => setup(), locale: { register: () => () => {} },
    uiConversation: { events: { register: definition => { registrations.definition = definition; return () => {}; } } }, slots: {
    inject: (_name, setup) => setup(),
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  } });
  return registrations;
}

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(item => elements(item, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)];
}

async function configFixture(form) {
  const states = [];
  let cursor = 0;
  const registrations = await fixture({ useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
  } });
  const registration = registrations.find(item => item.options.name === 'plugins.row.config');
  assert.ok(registration, 'plugin settings must expose its global mode control');
  assert.equal(registration.options.key, '@local/dynamic-workflow#dynamic-workflow');
  const render = () => { cursor = 0; return registration.component({ t: key => key, view: 'page', form }); };
  return { render, registration };
}

async function bundleFixture(settings) {
  const states = [], effects = [];
  let cursor = 0;
  const registrations = await fixture({
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(setup) { if (!effects.length) effects.push(setup); },
  }, { settings });
  const registration = registrations.find(item => item.options.name === 'plugins.bundle.config');
  assert.ok(registration, 'the bundle detail page must show configuration directly');
  assert.equal(registration.options.key, '@local/dynamic-workflow');
  const render = () => { cursor = 0; return registration.component({ t: key => key, view: 'page' }); };
  render();
  const dispose = effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  return { render, dispose };
}

test('bundle detail loads and persists the global switch through Host settings', async () => {
  let value = false, revision = 4;
  const writes = [];
  const namespace = () => ({ ns: 'dynamic-workflow', value: { globalEnabled: value }, revision });
  const settings = {
    describe: async () => ({ ok: true, value: { writable: true, namespaces: [namespace()] } }),
    mutate: async (...args) => {
      writes.push(args);
      value = args[1][0].value; revision++;
      return { ok: true, value: namespace() };
    },
  };
  const f = await bundleFixture(settings);
  let form = f.render().props.form;
  assert.equal(form.state.status, 'ready');
  assert.equal(form.state.value.globalEnabled, false);
  assert.equal(await form.mutate([{ op: 'set', path: ['globalEnabled'], value: true }], 4), true);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [['dynamic-workflow', [{ op: 'set', path: ['globalEnabled'], value: true }], 4]]);
  form = f.render().props.form;
  assert.equal(form.state.value.globalEnabled, true);
  assert.equal(form.state.revision, 5);
  f.dispose();
  const reopened = await bundleFixture(settings);
  assert.equal(reopened.render().props.form.state.value.globalEnabled, true, 'reopening must read persisted Host values');
  reopened.dispose();
});

test('bundle config reports Host read and write failures without claiming success', async () => {
  const f = await bundleFixture({ describe: async () => ({ ok: false, error: { message: 'read refused' } }) });
  assert.equal(f.render().props.form.state.status, 'error');
  assert.match(f.render().props.form.state.error, /read refused/);
  f.dispose();
  const writable = await bundleFixture({
    describe: async () => ({ ok: true, value: { writable: true, namespaces: [{ ns: 'dynamic-workflow', value: { globalEnabled: false }, revision: 2 }] } }),
    mutate: async () => ({ ok: false, error: { message: 'revision changed' } }),
  });
  await assert.rejects(writable.render().props.form.mutate([{ op: 'set', path: ['globalEnabled'], value: true }], 2), /revision changed/);
  assert.equal(writable.render().props.form.state.value.globalEnabled, false);
  writable.dispose();
});

test('global mode saves only its own setting against the accepted revision', async () => {
  const writes = [];
  const form = { state: { status: 'ready', writable: true, value: { globalEnabled: false, unrelated: 42 }, revision: 7 }, mutate: async (...args) => { writes.push(args); return true; } };
  const { render, registration } = await configFixture(form);
  assert.equal(typeof registration.component({ t: key => key, view: 'summary' }), 'string');
  let control = elements(render(), item => item.props.role === 'switch')[0];
  assert.equal(control.props['aria-checked'], false);
  await control.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [[[ { op: 'set', path: ['globalEnabled'], value: true } ], 7]]);
  form.state = { ...form.state, value: { globalEnabled: true }, revision: 8 };
  const enabledView = render();
  control = elements(enabledView, item => item.props.role === 'switch')[0];
  assert.equal(control.props['aria-checked'], true);
  const status = elements(enabledView, item => item.props.className === 'dwf-config-status')[0];
  assert.equal(status.props.children[0], 'enabled');
  await control.props.onClick();
  assert.equal(writes[1][0][0].value, false);
  assert.equal(writes[1][1], 8);
});

for (const state of [undefined, { status: 'loading', writable: true }, { status: 'ready', writable: false, value: {} }]) test(`global mode cannot mutate unavailable or read-only config: ${JSON.stringify(state)}`, async () => {
  let writes = 0;
  const { render } = await configFixture(state ? { state, mutate: () => { writes++; } } : undefined);
  const control = elements(render(), item => item.props.role === 'switch')[0];
  if (control) {
    assert.equal(control.props.disabled, true);
    await control.props.onClick();
  }
  assert.equal(writes, 0);
});

for (const failure of ['rejected', 'thrown']) test(`global mode reports ${failure} saves without claiming enabled`, async () => {
  const form = { state: { status: 'ready', writable: true, value: {}, revision: 1 }, mutate: async () => { if (failure === 'thrown') throw new Error('save failed'); return false; } };
  const { render } = await configFixture(form);
  await elements(render(), item => item.props.role === 'switch')[0].props.onClick();
  const tree = render();
  assert.equal(elements(tree, item => item.props.role === 'switch')[0].props['aria-checked'], false);
  assert.equal(elements(tree, item => item.props.role === 'alert').length, 1);
});

// The hook adapter checks first-render and native tool-result compatibility.
// Actual placement, appearance and controls are verified in the real browser.
test('background workflow refresh reads state without executing a logged session command', async () => {
  const effects = [], states = []; let cursor = 0, commandCalls = 0, reads = 0;
  const history = { runs: [{ runId: 'run-1', status: 'running', createdAt: 1 }] };
  const remote = { commands: { execute: async () => {
    commandCalls++;
    return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(history) } } };
  } } };
  const globals = { fetch: async () => { reads++; return { ok: true, json: async () => history }; } };
  const registrations = await fixture({
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useEffect(setup) { effects.push(setup); },
  }, remote, globals);
  const registration = registrations.find(item => item.options.name === 'conversation.session.header.utilities');
  const wrapper = registration.component({ t: key => key, ...registration.options.inject('parent-session') });
  wrapper.type(wrapper.props);
  const cleanup = effects[0]();
  effects[1]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commandCalls, 0, 'automatic reads must not create command events');
  assert.equal(reads, 1);
  assert.equal(states[1][0].runId, 'run-1');
  cleanup();
});

test('detail and node reads stay quiet while an explicit stop still executes a command', async () => {
  const effects = [], queries = [], commands = []; let cursor = 0;
  const run = { runId: 'run-1', status: 'running', nodes: { one: { status: 'completed' } } };
  const remote = { commands: { execute: async (_id, line) => {
    commands.push(JSON.parse(line.slice('/workflow '.length)));
    return { ok: true, value: { result: { kind: 'success', text: JSON.stringify(run) } } };
  } } };
  const registrations = await fixture({
    useState(initial) { return [cursor++ === 0 ? true : initial, () => {}]; },
    useEffect(setup) { effects.push(setup); },
  }, remote, { fetch: async path => {
    queries.push(JSON.parse(new URL(path, 'http://localhost').searchParams.get('args')));
    return { ok: true, json: async () => queries.at(-1).action === 'list' ? { runs: [run] } : run };
  } });
  const registration = registrations.find(item => item.options.name === 'conversation.session.header.utilities');
  const wrapper = registration.component({ t: key => key, ...registration.options.inject('parent-session') });
  const tree = wrapper.type({ ...wrapper.props, initialRun: run, placement: 'inline' });
  const cleanup = effects[0]();
  effects[6]();
  await new Promise(resolve => setImmediate(resolve));
  await elements(tree, item => item.type === 'button' && item.props['aria-label'] === 'result · one')[0].props.onClick();
  assert.deepEqual(queries, [{ action: 'status', runId: 'run-1' }, { action: 'status', runId: 'run-1', nodeId: 'one' }]);
  assert.equal(commands.length, 0);
  await elements(tree, item => item.type === 'button' && item.props.title === 'stop')[0].props.onClick();
  assert.deepEqual(commands, [{ action: 'stop', runId: 'run-1' }]);
  assert.deepEqual(queries.at(-1), { action: 'list' });
  cleanup();
});

test('the header launcher renders before history or details have loaded', async () => {
  const registrations = await fixture();
  assert.ok(!registrations.some(item => item.options.name === 'conversation.input.dock'));
  const registration = registrations.find(item => item.options.name === 'conversation.session.header.utilities');
  const wrapper = registration.component({ t: key => key, ...registration.options.inject('parent-session') });
  const rendered = wrapper.type(wrapper.props);
  assert.equal(rendered.type, 'section');
  assert.equal(rendered.props['aria-label'], 'title');
});

for (const action of ['run', 'resume', 'revise']) test(`${action} results bind an inline card to their original run`, async () => {
  const registrations = await fixture();
  const registration = registrations.find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'saved-run', workflowPath: '/tmp/workflow.json', status: 'running', title: 'Actual workflow', nodes: { plan: { status: 'running', agentTitle: 'Designer' } } };
  const definition = registrations.definition;
  const location = { kind: 'step', turn: { turn: 1 }, step: { step: 2 } };
  const call = { type: 'tool/call', seq: 10, data: { name: 'dynamic_workflow', callId: 'call-1', arguments: JSON.stringify({ action }) } };
  const result = { type: 'tool/result', seq: 12, data: { message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: JSON.stringify(run) }] } } };
  assert.equal(definition.match['tool/call'](call).id, 'call-1');
  assert.equal(definition.match['tool/result'](result).id, 'call-1');
  const context = { key: 'row-1', id: 'call-1', start: { event: call, location }, state: definition.start() };
  context.state = definition.update(context, { event: result });
  const node = definition.buildViewNode(context);
  assert.equal(node.anchorSeq, 12);
  assert.equal(node.groupTree, 'turn', 'the workflow must remain outside collapsed process logs');
  assert.equal(node.location, location);
  const card = registration.component({ t: key => key, ...registration.options.inject('parent-session'), node });
  assert.equal(card.props.placement, 'inline');
  assert.equal(card.props.fixedRunId, run.runId);
  assert.equal(card.props.initialRun.nodes.plan.agentTitle, 'Designer');
  assert.equal(card.type(card.props).type, 'section');
});

test('capsules expose stable Agent identity while their stage roles change', async () => {
  const registration = (await fixture()).find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'roles-run', status: 'completed', title: 'Roles', nodes: {
    plan: { status: 'completed', agentId: 'worker', agentTitle: 'Worker', roleTitle: 'Planner', agentSessionId: 'child-1' },
    review: { status: 'completed', agentId: 'reviewer', agentTitle: 'Reviewer', roleTitle: 'Reviewer', agentSessionId: 'child-2' },
    deliver: { status: 'completed', agentId: 'worker', agentTitle: 'Worker', roleTitle: 'Writer', agentSessionId: 'child-1' },
  } };
  const component = registration.component({ t: key => key, ...registration.options.inject('parent'), node: { data: { run } } });
  const tree = component.type(component.props), capsules = [];
  function visit(element) {
    if (Array.isArray(element)) return element.forEach(visit);
    if (!element || typeof element !== 'object') return;
    if (element.props.className === 'dwf-agent') capsules.push(element);
    visit(element.props.children);
  }
  visit(tree);
  assert.deepEqual(Array.from(capsules, item => item.props['data-agent-id']), ['worker', 'reviewer', 'worker']);
  assert.equal(capsules[0].props['data-agent-session-id'], capsules[2].props['data-agent-session-id']);
  const name = capsule => capsule.props.children.find(item => item?.props?.className === 'dwf-agent-name').props.children[0];
  assert.equal(name(capsules[0]), 'Planner');
  assert.equal(name(capsules[2]), 'Writer');
  assert.equal(capsules[0].props.children[0].props.className, capsules[2].props.children[0].props.className);
});

for (const detail of [false, true]) test(`${detail ? 'detail' : 'inline'} capsules open their exact subagent conversation`, async () => {
  const opened = []; let cursor = 0;
  const registrations = await fixture({ useState(initial) { return [cursor++ === 0 ? detail : initial, () => {}]; } }, {}, {}, { openSession(target) { opened.push(target); } });
  const registration = registrations.find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'navigation-run', status: 'running', nodes: {
    plan: { status: 'completed', agentId: 'worker', agentSessionId: 'child-worker' },
    deliver: { status: 'running', agentId: 'worker', agentSessionId: 'child-worker' },
    failed: { status: 'failed', agentId: 'reviewer', agentSessionId: 'child-reviewer' },
    pending: { status: 'pending', agentId: 'waiting' },
  } };
  const component = registration.component({ t: key => key, ...registration.options.inject('parent-session'), node: { data: { run } } });
  const tree = component.type(component.props);
  const area = elements(tree, item => item.props.className === (detail ? 'dwf-timeline' : 'dwf-stages'))[0];
  const capsules = elements(area, item => item.props.className === 'dwf-agent');
  assert.equal(capsules.length, 4);
  for (const capsule of capsules.slice(0, 3)) {
    assert.equal(capsule.type, 'button', 'capsules must support keyboard activation');
    assert.equal(capsule.props.disabled, false);
    capsule.props.onClick();
  }
  assert.equal(opened.length, 3);
  assert.deepEqual({ ...opened[0] }, { parentSessionId: 'parent-session', childSessionId: 'child-worker', mode: 'unknown' });
  assert.deepEqual(opened[0], opened[1], 'serial stages in one capsule open the same Agent');
  assert.deepEqual({ ...opened[2] }, { parentSessionId: 'parent-session', childSessionId: 'child-reviewer', mode: 'unknown' });
  assert.equal(capsules[3].props.disabled, true, 'a node without a created Agent cannot navigate');
});

for (const detail of [false, true]) test(`approved review loops label skipped rounds and deterministic gates in ${detail ? 'details' : 'cards'}`, async () => {
  let cursor = 0;
  const registration = (await fixture({ useState(initial) { return [cursor++ === 0 ? detail : initial, () => {}]; } })).find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'review-run', workflowPath: '/tmp/review.json', status: 'completed', nodes: {
    'quality/review/1': { status: 'completed', agentId: 'reviewer', agentTitle: 'Reviewer', agentSessionId: 'review-child', reviewStep: { loopId: 'quality', kind: 'review', round: 1, maxRounds: 3 } },
    'quality/fix/1': { status: 'completed', skipped: true, agentId: 'developer', agentTitle: 'Developer', reviewStep: { loopId: 'quality', kind: 'fix', round: 1, maxRounds: 3 } },
    quality: { status: 'completed', reviewStep: { loopId: 'quality', kind: 'gate', maxRounds: 3 } },
  } };
  const card = registration.component({ t: key => key, ...registration.options.inject('parent-session'), node: { data: { run } } });
  const rendered = card.type(card.props);
  const tree = detail ? elements(rendered, item => item.props?.className === 'dwf-panel')[0] : rendered;
  const capsules = elements(tree, item => item.type === 'button' && item.props.className === 'dwf-agent');
  assert.equal(capsules.length, 2, 'a deterministic review gate has no Agent capsule');
  assert.match(capsules[1].props.title, /skipped/);
  assert.equal(elements(tree, item => item.props?.className === 'dwf-dot skipped').length, 1, 'skipped rounds use a neutral status rather than an execution success indicator');
  assert.equal(capsules[1].props.disabled, true, 'a skipped fix must not create a child conversation');
  assert.equal(elements(tree, item => item.props?.className === 'dwf-review-gate').length, 1);
  assert.equal(elements(tree, item => item.type === 'button' && (detail ? item.props['aria-label'] === 'result · quality' : item.props.className === 'dwf-result-link')).length, 1, 'the gate still exposes its report');
});

for (const detail of [false, true]) test(`parallel members share one logical stage in ${detail ? 'details' : 'cards'}`, async () => {
  let cursor = 0;
  const opened = [], queries = [];
  const registration = (await fixture({ useState(initial) { return [cursor++ === 0 ? detail : initial, () => {}]; } }, {}, {
    fetch: async path => { queries.push(JSON.parse(new URL(path, 'http://localhost').searchParams.get('args'))); return { ok: true, json: async () => ({ node: { output: { first: 'done' } } }) }; },
  }, { openSession: target => opened.push(target) })).find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'members-run', status: 'running', nodes: {
    'research/agent/first': { status: 'completed', agentId: 'writer', agentSessionId: 'writer-child', agentStep: { groupId: 'research', kind: 'member', memberId: 'first' } },
    'research/agent/second': { status: 'running', agentId: 'critic', agentSessionId: 'critic-child', agentStep: { groupId: 'research', kind: 'member', memberId: 'second' } },
    research: { title: 'Research', status: 'pending', agentStep: { groupId: 'research', kind: 'collect', members: ['first', 'second'] } },
    deliver: { title: 'Deliver', status: 'pending', deps: ['research'], agentId: 'writer' },
  } };
  const card = registration.component({ t: key => key, ...registration.options.inject('parent'), node: { data: { run } } });
  const tree = card.type(card.props);
  const area = elements(tree, item => item.props.className === (detail ? 'dwf-timeline' : 'dwf-stages'))[0];
  const stages = elements(area, item => detail ? item.props.className === 'dwf-node' : item.props.className?.split(' ').includes('dwf-stage'));
  assert.equal(stages.length, 2, 'members and collect must share their original logical stage');
  assert.equal(elements(stages[0], item => item.props.className === 'dwf-count')[0].props.children[0], '1/2');
  assert.equal(elements(stages[0], item => item.props.className === 'dwf-dot running').length, 1, 'an active member makes its pending collect stage running');
  const capsules = elements(stages[0], item => item.props.className === 'dwf-agent');
  assert.deepEqual(Array.from(capsules, item => item.props['data-agent-id']), ['writer', 'critic']);
  for (const capsule of capsules) capsule.props.onClick();
  assert.deepEqual(Array.from(opened, target => target.childSessionId), ['writer-child', 'critic-child']);
  if (detail) {
    await elements(stages[0], item => item.props['aria-label'] === 'result · Research')[0].props.onClick();
    assert.deepEqual(queries, [{ action: 'status', runId: 'members-run', nodeId: 'research' }]);
  }
});

test('a failed member keeps its logical stage failed when collect is blocked', async () => {
  const registration = (await fixture()).find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'failed-member', status: 'failed', nodes: {
    'work/agent/one': { status: 'failed', agentId: 'one', agentSessionId: 'one-child', agentStep: { groupId: 'work', kind: 'member', memberId: 'one' } },
    work: { status: 'blocked', agentStep: { groupId: 'work', kind: 'collect', members: ['one'] } },
  } };
  const card = registration.component({ t: key => key, ...registration.options.inject('parent'), node: { data: { run } } });
  const tree = card.type(card.props);
  assert.equal(elements(tree, item => item.props.className === 'dwf-dot failed').length, 1);
});

test('detail stages expose a result action for each parallel member', async () => {
  const queries = [];
  let cursor = 0;
  const registration = (await fixture({ useState: initial => [cursor++ === 0 ? true : initial, () => {}] }, {}, { fetch: async path => { queries.push(JSON.parse(new URL(path, 'http://localhost').searchParams.get('args'))); return { ok: true, json: async () => ({ node: { output: 'member result' } }) }; } })).find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'member-output', status: 'running', nodes: {
    'work/agent/one': { status: 'completed', agentId: 'one', agentSessionId: 'one-child', agentStep: { groupId: 'work', kind: 'member', memberId: 'one' } },
    work: { status: 'completed', agentStep: { groupId: 'work', kind: 'collect', members: ['one'] } },
  } };
  const card = registration.component({ t: key => key, ...registration.options.inject('parent'), node: { data: { run } } });
  const tree = card.type(card.props);
  const action = elements(tree, item => item.type === 'button' && item.props['aria-label'] === 'result · one')[0];
  assert.ok(action, 'each detailed member must expose its own result action');
  await action.props.onClick();
  assert.deepEqual(queries, [{ action: 'status', runId: 'member-output', nodeId: 'work/agent/one' }]);
});

test('completed collect gates do not inflate stage progress or Agent totals', async () => {
  const registration = (await fixture()).find(item => item.options.name === 'conversation.chat.node');
  const run = { runId: 'done', status: 'completed', nodes: {
    'work/agent/one': { status: 'completed', agentId: 'one', agentSessionId: 'one-child', agentStep: { groupId: 'work', kind: 'member', memberId: 'one' } },
    'work/agent/two': { status: 'completed', agentId: 'two', agentSessionId: 'two-child', agentStep: { groupId: 'work', kind: 'member', memberId: 'two' } },
    work: { status: 'completed', agentStep: { groupId: 'work', kind: 'collect', members: ['one', 'two'] } },
  } };
  const card = registration.component({ t: key => key, ...registration.options.inject('parent'), node: { data: { run } } });
  const tree = card.type(card.props);
  assert.equal(elements(tree, item => item.props.className === 'dwf-count')[0].props.children[0], '2/2');
  assert.ok(elements(tree, item => item.props.className === 'dwf-meta').some(item => item.props.children[0] === '1 stages · 2 agents'));
  assert.equal(elements(tree, item => item.props.className === 'dwf-agent').length, 2);
});

test('inspection results and malformed tool text never create a workflow card', async () => {
  const registration = (await fixture()).find(item => item.options.key === 'dynamic_workflow');
  for (const [action, text] of [['list', '{"runs":[]}'], ['run', 'failed to read workflow file']]) {
    const rendered = registration.component({ t: key => key, phase: 'result', block: {
      call: { argsRaw: JSON.stringify({ action }) }, content: [{ type: 'text', text }],
    } });
    assert.equal(rendered.type, 'details');
  }
});
