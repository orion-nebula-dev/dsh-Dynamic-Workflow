---
id: R-001
title: 串行逻辑节点与节点内多 Agent
tests:
  - core.test.mjs
  - index.test.mjs
  - client.test.mjs
---

# 串行逻辑节点与节点内多 Agent

## 需求

用户需要让工作流节点严格串行，同一节点中的多个 Agent 可以并行。collect 模式按成员 `id` 汇总结果。本文记录源码实现的验收契约，不表示 live 插件或 release 已生效。

## 定义与调度

- 顶层 `nodes` 按稳定拓扑顺序逐个执行；拓扑关系相同时保留定义顺序。当前逻辑节点内的执行结束后，才能开始下一逻辑节点。
- 旧式单 Agent 节点继续支持 `prompt` 或字符串 `input`，以及原有角色、模型、工具和结构化输出配置。
- 多 Agent 节点使用 `agents: [{id, agentId, prompt, role?, ...}]`。成员 `id` 在节点内唯一，`agentId` 引用顶层稳定 Agent 身份。成员可指定 `tools`、`provider`、`model`、`schema` 和 `retrySafe`。
- `node.agentConcurrency` 为 1 至 8 的整数，默认值为 `min(8, 成员数量)`。工具 `run` 的 `concurrency` 为 1 至 8，默认 1；`resume` 默认沿用保存值。实际成员并发不超过节点上限和运行上限的较小值。
- 运行 `concurrency` 不再控制顶层节点并发。工作流文件不支持顶层 `concurrency`，示例必须通过工具调用显式传值。
- 串行调度不为无关节点新增 `deps`。失败节点阻塞依赖它的后续节点；独立节点保留继续执行的行为。共享 Agent 原有的历史顺序约束仍然有效。

## 展开、结果与恢复

Host 在运行前静态展开成员。节点 `analyze` 的成员 `plan` 对应内部节点 `analyze/agent/plan`。原 `analyze` 保留为 collect 汇总门禁，等待成员全部成功，输出 `{ "plan": <成员结果> }`。键使用成员 `id`，不使用 `agentId` 或内部节点 ID。

内部成员元数据为 `agentStep: {groupId, memberId, kind: "member"}`。collect 元数据为 `agentStep: {groupId, kind: "collect", members: [成员id字符串]}`。元数据用于关联逻辑节点与内部成员；工作流作者填写公开的 `agents` 数组。

每个成员的执行状态、成功结果及 Agent 身份分别持久化。恢复或修订时，已成功且指纹有效的成员结果可复用；未完成成员沿用原有身份验证、会话续跑和 `retrySafe` 审核规则。collect 失败不能丢弃其他成员已成功的结果。

胶囊 Agent 继续跨阶段保留会话，同一身份不能并发激活。`reviewLoop` 保留原有有界审查、修复、提前通过、末轮失败及持久化语义。审查循环和多 Agent 展开均计入 100 个内部节点的限制。

## 验收与测试映射

| 测试文件 | 验收内容 |
| --- | --- |
| `core.test.mjs` | 稳定拓扑串行执行；同节点成员并行；运行与节点并发上限；非法字段及范围校验；collect 按成员 id 汇总；静态展开与节点数量限制；失败阻塞与独立节点兼容；成功成员持久化复用；胶囊和审查循环回归 |
| `index.test.mjs` | Host 工具 run/resume 参数及并发语义；定义、快照和成员状态传递；消息路由到活跃成员；旧入口与运行记录兼容 |
| `client.test.mjs` | 逻辑节点与成员展示；并发配置文案；成员状态及结果入口；旧单 Agent 与审查循环展示兼容 |

测试路径相对于插件仓库根目录。测试通过情况以实际测试输出为准。文档示例使用 `tools: []`，不依赖外部写入。
