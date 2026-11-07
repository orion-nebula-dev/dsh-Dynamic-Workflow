/* Dynamic Workflow: quiet state reads; user operations share the Host command with the agent tool. */
window.__ModuleLoader__.load({
  id: '@local/dynamic-workflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;
    const NS = 'local-dynamic-workflow';
    const dictionaries = {
      zh: {
        configIntro: '设置动态工作流的全局任务判断。', globalMode: '全局模式',
        globalModeNote: '开启后，由当前会话模型判断每条用户消息是否适合工作流。',
        globalModeCost: '仅作用于主会话，会增加模型请求的耗时与用量；关闭后仍可手动运行。',
        configUnavailable: '配置表单暂不可用。请重新打开插件设置。', configLoading: '正在加载配置…', configReadOnly: '当前配置为只读。',
        configSaveFailed: '配置未保存。请刷新设置后重试。', enabled: '已开启', disabled: '已关闭',
        title: '动态工作流', workflow: '工作流', agents: '个代理', workflowRunning: '工作流运行中', workflowCompleted: '工作流已完成', configure: '运行配置', stages: '个阶段', steps: '步', oneTask: '1 个任务', atMost: '最多', decrease: '减少并发', increase: '增加并发', save: '保存', completedNote: '本次运行已完成。点击代理胶囊进入会话，点击节点旁的按钮查看结果。', open: '打开工作流', close: '收起详情', refresh: '刷新',
        empty: '当前会话还没有工作流。输入工作流 JSON 文件路径，或让助手根据任务创建工作流。',
        path: '工作流文件路径', pathPlaceholder: '例如 workflow.json', start: '运行工作流',
        history: '运行记录', model: '子 Agent 模型', inherit: '沿用已有模型配置',
        concurrency: '当前节点内 Agent 并发上限', parallelAgents: '个 Agent 在当前节点内同时运行', serialNodesNote: '顶层节点按顺序依次执行；并发上限仅作用于当前节点内的 Agent。', revise: '读取新定义并修订', stop: '停止运行', resume: '继续工作流', switch: '切换模型并继续',
        modelNote: '继续前先停止并清理当前执行。已完成结果保留，未完成节点恢复原 Agent 会话后使用所选模型。',
        agentSession: 'Agent 会话', contextResumed: '原会话续跑', contextMissing: '此记录缺少部分 Agent 会话，无法恢复对应节点的上下文。',
        reviewNote: '存在待核查节点。请让助手检查中断产生的影响，更新工作流后再运行。',
        script: '查看工作流定义', result: '查看结果', reused: '已复用', waiting: '等待节点状态',
        completed: '已完成', running: '运行中', failed: '失败', cancelled: '已停止',
        interrupted: '已中断', needs_review: '待核查', pending: '等待执行', blocked: '受阻', skipped: '已跳过', reviewGate: '审查门禁', reviewRound: '轮次',
        selected: '当前运行', from: '继承自', nodes: '个节点', working: '个节点执行中',
        busy: '处理中…', saved: '历史已保存', requestFailed: '操作失败', unknownCommand: '工作流命令未启用',
        modelError: '部分模型列表加载失败', output: '节点结果', copied: '已复制', copy: '复制 JSON',
        required: '请填写工作流文件路径', allDone: '所有节点已完成', changed: '模型选择仅在运行或继续后生效',
        invalidConcurrency: '当前节点内同时运行的 Agent 数量须为 1–8 的整数。', legacy: '此记录未保存工作流定义。请填写原文件路径重新运行。',
      },
      en: {
        configIntro: 'Configure global task classification for dynamic workflows.', globalMode: 'Global mode',
        globalModeNote: 'Let the current session model check each human message for workflow suitability.',
        globalModeCost: 'Root sessions only. Adds model latency and usage; manual workflows remain available when disabled.',
        configUnavailable: 'The configuration form is unavailable. Reopen plugin settings.', configLoading: 'Loading configuration…', configReadOnly: 'This configuration is read-only.',
        configSaveFailed: 'Settings were not saved. Refresh settings and try again.', enabled: 'Enabled', disabled: 'Disabled',
        title: 'Dynamic workflow', workflow: 'Workflow', agents: 'agents', workflowRunning: 'Workflow running', workflowCompleted: 'Workflow completed', configure: 'Run configuration', stages: 'stages', steps: 'steps', oneTask: '1 task', atMost: 'At most', decrease: 'Decrease concurrency', increase: 'Increase concurrency', save: 'Save', completedNote: 'This run is complete. Select an agent capsule to open its conversation, or the button beside a stage to view its result.', open: 'Open workflow', close: 'Collapse details', refresh: 'Refresh',
        empty: 'No workflow in this session yet. Enter a workflow JSON path or ask the assistant to create one.',
        path: 'Workflow file path', pathPlaceholder: 'For example workflow.json', start: 'Run workflow',
        history: 'Run history', model: 'Subagent model', inherit: 'Keep existing model configuration',
        concurrency: 'Agent concurrency limit within the current node', parallelAgents: 'Agents in parallel within the current node', serialNodesNote: 'Top-level nodes run sequentially; the concurrency limit applies only to Agents within the current node.', revise: 'Revise from file', stop: 'Stop run', resume: 'Continue workflow', switch: 'Switch model and continue',
        modelNote: 'Stops and drains active work first. Completed results are kept; unfinished nodes restore their original Agent sessions with the selected model.',
        agentSession: 'Agent session', contextResumed: 'Session continued', contextMissing: 'Some historical Agent sessions are missing; their context cannot be restored.',
        reviewNote: 'Some nodes require review. Ask the assistant to check interrupted effects and update the workflow before running again.',
        script: 'View workflow definition', result: 'View result', reused: 'Reused', waiting: 'Waiting for node state',
        completed: 'Completed', running: 'Running', failed: 'Failed', cancelled: 'Stopped',
        interrupted: 'Interrupted', needs_review: 'Needs review', pending: 'Pending', blocked: 'Blocked', skipped: 'Skipped', reviewGate: 'Review gate', reviewRound: 'Round',
        selected: 'Current run', from: 'Continued from', nodes: 'nodes', working: 'nodes running',
        busy: 'Working…', saved: 'History saved', requestFailed: 'Operation failed', unknownCommand: 'Workflow command is unavailable',
        modelError: 'Some model catalogs could not be loaded', output: 'Node result', copied: 'Copied', copy: 'Copy JSON',
        required: 'Enter a workflow file path', allDone: 'All nodes completed', changed: 'Model selection takes effect when you run or continue',
        invalidConcurrency: 'The concurrent Agent limit within the current node must be an integer from 1 to 8.', legacy: 'This record has no saved definition. Run it again using the original file path.',
      },
    };
    const css = `
.dwf{--dwf-green:#208b45;--dwf-orange:#ed951c;--dwf-teal:#54b4a6;--dwf-line:var(--dsw-alias-border-l1);box-sizing:border-box;width:100%;min-width:0;margin-bottom:10px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.dwf *{box-sizing:border-box}.dwf button,.dwf input,.dwf select{font:inherit;color:inherit}.dwf button{cursor:pointer;border:1px solid var(--dwf-line);border-radius:8px;background:var(--dsw-alias-bg-base);padding:6px 10px;white-space:nowrap}.dwf button:hover{background:var(--dsw-alias-bg-layer-2)}.dwf button:disabled{opacity:.45;cursor:default}.dwf :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.dwf svg{display:inline-block;flex:none;vertical-align:middle}.dwf-muted{color:var(--dsw-alias-label-secondary)}.dwf-spacer{flex:1}.dwf-card{border:1px solid var(--dwf-line);border-radius:16px;background:var(--dsw-alias-bg-base);overflow:hidden}.dwf-head{display:flex;align-items:center;gap:10px;padding:14px 16px 10px}.dwf-heading{font-weight:650}.dwf-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}.dwf-icon-button{display:inline-flex;align-items:center;justify-content:center;border:0!important;background:transparent!important;padding:5px!important;min-width:28px;height:28px}.dwf-icon-button:hover{background:var(--dsw-alias-bg-layer-2)!important}.dwf-head-label{display:flex;align-items:center;gap:8px;min-width:0;border:0!important;background:none!important;padding:0!important}.dwf-meta{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.dwf-dot{display:inline-block;flex:none;width:11px;height:11px;border:1.5px solid var(--dsw-alias-label-secondary);border-radius:50%;background:var(--dsw-alias-bg-base)}.dwf-dot.completed{background:var(--dwf-green);border-color:var(--dwf-green)}.dwf-dot.running{background:var(--dwf-orange);border-color:var(--dwf-orange);box-shadow:0 0 0 4px color-mix(in srgb,var(--dwf-orange) 18%,transparent)}.dwf-dot.failed,.dwf-dot.needs_review{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dwf-stages{display:flex;gap:20px;padding:15px 20px 20px;overflow-x:auto}.dwf-stage{flex:1;min-width:175px;position:relative}.dwf-stage-heading{display:flex;align-items:center;gap:9px;min-height:24px;font-weight:600;white-space:nowrap}.dwf-stage-heading .dwf-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}.dwf-stage.linked:after{content:'';position:absolute;left:calc(100% - 2px);top:12px;width:22px;border-top:1px solid var(--dsw-alias-border-l2)}.dwf-stage.link-running:after{border-color:var(--dwf-orange)}.dwf .dwf-agent{display:flex;align-items:center;gap:9px;border:0;border-radius:24px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));padding:6px 9px;margin-top:12px;min-height:38px;width:100%;text-align:start}.dwf .dwf-agent:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}.dwf-agent-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.dwf-avatar{display:flex;align-items:center;justify-content:center;width:27px;height:27px;border-radius:9px;background:var(--dwf-teal);color:white;flex:none}.dwf-avatar.tone-1{background:#efa238}.dwf-avatar.tone-2{background:#6b8bd3}.dwf-avatar.tone-3{background:#a37bd1}.dwf-agent-end{display:flex;align-items:center;gap:8px;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dwf-spinner{display:block;width:15px;height:15px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dwf-orange);border-radius:50%;animation:dwf-spin 1s linear infinite}@keyframes dwf-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.dwf-spinner{animation:none}}
.dwf-empty{margin:0;padding:8px 18px 18px;color:var(--dsw-alias-label-secondary)}.dwf-backdrop{position:fixed;inset:0;background:rgb(0 0 0 / .16);z-index:90}.dwf-panel{position:fixed;z-index:91;top:16px;bottom:16px;right:16px;width:min(760px,calc(100vw - 32px));display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dwf-line);border-radius:16px;box-shadow:0 18px 80px rgb(0 0 0 / .14);overflow:hidden}.dwf-panel-bar{display:flex;align-items:center;gap:9px;padding:14px 18px;border-bottom:1px solid var(--dwf-line)}.dwf-panel-scroll{overflow:auto;flex:1;min-height:0}.dwf-run-head{padding:22px 24px 18px;border-bottom:1px solid var(--dwf-line)}.dwf-run-title-row{display:flex;align-items:center;gap:8px}.dwf-run-head h2{font-size:18px;line-height:1.4;margin:0;font-weight:650}.dwf-run-status{display:flex;align-items:center;gap:8px;margin:14px 0;color:var(--dsw-alias-label-secondary)}.dwf-run-status.completed{color:var(--dwf-green)}.dwf-result-summary{padding:16px 24px 18px;border-bottom:1px solid var(--dwf-line)}.dwf-section-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 8px}.dwf-result-summary p{margin:0;color:var(--dsw-alias-label-secondary)}.dwf-timeline{list-style:none;margin:0;padding:26px 24px 32px 30px}.dwf-node{position:relative;padding:0 0 26px 24px;border-left:1px solid var(--dsw-alias-border-l2)}.dwf-node:last-child{padding-bottom:0;border-left-color:transparent}.dwf-node>.dwf-dot{position:absolute;left:-6px;top:7px;width:12px;height:12px}.dwf-node-heading{display:flex;align-items:center;gap:8px;min-height:26px}.dwf-node-heading strong{font-size:16px;font-weight:650}.dwf-node-heading .dwf-count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary)}.dwf-node .dwf-agent{border:0!important;padding:7px 10px;margin-top:12px}.dwf-node .dwf-agent:hover{background:var(--dsw-alias-bg-layer-2)}.dwf-output{margin-top:12px}.dwf-output pre,.dwf-definition pre{font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-1);padding:14px;border-radius:8px;max-height:300px;overflow:auto;user-select:text}.dwf-short-id{font:11px ui-monospace,monospace;overflow-wrap:anywhere}.dwf-settings{padding:22px 24px;border-bottom:1px solid var(--dwf-line)}.dwf-settings h3{font-size:16px;margin:0 0 16px}.dwf-controls{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.dwf-field{display:flex;flex-direction:column;gap:6px;min-width:0}.dwf-field.grow{flex:1;min-width:180px}.dwf-field span{font-size:12px;color:var(--dsw-alias-label-secondary)}.dwf-field input,.dwf-field select,.dwf-history{border:1px solid var(--dwf-line);border-radius:7px;background:var(--dsw-alias-bg-base);padding:8px 10px;width:100%}.dwf-settings-row{display:flex;align-items:center;gap:12px;margin:16px 0;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}.dwf-model-select{max-width:100%;min-width:210px;border:0;border-radius:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)!important;font:inherit}.dwf-stepper{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary)}.dwf-stepper input{width:40px;text-align:center;border:0;background:transparent;font:inherit;appearance:textfield;-moz-appearance:textfield}.dwf-stepper input::-webkit-inner-spin-button{appearance:none}.dwf-stepper button{border:0;background:transparent}.dwf-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:18px}.dwf-primary{background:var(--dsw-alias-label-primary)!important;color:var(--dsw-alias-bg-base)!important;border-color:transparent!important;font-weight:600}.dwf-notice{font-size:12px;color:var(--dsw-alias-label-secondary);padding:9px 12px;background:var(--dsw-alias-bg-layer-1);border-radius:8px;margin:12px 0}.dwf-error{margin:12px 18px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;overflow-wrap:anywhere}.dwf-definition{padding:16px 24px;border-top:1px solid var(--dwf-line)}.dwf-definition summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.dwf-footer{padding:12px 24px;border-top:1px solid var(--dwf-line);font-size:11px;color:var(--dsw-alias-label-secondary)}
.dwf-head{padding:10px 16px 4px}.dwf-head .dwf-icon-button{height:24px;min-width:24px}.dwf-stages{padding:8px 16px 15px}.dwf-stage{flex:0 0 160px;min-width:160px}.dwf-stage-heading{font-size:12px;min-height:20px}.dwf-stage-heading .dwf-count{margin-left:0}.dwf-stage .dwf-agent{margin-top:8px;min-height:30px;padding:5px 8px}.dwf-stage .dwf-avatar{width:20px;height:20px;border-radius:7px}.dwf-stage .dwf-avatar svg{width:14px;height:14px}.dwf-stage.linked:after{display:none}.dwf-connector{flex:1;min-width:12px;border-top:1px solid var(--dsw-alias-border-l2);margin-right:-20px}.dwf-stage.link-running .dwf-connector{border-color:var(--dwf-orange)}
.dwf-launcher{position:fixed;top:100px;right:18px;z-index:25;width:250px;display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--dwf-line);border-radius:13px;background:var(--dsw-alias-bg-base);box-shadow:0 4px 10px rgb(0 0 0 / .07);font-size:14px;color:var(--dsw-alias-label-secondary)}.dwf-placement-launcher{width:0;height:0;margin:0}.dwf-placement-inline{margin:12px 0 20px}.dwf-card-results{padding:0 16px 16px}.dwf .dwf-result-link{display:inline-flex;align-items:center;gap:9px;border:0;background:var(--dsw-alias-bg-layer-1);font-size:12px;text-align:start;white-space:normal}.dwf-result-link svg{color:#4ca6ce}.dwf-tool-meta{font-size:12px;color:var(--dsw-alias-label-secondary)}.dwf-tool-meta summary{cursor:pointer}
@media(max-width:600px){.dwf-placement-launcher{width:auto;height:auto}.dwf-launcher{position:static;width:auto;box-shadow:none;border:0;padding:0}.dwf-launcher>span:first-child{display:none}.dwf-head{gap:7px;padding:12px}.dwf-head>.dwf-title,.dwf-head>.dwf-meta{display:none}.dwf-stages{padding:12px;gap:18px}.dwf-stage{min-width:170px}.dwf-panel{inset:8px;width:auto;border-radius:12px}.dwf-run-head,.dwf-settings,.dwf-result-summary{padding:18px}.dwf-timeline{padding:24px 18px 28px 23px}.dwf-node-heading strong{font-size:14px}.dwf-agent-end .dwf-task-label{display:none}}
`;
    function icon(name, size = 16) {
      const paths = { workflow: 'M3 3h6v6H3z M15 15h6v6h-6z M6 9v6a3 3 0 0 0 3 3h6', sliders: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6', expand: 'M14 3h7v7 M21 3l-7 7 M10 21H3v-7 M3 21l7-7', close: 'M5 5l14 14 M19 5L5 19', refresh: 'M20 7v5h-5 M19 12a7 7 0 1 0-2 5', check: 'M8 12l3 3 5-6', chevron: 'M6 9l6 6 6-6', save: 'M5 3h12l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8' };
      if (name === 'stop') return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true }, h('rect', { x: 5, y: 5, width: 14, height: 14, rx: 2, fill: 'currentColor' }));
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, name === 'check' && h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: paths[name] || paths.workflow }));
    }
    function WorkflowDock({ t, workflowSessionId: sessionId, workflowRemote: remote, workflowOpenSession: openSession, placement = 'launcher', initialRun, fixedRunId }) {
      const [open, setOpen] = useState(false);
      const [runs, setRuns] = useState(initialRun ? [initialRun] : []);
      const [selectedId, setSelectedId] = useState(fixedRunId || '');
      const [detail, setDetail] = useState(null);
      const [path, setPath] = useState('');
      const [selection, setSelection] = useState('');
      const [concurrency, setConcurrency] = useState(1);
      const [catalog, setCatalog] = useState(null);
      const [catalogError, setCatalogError] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [nodeOutput, setNodeOutput] = useState(null);
      const [requestedOutput, setRequestedOutput] = useState('');
      const [copied, setCopied] = useState(false);
      const [configuration, setConfiguration] = useState(false);
      const dialogRef = useRef(null);
      const alive = useRef(true);
      const epoch = useRef(0);
      const outputRequest = useRef(0);
      const pending = useRef(new Set());
      const command = useCallback(async (args) => {
        const controller = new AbortController();
        pending.current.add(controller);
        try {
          if (args.action === 'list' || args.action === 'status') {
            const response = await fetch(`/api/dynamic-workflow/read?sessionId=${encodeURIComponent(sessionId)}&args=${encodeURIComponent(JSON.stringify(args))}`, { credentials: 'same-origin', signal: controller.signal });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `Workflow query failed (${response.status})`);
            return data;
          }
          const response = await remote.commands.execute(sessionId, `/workflow ${JSON.stringify(args)}`, [], controller.signal);
          if (!response.ok) throw response.error;
          if (!response.value) throw new Error(t('unknownCommand'));
          const result = response.value.result;
          if (result.kind === 'error') throw new Error(result.text);
          return JSON.parse(result.text);
        } finally { pending.current.delete(controller); }
      }, [sessionId, remote, t]);
      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; epoch.current++; for (const controller of pending.current) controller.abort(); pending.current.clear(); };
      }, []);
      const refresh = useCallback(async () => {
        const version = ++epoch.current;
        try {
          const data = await command({ action: 'list' });
          if (!alive.current || version !== epoch.current) return;
          const history = [...data.runs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          setRuns(history);
          setSelectedId(id => history.some(run => run.runId === id) ? id : history[0]?.runId || '');
          setError('');
        } catch (failure) { if (alive.current && version === epoch.current) setError(failure.message || String(failure)); }
      }, [command]);
      useEffect(() => { refresh(); }, [refresh]);
      useEffect(() => { if (open) refresh(); }, [open, refresh]);
      useEffect(() => {
        if (!open) return;
        let cancelled = false;
        remote.session.modelCatalog().then(response => {
          if (!response.ok) throw response.error;
          if (!cancelled) { setCatalog(response.value); setCatalogError(''); }
        }).catch(failure => { if (!cancelled) setCatalogError(failure.message || String(failure)); });
        return () => { cancelled = true; };
      }, [open, remote]);
      useEffect(() => {
        if (!open) return;
        const previous = document.activeElement;
        const panel = dialogRef.current;
        panel?.querySelector('button')?.focus();
        function onKey(event) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
          if (event.key !== 'Tab') return;
          const controls = [...(panel?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') || [])];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        document.addEventListener('keydown', onKey, true);
        return () => { document.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus(); };
      }, [open]);
      let active = runs.find(run => run.runId === selectedId) || runs[0];
      if (fixedRunId) {
        active = runs.find(run => run.runId === fixedRunId);
        const seen = new Set();
        while (active && !seen.has(active.runId)) {
          seen.add(active.runId);
          const next = runs.find(run => run.resumedFrom === active.runId);
          if (!next) break;
          active = next;
        }
      }
      const isRunning = active?.status === 'running';
      useEffect(() => {
        if (!isRunning || busy) return;
        let cancelled = false;
        let timer;
        async function tick() {
          await refresh();
          if (!cancelled) timer = setTimeout(tick, 5000);
        }
        timer = setTimeout(tick, 1500);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [open, isRunning, busy, refresh]);
      useEffect(() => {
        outputRequest.current++;
        setDetail(value => value?.runId === active?.runId ? value : null); setNodeOutput(null); setCopied(false);
        if (!open || !active?.runId) return;
        let cancelled = false;
        command({ action: 'status', runId: active.runId }).then(value => {
          if (!cancelled) setDetail(value);
        }).catch(failure => { if (!cancelled) setError(failure.message || String(failure)); });
        return () => { cancelled = true; };
      }, [open, active?.runId, command]);
      useEffect(() => {
        if (!active) return;
        setSelection(active.model ? JSON.stringify([active.provider || '', active.model]) : '');
        setConcurrency(active.concurrency || 1);
        setPath(active.workflowPath || '');
      }, [active?.runId]);
      async function operate(action) {
        setError('');
        if (['run', 'revise'].includes(action) && !path.trim()) { setError(t('required')); return; }
        if (action !== 'stop' && (!Number.isInteger(Number(concurrency)) || Number(concurrency) < 1 || Number(concurrency) > 8)) { setError(t('invalidConcurrency')); return; }
        setBusy(true); epoch.current++;
        try {
          const args = { action };
          if (['run', 'revise'].includes(action)) args.workflowPath = path.trim();
          if (action !== 'run') args.runId = active.runId;
          if (action !== 'stop') {
            args.concurrency = Number(concurrency);
            if (selection) { const [provider, model] = JSON.parse(selection); if (provider) args.provider = provider; args.model = model; }
          }
          const result = await command(args);
          if (!alive.current) return;
          if (result.runId) setSelectedId(result.runId);
          if (action !== 'stop') setConfiguration(false);
          setOpen(true); await refresh();
        } catch (failure) { if (alive.current) setError(failure.message || String(failure)); }
        finally { if (alive.current) setBusy(false); }
      }
      async function showOutput(id) {
        setError('');
        const version = ++outputRequest.current;
        try {
          const result = await command({ action: 'status', runId: active.runId, nodeId: id });
          if (alive.current && version === outputRequest.current) setNodeOutput({ id, runId: active.runId, value: result.node });
        } catch (failure) { if (alive.current && version === outputRequest.current) setError(failure.message || String(failure)); }
      }
      useEffect(() => {
        if (open && requestedOutput && active?.runId) { void showOutput(requestedOutput); setRequestedOutput(''); }
      }, [open, requestedOutput, active?.runId]);
      async function copyDefinition() {
        try { await navigator.clipboard.writeText(JSON.stringify(detail.workflow, null, 2)); if (alive.current) setCopied(true); }
        catch (failure) { if (alive.current) setError(failure.message || String(failure)); }
      }
      if (!sessionId) return null;
      const workflow = detail?.runId === active?.runId ? detail?.workflow : undefined;
      const nodes = active?.nodes || {};
      const rawEntries = Object.entries(nodes);
      const groups = new Map();
      for (const [id, node] of rawEntries) {
        const groupId = node.agentStep?.groupId || id;
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push([id, node]);
      }
      const entries = [...groups].map(([id, group]) => {
        const collect = group.find(([, node]) => node.agentStep?.kind === 'collect');
        const members = group.filter(([, node]) => node.agentStep?.kind === 'member');
        if (!members.length) return collect || group[0];
        const gate = collect?.[1] || {};
        const memberStatus = ['running', 'needs_review', 'failed', 'interrupted', 'cancelled', 'blocked'].find(state => members.some(([, node]) => node.status === state));
        const stageStatus = gate.status === 'blocked' && memberStatus === 'failed' ? 'failed' : gate.status && gate.status !== 'pending' ? gate.status : memberStatus || 'pending';
        return [id, { ...gate, status: stageStatus,
          deps: members.flatMap(([, node]) => node.deps || []), stageMembers: members }];
      });
      const completed = entries.filter(([, node]) => node.status === 'completed').length;
      const working = entries.filter(([, node]) => node.status === 'running').length;
      const agentEntries = rawEntries.filter(([, node]) => node.reviewStep?.kind !== 'gate' && node.agentStep?.kind !== 'collect');
      const agentCount = new Set(agentEntries.map(([, node]) => node.agentSessionId).filter(Boolean)).size;
      const needsReview = rawEntries.some(([, node]) => node.status === 'needs_review');
      const workflowTitle = run => typeof run.title === 'string' && run.title.trim() ? run.title : run.workflowPath;
      const nodeTitle = (id, state) => [state.title, workflow?.nodes?.find(node => node.id === id)?.title].find(value => typeof value === 'string' && value.trim()) || id;
      const agentTitle = (id, state) => [state.agentTitle, workflow?.nodes?.find(node => node.id === id)?.agentTitle].find(value => typeof value === 'string' && value.trim()) || nodeTitle(id, state);
      const agentIdentity = (id, node) => node.agentId || node.agentSessionId || id;
      const capsuleAgents = [...new Set(agentEntries.map(([id, node]) => agentIdentity(id, node)))];
      const status = value => t(value) || value;
      const button = (label, onClick, more = {}) => h('button', { type: 'button', onClick, disabled: busy, ...more }, label);
      const iconButton = (name, label, onClick, more = {}) => button(icon(name), onClick, { className: 'dwf-icon-button', title: label, 'aria-label': label, ...more });
      const options = (catalog?.groups || []).map(group => h('optgroup', { key: group.id, label: group.name }, group.models.map(model => h('option', { key: model.id, value: JSON.stringify([group.id, model.id]) }, model.name))));
      if (selection && !(catalog?.groups || []).some(group => group.models.some(model => selection === JSON.stringify([group.id, model.id])))) options.push(h('option', { key: 'current', value: selection }, JSON.parse(selection).filter(Boolean).join(' / ')));
      const dot = state => h('span', { className: `dwf-dot ${state}`, 'aria-hidden': true });
      const nodeStatus = node => status(node.skipped ? 'skipped' : node.status);
      const count = node => node.stageMembers ? `${node.stageMembers.filter(([, member]) => member.status === 'completed').length}/${node.agentStep?.members?.length || node.stageMembers.length}` : node.skipped ? t('skipped') : `${node.status === 'completed' ? 1 : 0}/1`;
      const agentRow = (id, node, detailed = false) => {
        if (node.stageMembers) return node.stageMembers.map(([memberId, member]) => h(React.Fragment, { key: memberId }, agentRow(memberId, member, detailed)));
        if (node.agentStep?.kind === 'collect') return null;
        if (node.reviewStep?.kind === 'gate') return h('div', { className: 'dwf-review-gate' }, h('span', { className: 'dwf-meta' }, `${t('reviewGate')} · ${nodeStatus(node)}`));
        const agentName = agentTitle(id, node), name = node.roleTitle || agentName;
        const round = node.reviewStep ? ` · ${t('reviewRound')} ${node.reviewStep.round}/${node.reviewStep.maxRounds}` : '';
        const tone = capsuleAgents.indexOf(agentIdentity(id, node)) % 4;
        const avatar = h('span', { className: `dwf-avatar tone-${tone}`, 'aria-hidden': true }, h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor' }, h('path', { d: 'M4 13a4 4 0 0 1 8 0v5H4zm10 0a4 4 0 0 1 8 0v5h-8z' })));
        const end = h('span', { className: 'dwf-agent-end' }, detailed && h('span', { className: 'dwf-task-label' }, t('oneTask')), node.skipped ? h('span', { className: 'dwf-meta' }, t('skipped')) : node.status === 'completed' ? icon('check', 17) : node.status === 'running' ? h('span', { className: 'dwf-spinner', 'aria-hidden': true }) : h('span', { className: 'dwf-meta' }, nodeStatus(node)));
        const props = { className: 'dwf-agent', 'data-agent-id': agentIdentity(id, node), 'data-agent-session-id': node.agentSessionId,
          title: `${agentName} · ${name}${round} · ${nodeStatus(node)}${node.agentSessionId ? ` · ${node.agentSessionId}` : ''}` };
        const capsule = h('button', { ...props, type: 'button', disabled: !node.agentSessionId, 'aria-label': `${t('agentSession')} · ${agentName}`, onClick: () => {
          if (!node.agentSessionId) return;
          try {
            // A durable parent/child address also opens children absent from the local list.
            // The Session projection supplies its mode after the history opens.
            openSession({ parentSessionId: sessionId, childSessionId: node.agentSessionId, mode: 'unknown' });
            setOpen(false);
          } catch (failure) { setError(failure?.message || String(failure)); }
        } }, avatar, h('span', { className: 'dwf-agent-name' }, name, node.reviewStep && h('span', { className: 'dwf-meta' }, round)), end);
        if (!detailed) return capsule;
        return h('div', { className: 'dwf-agent-detail' }, capsule, iconButton('chevron', `${t('result')} · ${node.agentStep?.memberId || agentName}`, () => showOutput(id), { disabled: false }));
      };
      const stages = entries.length ? h('div', { className: 'dwf-stages', 'aria-label': t('stages') }, entries.map(([id, node], index) => {
        const next = entries[index + 1]?.[1], linked = next?.deps?.includes(id);
        return h('div', { key: id, className: `dwf-stage${linked ? ' linked' : ''}${linked && next.status === 'running' ? ' link-running' : ''}` }, h('div', { className: 'dwf-stage-heading' }, dot(node.skipped ? 'skipped' : node.status), h('span', null, nodeTitle(id, node)), h('span', { className: 'dwf-count' }, count(node)), linked && h('span', { className: 'dwf-connector', 'aria-hidden': true })), agentRow(id, node));
      })) : null;
      const runLabel = t(active?.status === 'running' ? 'workflowRunning' : active?.status === 'completed' ? 'workflowCompleted' : 'title');
      const compact = placement === 'launcher' ? h('div', { className: 'dwf-launcher' },
        h('span', null, t('workflow')),
        h('span', { className: 'dwf-spacer' }),
        iconButton('sliders', t('configure'), () => { setConfiguration(true); setOpen(true); }, { disabled: false }),
        iconButton('expand', t('open'), () => { setConfiguration(false); setOpen(true); }, { disabled: false })) : h('div', { className: 'dwf-card' },
        h('header', { className: 'dwf-head' },
          button(h(React.Fragment, null, icon('workflow'), h('span', { className: 'dwf-heading' }, runLabel)), () => setOpen(true), { className: 'dwf-head-label', disabled: false, 'aria-expanded': open, title: t('open') }),
          active && h('span', { className: 'dwf-title' }, workflowTitle(active)),
          h('span', { className: 'dwf-spacer' }),
          active && h('span', { className: 'dwf-meta' }, `${entries.length} ${t('stages')} · ${active.status === 'running' ? `${working} ${t('working')}` : agentCount ? `${agentCount} ${t('agents')}` : `${completed}/${entries.length} ${t('steps')}`}`),
          iconButton('sliders', t('configure'), () => { setConfiguration(true); setOpen(true); }, { disabled: false }),
          active?.status === 'running' ? iconButton('stop', t('stop'), () => operate('stop')) : iconButton('refresh', t('refresh'), refresh),
          iconButton('expand', t('open'), () => setOpen(true), { disabled: false })),
        stages,
        active?.status === 'completed' && entries.length > 0 && h('div', { className: 'dwf-card-results' }, button(h(React.Fragment, null, icon('save'), h('span', null, `${workflowTitle(active)} · ${t('output')}`)), () => { setConfiguration(false); setRequestedOutput(entries.at(-1)[0]); setOpen(true); }, { className: 'dwf-result-link', disabled: false })),
        !active && h('p', { className: 'dwf-empty' }, t('empty')), !open && error && h('p', { className: 'dwf-error', role: 'alert' }, error));
      function saveDefinition() {
        if (!workflow) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `${workflow.id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'workflow'}.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      const settings = h('section', { className: 'dwf-settings', 'aria-label': t('configure') },
        h('h3', null, t('configure')),
        !fixedRunId && runs.length > 0 && h('label', { className: 'dwf-field' }, h('span', null, t('history')), h('select', { className: 'dwf-history', value: selectedId, disabled: busy, onChange: event => setSelectedId(event.target.value) }, runs.map(run => h('option', { key: run.runId, value: run.runId }, `${status(run.status)} · ${workflowTitle(run)} · ${new Date(run.createdAt).toLocaleString()}`)))),
        h('div', { className: 'dwf-settings-row' }, h('span', null, t('model')), h('select', { className: 'dwf-model-select', 'aria-label': t('model'), value: selection, disabled: busy, onChange: event => setSelection(event.target.value), title: t('changed') }, h('option', { value: '' }, t('inherit')), ...options)),
        h('div', { className: 'dwf-settings-row' }, h('span', null, t('atMost')), h('div', { className: 'dwf-stepper' }, button('−', () => setConcurrency(value => Math.max(1, Number(value) - 1)), { disabled: busy || Number(concurrency) <= 1, 'aria-label': t('decrease') }), h('input', { type: 'number', min: 1, max: 8, step: 1, 'aria-label': t('concurrency'), value: concurrency, disabled: busy, onChange: event => setConcurrency(event.target.value) }), button('+', () => setConcurrency(value => Math.min(8, Number(value) + 1)), { disabled: busy || Number(concurrency) >= 8, 'aria-label': t('increase') })), h('span', null, t('parallelAgents'))),
        h('p', { className: 'dwf-notice' }, t('serialNodesNote')),
        h('p', { className: 'dwf-notice' }, t('modelNote')),
        catalogError && h('p', { className: 'dwf-error', role: 'alert' }, `${t('modelError')}: ${catalogError}`),
        (catalog?.failures || []).map(failure => h('p', { key: failure.id, className: 'dwf-meta' }, `${t('modelError')} · ${failure.name}: ${failure.message}`)),
        active && completed < entries.length && h('div', { className: 'dwf-toolbar' }, button(busy ? t('busy') : t(active.status === 'running' ? 'switch' : 'resume'), () => operate('resume'), { className: 'dwf-primary', disabled: busy || active.resumeSupported === false || needsReview || (entries.length > 0 && completed === entries.length) })),
        active && h('div', { className: 'dwf-controls' }, h('input', { type: 'text', value: path, 'aria-label': t('path'), placeholder: t('pathPlaceholder'), disabled: busy, onChange: event => setPath(event.target.value) }), button(t('revise'), () => operate('revise'), { disabled: busy || !path.trim() })),
        !fixedRunId && h('form', { className: 'dwf-controls', style: { marginTop: 18 }, onSubmit: event => { event.preventDefault(); operate('run'); } }, h('label', { className: 'dwf-field grow' }, h('span', null, t('path')), h('input', { type: 'text', value: path, placeholder: t('pathPlaceholder'), disabled: busy, onChange: event => setPath(event.target.value) })), h('button', { type: 'submit', className: 'dwf-primary', disabled: busy || !path.trim() }, busy ? t('busy') : t('start'))));
      const timeline = h('ol', { className: 'dwf-timeline' }, entries.map(([id, node]) => {
        const outputNode = nodeOutput?.runId === active.runId && (nodeOutput.id === id || node.stageMembers?.some(([memberId]) => nodeOutput.id === memberId)) ? nodeOutput : undefined;
        const output = outputNode?.value;
        const outputMember = node.stageMembers?.find(([memberId]) => memberId === outputNode?.id)?.[1];
        const value = output && Object.hasOwn(output, 'output') ? output.output : output;
        return h('li', { className: 'dwf-node', key: id }, dot(node.skipped ? 'skipped' : node.status),
          h('div', { className: 'dwf-node-heading' }, h('strong', null, nodeTitle(id, node)), node.reused && h('span', { className: 'dwf-meta' }, t('reused')), h('span', { className: 'dwf-count' }, count(node)), iconButton('chevron', `${t('result')} · ${nodeTitle(id, node)}`, () => showOutput(id))),
          agentRow(id, node, true),
          output !== undefined && h('div', { className: 'dwf-output' }, (outputMember?.agentSessionId || node.agentSessionId) && h('span', { className: 'dwf-short-id dwf-muted' }, `${t('agentSession')} ${outputMember?.agentSessionId || node.agentSessionId}${(outputMember?.continuations || node.continuations) > 0 ? ` · ${t('contextResumed')}` : ''}`), h('pre', null, typeof value === 'string' ? value : JSON.stringify(value, null, 2))));
      }));
      const panel = open && h(React.Fragment, null,
        h('div', { className: 'dwf-backdrop', onClick: () => setOpen(false) }),
        h('aside', { className: 'dwf-panel', ref: dialogRef, role: 'dialog', 'aria-modal': true, 'aria-label': active ? workflowTitle(active) : t('configure') },
          h('header', { className: 'dwf-panel-bar' }, icon('workflow'), h('strong', null, t('title')), active && h('span', { className: 'dwf-title' }, workflowTitle(active)), h('span', { className: 'dwf-spacer' }), iconButton('sliders', t('configure'), () => setConfiguration(value => !value), { disabled: false, 'aria-pressed': configuration }), iconButton('close', t('close'), () => setOpen(false), { disabled: false })),
          h('div', { className: 'dwf-panel-scroll' },
            active && !configuration && h('section', { className: 'dwf-run-head' }, h('div', { className: 'dwf-run-title-row' }, h('h2', null, workflowTitle(active)), h('span', { className: 'dwf-spacer' }), workflow && button(h(React.Fragment, null, icon('save'), ' ', t('save')), saveDefinition), button(h(React.Fragment, null, icon('stop'), ' ', t('stop')), () => operate('stop'), { disabled: busy || active.status !== 'running' })), h('div', { className: `dwf-run-status ${active.status}` }, dot(active.status), status(active.status)), h('div', { className: 'dwf-meta' }, `${completed}/${entries.length} ${t('steps')} · ${working} ${t('working')}`)),
            error && h('p', { className: 'dwf-error', role: 'alert' }, error),
            (configuration || !active) && settings,
            active && h(React.Fragment, null,
              needsReview && h('p', { className: 'dwf-notice' }, t('reviewNote')),
              active.resumeSupported === false && h('p', { className: 'dwf-notice' }, t('legacy')),
              active.contextWarning && h('p', { className: 'dwf-notice', title: active.contextWarning }, t('contextMissing')),
              active.error && h('p', { className: 'dwf-error', role: 'alert' }, active.error),
              active.status === 'completed' && !configuration && h('section', { className: 'dwf-result-summary' }, h('h3', { className: 'dwf-section-label' }, t('output')), h('p', null, t('completedNote'))),
              configuration ? h('section', { 'aria-label': t('selected') }, h('h3', { className: 'dwf-section-label', style: { padding: '20px 24px 0' } }, t('selected')), stages) : timeline,
              workflow && h('details', { className: 'dwf-definition' }, h('summary', null, t('script')), h('div', { className: 'dwf-toolbar' }, button(t(copied ? 'copied' : 'copy'), copyDefinition)), h('pre', null, JSON.stringify(workflow, null, 2))))),
          h('footer', { className: 'dwf-footer' }, t('saved'), active?.resumedFrom && h('span', { className: 'dwf-short-id' }, ` · ${t('from')} ${active.resumedFrom}`))));
      return h('section', { className: `dwf dwf-placement-${placement}`, 'aria-label': t('title') }, h('style', null, css), compact, panel);
    }
    const configCss = `
.dwf-config{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6}
.dwf-config *{box-sizing:border-box}.dwf-config-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:4px 0}
.dwf-config-copy{min-width:0}.dwf-config-label{display:block;font-size:14px;font-weight:600}.dwf-config p{margin:4px 0 0;color:var(--dsw-alias-label-secondary)}
.dwf-config .dwf-config-hint{font-size:12px}.dwf-config-control{display:flex;align-items:center;flex:none;gap:10px;padding-top:2px}.dwf-config-status{font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dwf-config button.dwf-config-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;flex:none;margin:0;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s ease}
.dwf-config button.dwf-config-switch[aria-checked="true"]{background:var(--dsw-alias-label-primary)}.dwf-config-switch-thumb{width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease;pointer-events:none}
.dwf-config-switch[aria-checked="true"] .dwf-config-switch-thumb{transform:translateX(16px)}.dwf-config button:disabled{cursor:default;opacity:.45}.dwf-config button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px}
.dwf-config .dwf-config-error{color:var(--dsw-alias-state-error-primary);font-size:12px}.dwf-config-notice{font-size:12px}
@media(max-width:480px){.dwf-config-row{gap:16px}.dwf-config-status{display:none}}@media(prefers-reduced-motion:reduce){.dwf-config-switch,.dwf-config-switch-thumb{transition:none!important}}
`;
    function WorkflowConfigView({ t, view, form }) {
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const saving = useRef(false);
      const state = form?.state;
      const ready = state?.status === 'ready';
      const writable = ready && state.writable;
      const enabled = state?.value?.globalEnabled === true;
      async function toggle() {
        if (!writable || saving.current) return;
        saving.current = true;
        setBusy(true); setError('');
        try {
          const accepted = await form.mutate([{ op: 'set', path: ['globalEnabled'], value: !enabled }], state.revision);
          if (accepted === false) setError(t('configSaveFailed'));
        } catch (failure) {
          setError(`${t('configSaveFailed')} ${failure?.message || String(failure)}`);
        } finally { saving.current = false; setBusy(false); }
      }
      if (view === 'summary') return t('configIntro');
      return h('section', { className: 'dwf-config', 'aria-label': t('title') },
        h('style', null, configCss),
        h('div', { className: 'dwf-config-row' },
          h('div', { className: 'dwf-config-copy' },
            h('strong', { className: 'dwf-config-label' }, t('globalMode')),
            h('p', null, t('globalModeNote')),
            h('p', { className: 'dwf-config-hint' }, t('globalModeCost'))),
          h('div', { className: 'dwf-config-control' },
            h('span', { className: 'dwf-config-status', role: 'status' }, ready ? t(enabled ? 'enabled' : 'disabled') : ''),
            h('button', { type: 'button', role: 'switch', 'aria-label': t('globalMode'), 'aria-checked': enabled, 'aria-busy': busy, className: 'dwf-config-switch', disabled: !writable || busy, onClick: toggle }, h('span', { className: 'dwf-config-switch-thumb', 'aria-hidden': true })))),
        !ready && h('p', { className: 'dwf-config-notice', role: state?.error ? 'alert' : 'status' }, state?.error || t(form ? 'configLoading' : 'configUnavailable')),
        ready && !writable && h('p', { className: 'dwf-config-notice', role: 'status' }, t('configReadOnly')),
        error && h('p', { className: 'dwf-config-error', role: 'alert' }, error));
    }
    function WorkflowToolCard(props) {
      const block = props.block;
      const text = props.phase === 'result' ? (block.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
      let args;
      try { args = JSON.parse(block.call?.argsRaw || '{}'); } catch { args = {}; }
      return h('details', { className: 'dwf-tool-meta' }, h('summary', null, props.t('title'), ' · ', args.action || props.phase), text && h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', fontSize: 12 } }, text.slice(0, 12000)));
    }
    function workflowResult(event) {
      if (event.type !== 'tool/result' || (event.surfaceOp && event.surfaceOp !== 'append')) return null;
      try {
        const value = JSON.parse((event.data.message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n'));
        return typeof value?.runId === 'string' && typeof value.workflowPath === 'string' && typeof value.status === 'string' ? value : null;
      } catch { return null; }
    }
    // A separate Conversation business row stays outside collapsed tool logs.
    // Its anchor and saved run are reconstructed from native committed events.
    const workflowDefinition = {
      kind: 'dynamic-workflow', target: 'chat',
      match: {
        'tool/call': event => {
          if (event.data.name !== 'dynamic_workflow') return null;
          try {
            const args = JSON.parse(event.data.arguments);
            return ['run', 'resume', 'revise'].includes(args.action) ? { id: String(event.data.callId), role: 'start' } : null;
          } catch { return null; }
        },
        'tool/result': event => workflowResult(event) ? { id: String(event.data.message.source.callId), role: 'update' } : null,
      },
      start: () => ({}),
      update: (context, match) => workflowResult(match.event) ? { run: workflowResult(match.event), seq: match.event.seq } : context.state,
      buildViewNode: context => {
        const state = context.state;
        if (!context.start || !state?.run) return null;
        return { key: context.key, kind: 'dynamic-workflow', id: context.id, target: 'chat', anchorSeq: state.seq,
          location: context.start.location, visibility: 'visible', groupTree: 'turn', data: { run: state.run } };
      },
    };
    function WorkflowConversationCard(props) {
      const run = props.node.data.run;
      return h(WorkflowDock, { ...props, placement: 'inline', initialRun: run, fixedRunId: run.runId });
    }
    function SessionWorkflowDock(props) {
      return props.workflowSessionId ? h(WorkflowDock, { ...props, key: props.workflowSessionId }) : null;
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'remote.settings', 'uiConversation', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dynamic-workflow: locale');
        function BundleConfigView(props) {
          const [state, setState] = useState({ status: 'loading', writable: false });
          const mounted = useRef(true);
          async function load() {
            try {
              const result = await ctx.remote.settings.describe();
              if (!result.ok) throw new Error(result.error?.message || props.t('configUnavailable'));
              const namespace = result.value.namespaces.find(item => item.ns === 'dynamic-workflow');
              if (!namespace) throw new Error(props.t('configUnavailable'));
              if (mounted.current) setState({ ...namespace, status: 'ready', writable: result.value.writable });
            } catch (failure) {
              if (mounted.current) setState({ status: 'error', writable: false, error: failure?.message || String(failure) });
            }
          }
          useEffect(() => {
            mounted.current = true;
            void load();
            return () => { mounted.current = false; };
          }, []);
          const form = { state, async mutate(ops, revision) {
            if (state.status !== 'ready' || !state.writable) throw new Error(props.t('configReadOnly'));
            const result = await ctx.remote.settings.mutate(state.ns, ops, revision);
            if (!result.ok) {
              await load();
              throw new Error(result.error?.message || props.t('configSaveFailed'));
            }
            if (mounted.current) setState({ ...result.value, status: 'ready', writable: state.writable });
            return true;
          } };
          return h(WorkflowConfigView, { ...props, form });
        }
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: '@local/dynamic-workflow', locale: NS,
        }, BundleConfigView));
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: '@local/dynamic-workflow#dynamic-workflow', locale: NS,
        }, WorkflowConfigView));
        ctx.effect(() => ctx.uiConversation.events.register(workflowDefinition), 'dynamic-workflow: conversation row');
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'dynamic-workflow', locale: NS, inject: sessionId => ({ workflowSessionId: sessionId, workflowRemote: ctx.remote, workflowOpenSession: target => ctx.uiWorkspace.openSession(target) }) }, WorkflowConversationCard));
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'dynamic_workflow', locale: NS, inject: sessionId => ({ workflowSessionId: sessionId, workflowRemote: ctx.remote }) }, WorkflowToolCard));
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities', id: 'dynamic-workflow', order: 25, locale: NS,
          inject: sessionId => ({ key: sessionId, workflowSessionId: sessionId, workflowRemote: ctx.remote, workflowOpenSession: target => ctx.uiWorkspace.openSession(target) }),
        }, SessionWorkflowDock));
      },
    };
  },
});
