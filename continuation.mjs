import { z } from 'zod';

const messageOf = error => error instanceof Error ? error.message : String(error);

const activeRoles = new WeakMap();

/** Replace one child's current activation policy. Never register on the parent scope. */
export function installNodeRole(ctx, agent, role = {}) {
  activeRoles.get(agent)?.();
  const removers = [];
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (activeRoles.get(agent) === dispose) activeRoles.delete(agent);
    for (const off of removers.splice(0).reverse()) off();
  };
  let childOff, ownerOff;
  const dispose = () => { ownerOff?.(); childOff?.(); cleanup(); };
  try {
    childOff = agent.ctx.effect(() => {
      try {
        if (role.prompt !== undefined) removers.push(agent.ctx.systemPrompt.section({
          name: 'dynamic-workflow:node-role', order: 1000, text: role.prompt, interpolate: false,
        }));
        if (role.tools !== undefined) {
          const allowed = new Set(role.tools);
          removers.push(agent.ctx.tools.presentAs('native'));
          removers.push(agent.ctx.tools.restrict({ allow: [...allowed] }));
          // Inherited masks exempt child-owned tools; enforce the policy at execution too.
          removers.push(agent.ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'Tool is unavailable in this workflow activation'));
        }
        return cleanup;
      } catch (error) { cleanup(); throw error; }
    });
    ownerOff = ctx.effect(() => childOff);
    activeRoles.set(agent, dispose);
    return dispose;
  } catch (error) { dispose(); throw error; }
}

/** Continue one verified continuable child. The caller owns admission and persistence checks. */
export function continueNodeSession({ ctx, owner, childId, prompt, selection = {}, schema, role, signal, subagents, agents }) {
  const controller = new AbortController();
  const route = Object.fromEntries(['provider', 'model'].filter(key => selection[key] !== undefined).map(key => [key, selection[key]]));
  const disposers = [];
  const installed = new Set();
  let finished = false, nativeFinished = false, cancelled = false, cleanupError;
  let endInfo, wake;
  const ended = new Promise(resolve => { wake = resolve; });

  function clearListeners() {
    signal?.removeEventListener('abort', abort);
    for (const off of disposers.splice(0).reverse()) off();
  }
  function cancel(reason) {
    if (finished || nativeFinished || cancelled) return;
    cancelled = true;
    controller.abort(reason);
    wake();
  }
  function abort() { cancel(signal.reason); }
  function install(agent) {
    if (finished || nativeFinished || agent.id !== childId || installed.has(agent)) return;
    installed.add(agent);
    disposers.push(installNodeRole(ctx, agent, role));
    // Child scope owns these hooks; the plugin scope retains their exact disposer too.
    const off = agent.ctx.effect(() => {
      const removeAssembly = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        return { ...assembly, variables: { ...assembly.variables, ...route } };
      });
      const removeRequest = agent.ctx.on('agent/request', async (_payload, next) => {
        const config = await next();
        const changed = Object.entries(route).some(([key, value]) => config[key] !== value);
        const updated = { ...config, ...route };
        if (changed) delete updated.reasoningEffort;
        return updated;
      });
      return () => { removeRequest(); removeAssembly(); };
    });
    disposers.push(ctx.effect(() => off));
  }
  function onEnd(info) {
    if (finished || nativeFinished || info.id !== childId) return;
    nativeFinished = true;
    endInfo = info;
    clearListeners();
    wake();
  }

  const result = (async () => {
    try {
      if (signal?.aborted) { cancelled = true; return { stopReason: 'cancelled' }; }
      const validator = schema === undefined ? undefined : z.fromJSONSchema(schema);
      const live = agents.get(childId);
      if (live?.status === 'running') throw new Error(`Child session ${childId} is already running`);
      disposers.push(ctx.on('agent/created', ({ agent }) => { install(agent); }));
      disposers.push(ctx.on('subagent/end', onEnd));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (cancelled) return { stopReason: 'cancelled' };
      if (live) install(live);
      const modelChange = Object.keys(route).length ? JSON.stringify(route) : '沿用当前 provider/model';
      const continuationPrompt = [
        `模型选择变更：${modelChange}。`,
        '在同一会话中继续历史任务。先核实中断操作的实际状态，避免重复执行已经完成或仍在进行的操作。',
        ...(schema === undefined ? [] : [`最终回复必须只输出符合以下 JSON Schema 的 JSON：\n${JSON.stringify(schema)}`]),
        prompt,
      ].join('\n\n');
      // Cancellation before acceptance is owned by sendMessage. Do not claim cleanup
      // while its materialization is still pending: acceptance can win that race.
      await subagents.sendMessage(owner, childId, [{ type: 'text', text: continuationPrompt }], { signal: controller.signal });
      if (!nativeFinished && !cancelled) await ended;
      if (cancelled && !nativeFinished) {
        try {
          subagents.interrupt(childId, { kind: 'ancestor', agent: owner });
        } catch (error) { cleanupError = error; }
        try { await subagents.drainChildren(owner, [childId]); }
        catch (error) { cleanupError = cleanupError ? new AggregateError([cleanupError, error], 'Child cleanup failed') : error; }
        if (cleanupError) throw cleanupError;
      }
      if (cancelled || endInfo?.stopReason === 'aborted') return { stopReason: 'cancelled' };
      const text = (endInfo?.lastAssistantMessage || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (endInfo?.stopReason !== 'completed') return { stopReason: 'error', error: text || `Child stopped: ${endInfo?.stopReason || 'unknown'}` };
      if (!validator) return { stopReason: 'completed', value: text };
      const fenced = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(text);
      return { stopReason: 'completed', value: validator.parse(JSON.parse(fenced ? fenced[1] : text)) };
    } catch (error) {
      return cancelled && !cleanupError ? { stopReason: 'cancelled' } : { stopReason: 'error', error: messageOf(error) };
    } finally {
      finished = true;
      clearListeners();
    }
  })();

  return {
    result,
    cancel,
    async dispose() {
      cancel('disposed');
      await result;
      if (cleanupError) throw cleanupError;
    },
  };
}
