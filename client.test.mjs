import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function fixture() {
  let plugin;
  const registrations = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => [initial, () => {}], useRef: current => ({ current }),
    useCallback: callback => callback, useEffect() {},
  };
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(definition) {
    plugin = definition.factory(name => { assert.equal(name, 'react'); return React; });
  } } } });
  plugin.apply({ remote: {}, effect: setup => setup(), locale: { register: () => () => {} },
    uiConversation: { events: { register: definition => { registrations.definition = definition; return () => {}; } } }, slots: {
    inject: (_name, setup) => setup(),
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  } });
  return registrations;
}

// The hook adapter checks first-render and native tool-result compatibility.
// Actual placement, appearance and controls are verified in the real browser.
test('the header launcher renders before history or details have loaded', async () => {
  const registrations = await fixture();
  assert.ok(!registrations.some(item => item.options.name === 'conversation.input.dock'));
  const registration = registrations.find(item => item.options.name === 'conversation.session.header.utilities');
  const wrapper = registration.component({ t: key => key, ...registration.options.inject('parent-session') });
  const rendered = wrapper.type(wrapper.props);
  assert.equal(rendered.type, 'section');
  assert.equal(rendered.props['aria-label'], 'title');
});

for (const action of ['run', 'resume']) test(`${action} results bind an inline card to their original run`, async () => {
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

test('inspection results and malformed tool text never create a workflow card', async () => {
  const registration = (await fixture()).find(item => item.options.key === 'dynamic_workflow');
  for (const [action, text] of [['list', '{"runs":[]}'], ['run', 'failed to read workflow file']]) {
    const rendered = registration.component({ t: key => key, phase: 'result', block: {
      call: { argsRaw: JSON.stringify({ action }) }, content: [{ type: 'text', text }],
    } });
    assert.equal(rendered.type, 'details');
  }
});
