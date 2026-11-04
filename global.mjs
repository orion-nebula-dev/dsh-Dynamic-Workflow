export function isRootAgent(agent) {
  return Boolean(agent?.id) && !agent?.session?.header?.parentSession;
}

export async function classifyMessage({ llm, config, message, signal }) {
  if (!llm?.stream || !config?.provider || !config?.model) return { action: 'direct' };
  const blocks = new Map();
  try {
    for await (const chunk of llm.stream({ provider: config.provider, model: config.model, messages: [
      { role: 'user', content: [{ type: 'text', text: `Classify this user message for workflow routing. Return JSON only: {"action":"direct"|"create"|"revise","reason":"short reason"}. Choose create only for multi-step work; choose revise only if an active workflow must change.\n\nUser message:\n${message}` }] },
    ], signal })) {
      const index = chunk.index ?? 0;
      if (chunk.type === 'text-delta') blocks.set(index, (blocks.get(index) ?? '') + (chunk.text ?? ''));
      if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.set(index, chunk.block.text ?? '');
    }
    const parsed = JSON.parse([...blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('').trim());
    if (!['direct', 'create', 'revise'].includes(parsed?.action)) return { action: 'direct' };
    return { action: parsed.action, ...(typeof parsed.reason === 'string' && parsed.reason.trim() ? { reason: parsed.reason.trim().slice(0, 500) } : {}) };
  } catch { return { action: 'direct' }; }
}

export function routerInstruction(decision, context = {}) {
  const message = String(context.message ?? '').slice(0, 4000);
  if (decision.action === 'create') return `[Dynamic Workflow router] The current user message appears to require a multi-step workflow. Use the dynamic_workflow tool to create and run a JSON workflow. Define capsule agents with stage role prompts and tools, and explain the plan briefly before or alongside starting it.\nTriggering message:\n${message}`;
  if (decision.action === 'revise') return `[Dynamic Workflow router] The active workflow must be reviewed because this user message changes its requirements. First stop run ${context.runId ?? '<runId>'} and wait for child cleanup. Then revise ${context.path ?? '<workflow file>'}, preserving its workflow id where compatible, and use the dynamic_workflow revise action so valid completed results can be checked for reuse. If a stage or Agent history cannot be reused, report the triggering message and the incompatibility.\nReason: ${decision.reason ?? 'requirements changed'}\nTriggering message:\n${message}`;
  return '';
}
