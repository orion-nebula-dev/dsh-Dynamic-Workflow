# Dynamic Workflow

简体中文 | [English](README.en.md)

在 Harness 中运行 JSON 工作流。逻辑节点严格串行，同一节点内的多个 Agent 可以并行，完成结果可持久化并复用。同一个胶囊代理可以跨阶段保留 Agent 会话和历史，每个阶段使用对应的角色提示词和工具策略。

本文描述当前源码的工作流契约，不表示已安装的 live 插件或已发布版本已更新。

## 安装

克隆仓库到会话的工作目录，并在 Harness 插件管理中选择克隆后的 `dynamic-workflow` 目录安装插件包：

```bash
git clone https://github.com/orion-nebula-dev/dsh-Dynamic-Workflow.git dynamic-workflow
```

插件启用后，在会话输入框使用 `/workflow`。

## 命令与快速开始

在会话输入框输入 `/workflow` 查看用法。单独输入该命令会返回帮助；图形面板通过会话右上角的「工作流」入口打开。

| 命令 | 操作 |
| --- | --- |
| `/workflow` 或 `/workflow help` | 查看命令用法 |
| `/workflow run <JSON文件路径>` | 读取文件并启动工作流 |
| `/workflow list` | 查看当前会话的运行记录和 `runId` |
| `/workflow status <runId>` | 查看阶段进度和节点状态 |
| `/workflow resume <runId>` | 使用保存的定义和进度继续执行 |
| `/workflow revise <JSON>` | 停止旧运行，读取新定义并按条件复用结果 |
| `/workflow stop <runId>` | 停止运行并等待子 Agent 清理 |
| `/workflow models` | 查看可用模型的 `provider` 和 `model` 标识 |

安装完成后，在克隆目录的上级工作区运行附带的只读示例：

```text
/workflow run dynamic-workflow/workflow.example.json
```

示例包含「制定任务方案」「独立检查方案」和「按意见修订并交付」三个节点。路径相对于会话的当前工作目录解析，含空格时可以加引号。运行命令会返回 `runId`，后续查询、停止和继续操作使用这个标识。

需要指定模型、并发数或节点时，使用 JSON 参数。先运行 `/workflow models`，再用返回的实际标识替换下面的占位符：

```text
/workflow {"action":"run","workflowPath":"dynamic-workflow/workflow.example.json","provider":"<provider>","model":"<model>","concurrency":2}
/workflow {"action":"resume","runId":"<runId>","provider":"<provider>","model":"<model>"}
/workflow {"action":"status","runId":"<runId>","nodeId":"<nodeId>"}
```

旧命令 `/dynamic-workflow` 保留为兼容入口。

## 查看进度与选择模型

1. 点击会话右上角的「工作流」，打开详情面板。
2. 打开「运行配置」，填写「工作流文件路径」。可以输入 `dynamic-workflow/workflow.example.json` 运行附带示例。
3. 选择「子 Agent 模型」和节点内同时运行的 Agent 数量上限，再点击「运行工作流」。模型列表来自 Harness 当前配置。
4. 在「运行记录」中选择本次运行，查看阶段进度。点击代理行查看节点结果，或点击「查看工作流定义」核对任务。
5. 需要换模型时，选择新模型并点击「切换模型并继续」。具体恢复规则见下一节。

助手调用 `dynamic_workflow` 的 `run` 或 `resume` 后，对应消息中会显示工作流卡片。卡片横向展示阶段、状态连线和代理行，完成后在底部提供结果入口。展开后以纵向时间线显示阶段及节点结果。

工作流运行时，卡片定时读取节点状态。显示内容以 Host 返回值为准；读取失败时显示错误。通过命令或助手创建运行后，可以打开面板或点击刷新按钮获取记录。

向正在运行的节点补充说明时，使用 `dynamic_workflow` 的 `message` 操作，或下面的 `/workflow` JSON 命令（无简写形式）。`runId`、`nodeId` 和 `message` 均为必填；消息不能为空，最多 12,000 个字符。先用 `status` 确认节点 ID；工作流中的 `agentId`（例如 `ship`）不是 Team 队友名称，发送消息应使用 `runId` 和 `nodeId`。

```text
/workflow {"action":"message","runId":"<runId>","nodeId":"<nodeId>","message":"请先核实失败操作的实际状态，再继续处理。"}
```

消息只会发送给状态为 `running` 的节点当前已有的活跃子 Agent。已完成、待执行或没有活跃子 Agent 的节点会拒绝消息；此操作不会唤醒已完成的 Agent、重启运行或更改模型和角色。返回 `{runId,nodeId,agentSessionId,messageId,accepted:true}` 表示收件箱已接收消息，不代表任务已完成；后续用 `status` 查看进度和结果。

## 切换模型并继续

选择新模型，再点击「切换模型并继续」。插件先停止旧运行，等待子 Agent 清理完成，再创建继承原运行的新记录。已完成且有效的节点结果会复用；定义未变、身份及指纹验证通过的未完成节点，会恢复原 Agent 会话，并在第一次新请求前应用所选模型。

恢复使用 Harness 原生子 Agent 续聊能力，保留同一个 Agent 会话 ID，以及已持久化的消息、工具结果和上下文。节点详情显示会话 ID，成功续跑后显示「原会话续跑」。这不迁移模型服务端的 KV 缓存、尚未持久化的流式片段或正在执行的进程状态。

模型选择属于本次运行，不会改变会话的模型设置。选择「沿用已有模型配置」时，继续使用已有运行和节点的模型配置；没有显式配置时沿用会话模型。

原会话验证通过后，未完成节点可以在同一会话内继续，无须将节点标为 `retrySafe`。续聊提示要求 Agent 先核实中断操作的实际状态，避免重复执行；历史恢复不能保证外部操作恰好执行一次。

如果旧记录没有保存 Agent 身份，只能保留有效的完成结果，未完成节点按原有重试和审核规则处理：可能重复产生影响的中断节点标为 `needs_review`；确认允许重复执行后，才设置 `retrySafe: true`。只读示例已设置这个选项。已经保存身份但无法找到原会话时，插件会报错，不会自动创建新 Agent 替代；身份或指纹不匹配也不会绕过审核。

## 全局自动工作流

插件配置中的「全局自动工作流」默认关闭。打开后，每条主会话用户消息都会先由当前会话模型进行一次轻量判断：普通消息直接交给主会话；多步骤任务会提示主会话创建工作流；已有工作流运行时，改变目标或约束的消息会先停止并等待子 Agent 清理，再提示主会话修订工作流。子 Agent 和工具返回不会再次触发这层判断。

自动判断会增加一次模型请求。插件只负责分类、停止和传递修订上下文，工作流定义仍由主会话模型通过 `dynamic_workflow` 创建或修订。修订时应保持兼容节点的 `id` 和工作流 `id`，以便校验并复用有效结果；阶段角色提示词和 tools 会在每次阶段激活前重新应用。若历史或指纹不兼容，插件不会静默替换 Agent，主会话需要说明触发消息和不可复用原因。

## 修改任务

新要求改变任务内容时，让助手查询当前状态、停止运行，然后修改工作流 JSON 并重新运行。保持节点 `id` 稳定，才能复用相应结果。追加阶段可以继续使用原胶囊代理。已经运行过的共享代理阶段保留了真实会话历史，修改该阶段的提示词、角色、工具或依赖后，插件会报告历史不匹配；如需从头执行修改后的流程，应使用新的工作流 `id`。未配置 `agentId` 的旧式独立节点仍按原规则使修改节点及其后继缓存失效并重新执行。

「继续工作流」使用运行中保存的定义。修改磁盘上的 JSON 后，应使用「运行工作流」读取新定义。

## 工作流文件

```json
{
  "id": "example",
  "title": "方案与评审",
  "nodes": [
    {
      "id": "plan",
      "title": "制定方案",
      "prompt": "只输出一份简短方案，不调用工具或修改文件。",
      "retrySafe": true
    },
    {
      "id": "review",
      "title": "检查方案",
      "deps": ["plan"],
      "prompt": "检查 Dependencies 中的方案，输出一条改进意见。不调用工具或修改文件。",
      "retrySafe": true
    }
  ]
}
```

`id` 是工作流的稳定标识。`nodes` 是节点数组，节点 `id` 必须唯一。`deps` 填写前置节点的 `id`。节点可以指定 `provider`、`model` 和结构化输出 `schema`；省略模型时使用运行或会话配置。前置节点的结果会以 JSON 数据传给后继节点。

## 串行节点与节点内多 Agent

节点按稳定拓扑顺序逐个运行；拓扑关系相同时保留定义中的顺序。当前节点结束后，才处理下一个节点。串行调度不会给无关节点添加 `deps`：失败只阻塞依赖它的后续节点，独立节点仍可继续运行。

多 Agent 节点使用 `agents` 数组，采用 collect 模式：

```json
{
  "id": "analyze",
  "agentConcurrency": 2,
  "agents": [
    { "id": "plan", "agentId": "planner", "prompt": "提出方案。", "tools": [] },
    { "id": "risk", "agentId": "reviewer", "prompt": "列出风险。", "tools": [] }
  ]
}
```

每个成员的 `id` 在节点内唯一，`agentId` 引用顶层 `agents` 中的稳定身份，`prompt` 指定任务。可选 `role` 引用顶层角色；成员还可指定 `tools`、`provider`、`model`、`schema` 和 `retrySafe`。`agentConcurrency` 是 1 至 8 的整数，默认值为 `min(8, 成员数量)`，仍受运行并发上限限制。

Host 将成员静态展开为 `analyze/agent/plan`、`analyze/agent/risk`。原 `analyze` 节点保留为 collect 汇总门禁，等待全部成员成功，再按成员 `id` 输出对象，例如 `{"plan":"方案结果","risk":"风险结果"}`。后续节点依赖 `analyze` 即可取得汇总结果。成员结果分别持久化，恢复时可复用已成功且有效的成员结果。向活跃成员发送 `message` 时，使用 `status` 返回的内部成员节点 ID，例如 `analyze/agent/plan`。

[多 Agent 示例](workflow.multi-agent.example.json) 先并行收集两份分析，再串行交付。所有角色和成员均使用空工具列表。通过 `dynamic_workflow` 工具传入以下参数，显式允许两个成员并行：

```json
{"action":"run","workflowPath":"dynamic-workflow/workflow.multi-agent.example.json","concurrency":2}
```

也可以使用 `/workflow` 加上述 JSON 参数。仅运行文件路径时默认并发为 1；文件中的 `agentConcurrency: 2` 不会提高运行上限。

## 胶囊代理与阶段角色

每个胶囊代表一个 Agent。顶层 `agents` 定义稳定代理，节点或节点成员的 `agentId` 绑定该身份；相同 `agentId` 的阶段共用同一个原生 Agent 会话 ID、消息历史和工具结果。所有逻辑节点按稳定拓扑顺序逐个运行；并行仅发生在同一多 Agent 节点内。同一代理始终串行激活。

`roles` 定义阶段角色。每个角色包含 `prompt`，可选 `title` 和 `tools`。节点用 `role` 引用角色；执行器在每次唤醒 Agent 前安装当前角色的系统提示词与工具策略，结束后清理，再为下一阶段安装新角色。切换角色保留历史，旧提示词仍可能作为历史上下文存在。胶囊显示当前角色，头像颜色和悬浮信息对应稳定代理。

```json
{
  "id": "two-stage-agent",
  "agents": { "worker": { "title": "协作代理" } },
  "roles": {
    "plan": { "title": "方案设计师", "prompt": "先制定方案。", "tools": [] },
    "write": { "title": "交付编写者", "prompt": "沿用方案历史，编写交付内容。", "tools": ["read"] }
  },
  "nodes": [
    { "id": "plan", "agentId": "worker", "role": "plan", "prompt": "提出方案。" },
    { "id": "deliver", "agentId": "worker", "role": "write", "deps": ["plan"], "prompt": "完成交付。" }
  ]
}
```

`tools` 是允许调用的 Harness 工具名称列表，工具必须在当前组合中可用。`[]` 禁止本阶段所有工具调用；省略则沿用可用工具。节点的 `tools` 可以覆盖角色的列表。策略会同时限制继承的工具和实际调用，不能借工具封装通道绕过；子 Agent 自己注册的工具可能仍出现在目录中，但未获允许时无法执行。工具调用使用当前 Host 配置的工具执行器。角色不会修改父会话的工具权限。

附带示例使用两个胶囊代理：方案代理在第一阶段担任方案设计师，在第三阶段切换为交付编写者；评审代理独立执行第二阶段。三阶段对应两个 Agent 会话。

没有 `agentId` 的旧节点保持各自独立的 Agent 会话。`agentTitle` 只用于旧式显示名称；同名标签不会自动合并身份。新配置应显式填写 `agentId` 和 `role`。

## 有界审查与修复

在 `nodes` 中使用 `reviewLoop`，让独立 Agent 审查产物，并在需要修改时交回开发 Agent：

```json
{
  "id": "quality",
  "deps": ["implement"],
  "reviewLoop": {
    "maxRounds": 3,
    "review": { "agentId": "reviewer", "role": "review", "prompt": "检查产物是否满足验收规则。满足则 approved，否则给出可核实的问题。" },
    "fix": { "agentId": "developer", "role": "fix", "prompt": "根据 findings 修订产物，返回完整修订稿。" }
  }
}
```

`agents` 和 `roles` 仍在顶级定义。`review` 与 `fix` 必须使用不同的 `agentId`；`fix` 可以复用 `implement` 的 `developer`，保留其会话历史。审查与开发使用不同会话，但共享工作区；这不提供文件隔离，也不保证 Bash 只读。

- `maxRounds` 默认是 3，必须是 1 至 50 的安全整数，次数包含初审。3 轮最多执行 `review1 → fix1 → review2 → fix2 → review3`；设为 1 时只审查，不修复。
- 任一轮返回 `approved` 后，剩余轮次显示为跳过。末轮仍为 `changes-required` 时，`quality` 门禁失败，依赖 `quality` 的 `deliver` 不执行。
- `review` 和 `fix` 是节点模板，不能包含 `id`、`deps` 或嵌套 `reviewLoop`。审查的输出 `schema` 由运行时提供，不能覆盖。

审查必须返回 JSON，例如：

```json
{
  "verdict": "changes-required",
  "findings": [{ "message": "缺少验证说明", "evidence": "产物只有目标和操作两行，没有验证行。" }]
}
```

`verdict` 只能是 `approved` 或 `changes-required`。通过时 `findings` 必须为空数组；不通过时至少有一条，每条必须包含 `message` 和可核实的 `evidence`。可以添加其他属性。格式不合法属于执行失败，不会自动进入修复。产物满足规则就应通过，无须每轮制造问题。

Host 在运行前静态展开为 `${id}/review/1`、`${id}/fix/1` 等内部节点；展开后的总节点数仍不得超过 100。每轮独立持久化，支持断点继续。原 `quality` ID 保留为下游依赖的汇总门禁，成功时 `output` 是最终审查报告。

[文本审查示例](workflow.review-loop.example.json) 的所有角色均设置 `tools: []`，不写文件。初稿故意缺少验证行；审查按明确规则输出 findings，开发 Agent 修订后再审查，通过后才交付。可手动运行真实模型检查流程：

```text
/workflow run dynamic-workflow/workflow.review-loop.example.json
```

## 助手工具

工具名为 `dynamic_workflow`。界面通过 `/workflow` 会话命令调用同一组 Host 操作。

| 操作 | 参数 | 用途 |
| --- | --- | --- |
| `run` | `workflowPath`，可选 `model`、`provider`、`concurrency` | 读取文件并运行，复用有效的既有结果 |
| `resume` | `runId`，可选 `model`、`provider`、`concurrency` | 停止旧运行并继承保存的定义和进度 |
| `status` | `runId`，可选 `nodeId` | 查询状态、定义、节点结果和 Agent 诊断 |
| `message` | `runId`、`nodeId`、`message` | 向正在运行的节点已有的活跃子 Agent 发送消息 |
| `models` | 无 | 查询当前可用的模型目录 |
| `stop` | `runId` | 取消执行并等待子 Agent 清理 |
| `list` | 无 | 查询当前会话的运行历史 |

`concurrency` 是当前节点内同时运行的 Agent 数量上限，范围为 1 至 8，不再控制顶层节点并发。`run` 默认使用 1；`resume` 沿用原运行的值，除非显式指定。节点的 `agentConcurrency` 可以进一步降低上限，实际并发不超过两者的较小值。工作流 JSON 不支持顶层 `concurrency`；请通过工具调用或 `/workflow` JSON 参数传入。模型值应使用实际模型列表中的标识，不要将「会话当前模型」等界面文案当成模型标识。

## 持久化与限制

运行记录、定义、节点快照及节点对应的 Agent 身份保存在 Harness 的 `storageDomain` 中，并按父会话隔离。Agent 消息历史由 Harness 原生会话持久化服务保存。插件重载或 Harness 重启后可以查看历史；查看历史不会自动执行节点。

`status` 指定 `nodeId` 时，`agent` 返回对应会话最新实际请求的模型，而非仅返回工作流选择值。Agent 仍在运行时还包含有长度上限的最近助手消息。历史运行与后续运行可以引用同一 Agent，因此这里反映该会话的最新请求；读取持久化诊断不会激活 Agent。

工作流文件最多 1 MiB，Host 展开后最多 100 个节点。节点详情会截断较长的展示内容。缓存根据工作流定义和依赖结果判断是否有效；任务依赖的外部资料变化时，应由助手更新相应输入，避免复用过期结果。

阶段按节点展示；依赖关系包含节点的 `deps` 和共享代理的隐式前置阶段。每次激活会重新安装阶段角色与工具策略，重启后也会在原 Agent 会话恢复前安装。
