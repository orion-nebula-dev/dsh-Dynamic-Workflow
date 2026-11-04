# Dynamic Workflow

[简体中文](README.md) | English

Run JSON DAG workflows in Harness with a progress UI, executor model selection, reuse of valid completed results, and persisted capsule Agent sessions that can continue across stages and model changes.

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
3. Select a **Subagent model** and concurrency, then click **Run workflow**. The model list comes from the current Harness configuration.
4. Select the run in **Run history** to inspect stage progress. Click an Agent row for its node result or **View workflow definition** to check the task.
5. To change models, select another model and click **Switch model and continue**. The next section describes the continuation rules.

When the assistant calls `dynamic_workflow` with `run` or `resume`, the plugin displays a workflow card in the corresponding message. The card shows stages, status connections, and Agent rows horizontally, with result links at the bottom after completion. Expand it to view a vertical timeline of stages and node results.

While a workflow runs, its card periodically reads node status. Displayed results come from the Host; read failures appear as errors. If the assistant creates a new run, use the refresh button to fetch the latest records.

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

## Capsule agents and stage roles

Each capsule represents one Agent. `agents` defines stable Agent identities, and a node's `agentId` binds it to an identity. Stages with the same `agentId` share a native Agent session ID, message history, and tool results.

Different Agents can run in parallel. Stages belonging to the same Agent execute serially in the DAG's stable topological order. Even if dependencies between successive stages are omitted, the executor will not activate that Agent concurrently.

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

The policy restricts both inherited tools and actual calls, including calls through tool wrappers. Tools registered by the child Agent itself may still appear in the directory, but cannot execute unless allowed. Explicit tool policies use native tool presentation. Roles do not change the parent session's tool permissions.

The bundled example uses two capsule Agents: the planning Agent acts as planner in the first stage and switches to writer in the third; an independent review Agent handles the second stage. Its three stages use two Agent sessions.

Legacy nodes without `agentId` retain separate Agent sessions. `agentTitle` only supplies a legacy display name; matching labels do not merge identities. New configurations should explicitly set `agentId` and `role`.

## Agent tool

The tool is named `dynamic_workflow`. The `/workflow` session command invokes the same Host operations.

| Action | Arguments | Purpose |
| --- | --- | --- |
| `run` | `workflowPath`; optional `model`, `provider`, `concurrency` | Read the file and run it, reusing valid existing results |
| `resume` | `runId`; optional `model`, `provider`, `concurrency` | Stop the old run and inherit its saved definition and progress |
| `status` | `runId`; optional `nodeId` | Inspect status, definition, node results, and Agent diagnostics |
| `models` | None | Query the currently available model directory |
| `stop` | `runId` | Cancel execution and wait for child Agent cleanup |
| `list` | None | Query the current session's run history |

`concurrency` ranges from 1 to 8. `run` defaults to 1. `resume` retains the original run's value unless explicitly overridden. Use actual model identifiers from the model directory.

## Persistence and limits

Run records, definitions, node snapshots, and their Agent identities are stored in Harness's `storageDomain`, isolated by parent session. Harness's native session persistence service stores Agent message history. History remains available after a plugin reload or Harness restart; viewing it does not execute nodes.

When `status` includes `nodeId`, its `agent` field reports the model used by that session's latest actual request, rather than only the workflow's selected model. While the Agent is running, it also includes recent assistant messages with a length limit. Historical and later runs can reference the same Agent, so these diagnostics reflect that session's latest request. Reading persisted diagnostics does not activate the Agent.

Workflow files are limited to 1 MiB and 100 nodes. Node details truncate long display content. Cache validity depends on the workflow definition and dependency results. When external material used by a task changes, the assistant should update the relevant inputs to avoid reusing stale results.

Stages are displayed by node. Dependencies include both explicit `deps` and implicit preceding stages of a shared Agent. Each activation reinstalls the stage role and tool policy, including before restoring the original Agent session after a restart.
