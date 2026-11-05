# Dynamic Workflow

[简体中文](README.md) | English

Run JSON workflows in Harness with strictly serial logical nodes and optional parallel Agents within each node. Completed results can be persisted and reused. Capsule Agent sessions retain their history across stages and model changes.

This document describes the workflow contract for the current source tree. It does not indicate that an installed live plugin or a released version has been updated.

## Install

Clone the repository into your session's workspace:

```bash
git clone https://github.com/orion-nebula-dev/dsh-Dynamic-Workflow.git dynamic-workflow
```

In Harness plugin management, install the plugin bundle from the cloned `dynamic-workflow` directory and enable it.

## Commands and quick start

Enter commands in the session input box. `/workflow` alone shows command help; it does not open the Workflow UI.

| Command | Purpose |
| --- | --- |
| `/workflow` or `/workflow help` | Show command help |
| `/workflow run <path>` | Read a workflow file and run it, reusing valid existing results |
| `/workflow list` | List runs in the current session |
| `/workflow status <runId>` | Inspect a run's status |
| `/workflow resume <runId>` | Continue from the saved definition and progress |
| `/workflow revise <JSON>` | Stop the old run, load a new definition, and reuse compatible results |
| `/workflow stop <runId>` | Cancel execution and wait for child Agent cleanup |
| `/workflow models` | List currently available executor models |

After installation, run the bundled read-only example from the parent workspace containing the cloned directory:

```text
/workflow run dynamic-workflow/workflow.example.json
```

Paths resolve relative to the session's current working directory. Quote paths containing spaces. The example has three stages: create a plan, review it independently, then revise and deliver it.

The run command returns a `runId`; use it to query, stop, or continue that run. Use JSON arguments to specify a model, concurrency, or a node. Run `/workflow models` first, then replace the placeholders with actual identifiers from its output:

```text
/workflow {"action":"run","workflowPath":"dynamic-workflow/workflow.example.json","provider":"<provider>","model":"<model>","concurrency":2}
/workflow {"action":"resume","runId":"<runId>","provider":"<provider>","model":"<model>"}
/workflow {"action":"status","runId":"<runId>","nodeId":"<nodeId>"}
```

The old `/dynamic-workflow` command remains available as a compatibility entry point.

## View progress and choose a model

1. Open **Workflow** in the upper-right corner of the session to view run details.
2. Open **Run configuration** and enter a **Workflow file path**, such as `dynamic-workflow/workflow.example.json` for the bundled example.
3. Select a **Subagent model** and the concurrency limit for Agents within a node, then click **Run workflow**. The model list comes from the current Harness configuration.
4. Select the run in **Run history** to inspect stage progress. Click an Agent row for its node result or **View workflow definition** to check the task.
5. To change models, select another model and click **Switch model and continue**. The next section describes the continuation rules.

When the assistant calls `dynamic_workflow` with `run` or `resume`, the plugin displays a workflow card in the corresponding message. The card shows stages, status connections, and Agent rows horizontally, with result links at the bottom after completion. Expand it to view a vertical timeline of stages and node results.

While a workflow runs, its card periodically reads node status. Displayed results come from the Host; read failures appear as errors. If the assistant creates a new run, use the refresh button to fetch the latest records.

To send follow-up guidance to a running node, use the `message` action of `dynamic_workflow` or the `/workflow` JSON command below (no shorthand is available). `runId`, `nodeId`, and `message` are required; the message must be nonempty and at most 12,000 characters. Use `status` to confirm the node ID first. A workflow `agentId`, such as `ship`, is not a Team teammate name; address the message with `runId` and `nodeId`.

```text
/workflow {"action":"message","runId":"<runId>","nodeId":"<nodeId>","message":"Check the actual state of the failed operation before continuing."}
```

Messages go only to the existing live child Agent of a node whose status is `running`. Completed or pending nodes and nodes without a live child Agent reject messages. This action does not wake completed Agents, restart the run, or change models or roles. The response `{runId,nodeId,agentSessionId,messageId,accepted:true}` means the inbox accepted the message, not that the task is finished. Use `status` afterward to check progress and results.

## Switch models and continue

Select another model and click **Switch model and continue**. The plugin stops the old run, waits for child Agent cleanup, then creates a new run record that inherits the original progress. It reuses completed node results that are still valid. For unfinished nodes whose definitions are unchanged, it resumes the original Agent session after identity and fingerprint checks pass, applying the selected model before the first new request.

Continuation uses Harness's native subagent conversation support. It preserves the same Agent session ID and persisted messages, tool results, and context. Node details show the session ID and indicate that the original session was resumed after successful continuation. This does not transfer server-side model KV caches, streaming fragments that have not been persisted, or the state of running processes.

The model selection applies to this run and does not change the parent session's model setting. Select **Keep existing model configuration** to retain the existing run and node settings. When there is no explicit model configuration, the session model is used.

Once the original session passes validation, unfinished nodes can continue in that session without `retrySafe`. The continuation prompt asks the Agent to check the actual state of interrupted operations before acting again. Restoring history cannot guarantee that external operations execute exactly once.

For older records without a saved Agent identity, only valid completed results can be retained. Unfinished nodes follow the existing retry and review rules: interrupted nodes whose effects could be repeated become `needs_review`. Set `retrySafe: true` only after confirming that repeating the operation is acceptable. The bundled read-only example already sets this option.

If a record has a saved identity but the original Agent session cannot be found, the plugin reports an error instead of creating a replacement Agent. Identity or fingerprint mismatches also do not bypass review.

## Global automatic workflow mode

Global automatic workflow mode is off by default in plugin configuration. When enabled, every human message in a root session receives a lightweight classification from the current session model before the assistant proceeds. Ordinary messages continue directly; multi-step tasks receive an instruction to create a workflow; requirement changes first stop and drain the active run before the assistant revises it. Child Agents and tool results do not trigger this classifier again.

This adds one model request per human message. The plugin classifies, stops, and supplies revision context; the parent model still creates or revises the JSON workflow through `dynamic_workflow`. Keep compatible node IDs and the workflow ID when revising so completed results can be fingerprint-checked and reused. Stage role prompts and tool permissions are reapplied before each stage activation. If Agent history or fingerprints are incompatible, the plugin does not silently replace the Agent; the parent should report the triggering message and why the stage cannot be reused.

## Change a task

When new requirements change the task, ask the assistant to check the current status, stop execution, edit the workflow JSON, and run it again. Keep node `id` values stable to allow reuse of their results.

Appended stages can continue using the original capsule Agent. Executed stages that share an Agent have real conversation history. Changing an executed stage's prompt, role, tools, or dependencies causes a history mismatch error. To execute the changed workflow from the beginning, use a new workflow `id`.

Legacy independent nodes without `agentId` keep the original behavior: changing a node invalidates its cached result and the results of its successors, which then execute again.

**Continue workflow** uses the definition saved with the run. After editing the JSON on disk, use **Run workflow** to read the new definition.

## Workflow file

```json
{
  "id": "example",
  "title": "Plan and review",
  "nodes": [
    {
      "id": "plan",
      "title": "Create a plan",
      "prompt": "Return a short plan only. Do not call tools or modify files.",
      "retrySafe": true
    },
    {
      "id": "review",
      "title": "Review the plan",
      "deps": ["plan"],
      "prompt": "Review the plan in Dependencies and suggest one improvement. Do not call tools or modify files.",
      "retrySafe": true
    }
  ]
}
```

`id` is the workflow's stable identifier. `nodes` is an array of nodes, each with a unique `id`. Use `deps` to reference prerequisite node IDs. Results from dependencies are passed to successor nodes as JSON data.

Nodes can specify `provider`, `model`, and a structured output `schema`. If a node omits model configuration, it uses the run or session configuration.

## Serial nodes and multiple Agents per node

Nodes run one at a time in stable topological order, preserving definition order when topology permits. The current node finishes before the next node is processed. Serial scheduling adds no `deps` between unrelated nodes: a failure blocks its dependent successors, while independent nodes can still run.

Use an `agents` array for a multi-Agent node with collect mode:

```json
{
  "id": "analyze",
  "agentConcurrency": 2,
  "agents": [
    { "id": "plan", "agentId": "planner", "prompt": "Propose a plan.", "tools": [] },
    { "id": "risk", "agentId": "reviewer", "prompt": "List risks.", "tools": [] }
  ]
}
```

Each member has an `id` unique within its node, an `agentId` referring to a stable identity in top-level `agents`, and a task `prompt`. An optional `role` refers to a top-level role. Members can also specify `tools`, `provider`, `model`, `schema`, and `retrySafe`. `agentConcurrency` is an integer from 1 to 8 and defaults to `min(8, member count)`, still bounded by the run's concurrency limit.

The Host statically expands members into `analyze/agent/plan` and `analyze/agent/risk`. The original `analyze` node remains a collect gate. It waits for all members to succeed and returns an object keyed by member `id`, such as `{"plan":"plan result","risk":"risk result"}`. Successors depend on `analyze` to receive the collected result. Member results are persisted separately, so valid successful results can be reused on continuation. To send a `message` to an active member, use its internal node ID returned by `status`, such as `analyze/agent/plan`.

The [multi-Agent example](workflow.multi-agent.example.json) collects two analyses in parallel, then runs delivery serially. All roles and members have empty tool lists. Pass these arguments to the `dynamic_workflow` tool to explicitly allow two members to run in parallel:

```json
{"action":"run","workflowPath":"dynamic-workflow/workflow.multi-agent.example.json","concurrency":2}
```

You can also append these JSON arguments to `/workflow`. Running only the file path defaults to concurrency 1; `agentConcurrency: 2` in the file cannot raise the run limit.

## Capsule agents and stage roles

Each capsule represents one Agent. Top-level `agents` defines stable Agent identities. A node or node member binds to an identity through `agentId`. Stages with the same `agentId` share a native Agent session ID, message history, and tool results.

All logical nodes execute one at a time in stable topological order. Agents can run in parallel only within the same multi-Agent node. The same Agent is always activated serially.

`roles` defines stage roles. Each role has a `prompt` and optional `title` and `tools`. Nodes reference a role through `role`. Before each activation, the executor installs the current role's system prompt and tool policy. Afterward, it clears them before installing the next stage's role. Switching roles preserves history, so earlier prompts may remain in historical context. The capsule shows the current role; its avatar color and hover information correspond to the stable Agent identity.

```json
{
  "id": "two-stage-agent",
  "agents": { "worker": { "title": "Collaborating Agent" } },
  "roles": {
    "plan": { "title": "Planner", "prompt": "Create a plan first.", "tools": [] },
    "write": { "title": "Writer", "prompt": "Use the plan in your history to write the deliverable.", "tools": ["read"] }
  },
  "nodes": [
    { "id": "plan", "agentId": "worker", "role": "plan", "prompt": "Propose a plan." },
    { "id": "deliver", "agentId": "worker", "role": "write", "deps": ["plan"], "prompt": "Complete the deliverable." }
  ]
}
```

`tools` lists allowed Harness tool names, which must be available in the current composition. An empty list (`[]`) disables all tool calls for that stage; omitting it inherits available tools. A node's `tools` overrides the role's list.

The policy restricts both inherited tools and actual calls, including calls through tool wrappers. Tools registered by the child Agent itself may still appear in the directory, but cannot execute unless allowed. Tool calls use the executor configured by the current Host. Roles do not change the parent session's tool permissions.

The bundled example uses two capsule Agents: the planning Agent acts as planner in the first stage and switches to writer in the third; an independent review Agent handles the second stage. Its three stages use two Agent sessions.

Legacy nodes without `agentId` retain separate Agent sessions. `agentTitle` only supplies a legacy display name; matching labels do not merge identities. New configurations should explicitly set `agentId` and `role`.

## Bounded review and fix loops

Use `reviewLoop` in `nodes` to have an independent Agent review an artifact and return it to the developer when changes are needed:

```json
{
  "id": "quality",
  "deps": ["implement"],
  "reviewLoop": {
    "maxRounds": 3,
    "review": { "agentId": "reviewer", "role": "review", "prompt": "Check the artifact against the acceptance rules. Approve if satisfied; otherwise report verifiable issues." },
    "fix": { "agentId": "developer", "role": "fix", "prompt": "Revise the artifact using the findings and return the complete revised text." }
  }
}
```

Define `agents` and `roles` at the top level as before. `review` and `fix` must use different `agentId` values. The fix stage can reuse the same `developer` as `implement`, retaining its conversation history. Review and development use separate sessions but share the workspace; this provides neither file isolation nor a guarantee that Bash is read-only.

- `maxRounds` defaults to 3 and must be a safe integer from 1 to 50, including the initial review. Three rounds allow at most `review1 → fix1 → review2 → fix2 → review3`. A value of 1 runs only the review, with no fix.
- An `approved` verdict skips the remaining rounds, which appear as skipped. If the final review still returns `changes-required`, the `quality` gate fails and a `deliver` node depending on `quality` does not run.
- `review` and `fix` are node templates. They cannot contain `id`, `deps`, or a nested `reviewLoop`. The runtime supplies the review output `schema`; it cannot be overridden.

A review must return JSON, for example:

```json
{
  "verdict": "changes-required",
  "findings": [{ "message": "Missing verification step", "evidence": "The artifact has only goal and action lines, with no verification line." }]
}
```

`verdict` must be `approved` or `changes-required`. Approval requires an empty `findings` array. A rejection requires at least one finding, each with a `message` and verifiable `evidence`. Additional properties are allowed. Invalid output is an execution failure and does not automatically trigger a fix. Approve artifacts that satisfy the rules; do not invent issues to keep the loop running.

Before execution, the Host statically expands the loop into internal nodes such as `${id}/review/1` and `${id}/fix/1`. The expanded workflow is still limited to 100 nodes. Each round is persisted independently for continuation after interruption. The original `quality` ID remains the aggregate gate for downstream dependencies. On success, its `output` is the final review report.

The [text review example](workflow.review-loop.example.json) sets `tools: []` on every role and writes no files. Its initial draft deliberately omits a verification line. The reviewer reports findings against explicit rules, the developer revises the text, and delivery runs only after approval. Run it manually with a real model to check the flow:

```text
/workflow run dynamic-workflow/workflow.review-loop.example.json
```

## Agent tool

The tool is named `dynamic_workflow`. The `/workflow` session command invokes the same Host operations.

| Action | Arguments | Purpose |
| --- | --- | --- |
| `run` | `workflowPath`; optional `model`, `provider`, `concurrency` | Read the file and run it, reusing valid existing results |
| `resume` | `runId`; optional `model`, `provider`, `concurrency` | Stop the old run and inherit its saved definition and progress |
| `status` | `runId`; optional `nodeId` | Inspect status, definition, node results, and Agent diagnostics |
| `message` | `runId`, `nodeId`, `message` | Send a message to a running node's existing live child Agent |
| `models` | None | Query the currently available model directory |
| `stop` | `runId` | Cancel execution and wait for child Agent cleanup |
| `list` | None | Query the current session's run history |

`concurrency` limits the number of Agents running within the current node, from 1 to 8. It no longer allows top-level nodes to run concurrently. `run` defaults to 1. `resume` retains the original run's value unless explicitly overridden. A node's `agentConcurrency` can lower this limit; effective concurrency is at most the smaller of the two values. The workflow JSON file does not support a top-level `concurrency` field. Pass it through the tool call or `/workflow` JSON arguments. Use actual model identifiers from the model directory.

## Persistence and limits

Run records, definitions, node snapshots, and their Agent identities are stored in Harness's `storageDomain`, isolated by parent session. Harness's native session persistence service stores Agent message history. History remains available after a plugin reload or Harness restart; viewing it does not execute nodes.

When `status` includes `nodeId`, its `agent` field reports the model used by that session's latest actual request, rather than only the workflow's selected model. While the Agent is running, it also includes recent assistant messages with a length limit. Historical and later runs can reference the same Agent, so these diagnostics reflect that session's latest request. Reading persisted diagnostics does not activate the Agent.

Workflow files are limited to 1 MiB and 100 nodes after Host expansion. Node details truncate long display content. Cache validity depends on the workflow definition and dependency results. When external material used by a task changes, the assistant should update the relevant inputs to avoid reusing stale results.

Stages are displayed by node. Dependencies include both explicit `deps` and implicit preceding stages of a shared Agent. Each activation reinstalls the stage role and tool policy, including before restoring the original Agent session after a restart.
