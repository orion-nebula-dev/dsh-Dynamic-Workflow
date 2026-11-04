import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.js';

async function mounted(workflow) {
  const disposers = [];
  const rows = new Map();
  const requests = [];
  let tool;
  const engine = {
    start(request) {
      requests.push(request);
      return { result: Promise.resolve({ stopReason: 'completed', value: request.args.options.model || 'inherited' }), cancel() {}, async dispose() {} };
    },
  };
  const services = {
    workflowEngine: engine,
    fs: {
      async resolve() { return { targetKey: 'example', displayPath: '/example.json' }; },
      async readBytes() { return new TextEncoder().encode(JSON.stringify(workflow)); },
    },
    workingDirectory: { async ensure() { return '/'; } },
  };
  const ctx = {
    get: key => services[key],
    tools: { register(value) { tool = value; return () => {}; } },
    commands: { register() { return () => {}; } },
    storageDomain: {
      async open(spec) {
        return {
          table() { return {
            entries: () => rows.entries(),
            async put(key, value) { rows.set(key, structuredClone(spec.tables.runs.valueSchema.parse(value))); },
          }; },
          async close() {},
        };
      },
    },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
  };
  await apply(ctx);
  const exec = { agent: { id: 'wire-session', ctx: { get: key => services[key] } } };
  return {
    invoke: args => tool.execute(args, exec), requests,
    async close() { for (const dispose of disposers.reverse()) await dispose?.(); },
  };
}

function lossless(value) {
  assert.deepEqual(value, JSON.parse(JSON.stringify(value)), 'Tool results must contain no undefined values that the Harness rejects');
}

test('run, status and history cross the lossless JSON tool boundary without optional selections', async () => {
  const host = await mounted({ id: 'wire', nodes: [{ id: 'a', prompt: 'Reply briefly', retrySafe: true }] });
  try {
    const run = await host.invoke({ action: 'run', workflowPath: '/example.json' });
    lossless(run);
    await new Promise(setImmediate);
    lossless(await host.invoke({ action: 'status', runId: run.runId }));
    lossless(await host.invoke({ action: 'list' }));
  } finally { await host.close(); }
});

test('an explicit run model overrides a node model for subsequent execution', async () => {
  const host = await mounted({ id: 'switch', nodes: [{ id: 'a', prompt: 'Reply briefly', model: 'old-model', retrySafe: true }] });
  try {
    const run = await host.invoke({ action: 'run', workflowPath: '/example.json', model: 'selected-model' });
    await new Promise(setImmediate);
    const result = await host.invoke({ action: 'status', runId: run.runId, nodeId: 'a' });
    assert.equal(result.status, 'completed');
    assert.equal(result.node.output, 'selected-model');
  } finally { await host.close(); }
});
