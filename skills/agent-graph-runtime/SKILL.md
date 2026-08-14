---
name: agent-graph-runtime
description: Runs and resumes dependency-graph coding workflows through the local agr CLI, Codex CLI, native Claude Code, or Claudex while preserving ownership, evidence, checks, and human gates. Use when the user asks for graph engineering, autonomous multi-agent implementation, resumable agent work, or execution of an .agent-graph graph.
---

# Agent Graph Runtime

Use the deterministic `agr` runtime as the source of truth. Do not recreate run
state, dependencies, approvals, or evidence only in conversation.

## Start or resume

1. Locate the requested graph, defaulting to `.agent-graph/graph.json`.
2. Run `agr validate <graph>`. Stop on every validation error.
3. Inspect the objective, node ownership, checks, external-action setting, and
   repository path. Surface any surprising or unsafe scope before execution.
4. Run `agr run <graph>` and wait for it to reach a terminal state.
5. Read `agr status <graph>` and the referenced evidence files. Treat model
   handoffs as claims; report only checks actually captured by the runtime.

`agr run` directly invokes installed `codex exec`, native `claude -p`, or
proxy-routed `claudex` adapters. Do not spawn duplicate agents around a node
already owned by the runtime. Treat `claude` and `claudex` as separate executor
identities; never substitute one when another fails.

## Human gates

Exit code 2 means the run is awaiting exact authorization. Show the node ID,
target, consequence, and evidence accumulated so far. Never approve for the
user. After the user explicitly authorizes that exact target, run:

```text
agr approve <node-id> <exact-target> <graph>
agr run <graph>
```

New scope or a different target requires new authorization.

## Correction and recovery

- `agr run <graph>` recovers nodes left running after interruption.
- Use `agr retry <node-id> <graph>` only when the user or verified evidence
  requires re-execution. It invalidates that node and every descendant.
- Never edit `state.json` or `events.jsonl` manually.
- Never revert unexpected repository changes automatically. Preserve them and
  report the ownership failure.
- Never add `model` to a Claudex node. Its launcher owns model, effort,
  subagent, proxy, compaction, and context-window configuration.

## Authoring graphs

Read [references/graph-format.md](references/graph-format.md) when creating or
changing a graph. Keep graphs small, use explicit dependencies, declare
lockfiles/generated outputs, and require runtime acceptance for user-facing
work.

## Completion

Say complete only when the run status is `completed` and all required nodes are
`accepted`. Report failed, blocked, awaiting-approval, or unverified nodes
exactly as recorded.
