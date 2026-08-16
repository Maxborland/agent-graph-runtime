---
name: agent-graph-runtime
description: Runs and resumes dependency-graph coding workflows through the local agr CLI, Codex CLI, native Claude Code, or Claudex while preserving ownership, evidence, checks, and human gates. Use when the user asks for graph engineering, autonomous multi-agent implementation, resumable agent work, or execution of an .agent-graph graph.
---

# Agent Graph Runtime

Use the deterministic `agr` runtime as the source of truth. Do not recreate run
state, dependencies, approvals, or evidence only in conversation.

## Start or resume

1. Locate the requested graph, defaulting to `.agent-graph/graph.json`.
2. Run `agr doctor <graph>` and `agr validate <graph>`. Stop on every failure.
3. Run `agr plan <graph>`; inspect objective, waves, ownership, checks,
   external-action setting, and repository. Surface unsafe scope.
4. Run `agr run <graph> --verbose` and remain attached to that shell task until
   it reaches a terminal state. The runtime prints node transitions, safe tool
   names, explicit node milestones, and a heartbeat; silence is not completion.
5. Read `agr inspect <graph>`, `agr why <graph>`, and the referenced evidence
   files. Treat model handoffs as claims; report only checks actually captured
   by the runtime.

`agr run` invokes installed `codex exec`, native `claude -p`, or `claudex`.
Never duplicate a runtime-owned node or substitute `claude` and `claudex`.
Claudex denies `Workflow`, `Task`, `Agent`, and all Bash except standalone
`agr progress`; represent independently accepted work as graph nodes.

## Shell-task monitoring

- If `agr run` is backgrounded, retain its task ID and wait for its terminal
  notification or attach with `agr follow <graph>`; launch is not completion.
- When a long-lived follow shell is unavailable, retain the returned `cursor`
  and loop with `agr wait <graph> --after <cursor> --timeout-ms 60000 --json`.
  Update every cursor. Never end the turn while the returned status is `running`;
  timeout means poll again.
- Use `agr inspect <graph>` for the compact active-node/milestone view and `agr
  why <graph>` for structured recovery guidance. Reconcile persisted state with
  the original run shell instead of launching a replacement.
- Stop only at `completed`, `failed`, `needs_attention`, `awaiting_approval`,
  `cancelled`, or a concrete observation blocker.
- Never start a second `agr run` for the same run ID. The runtime lock rejects
  duplicate ownership. Use `agr cancel <graph>` or Ctrl+C for cooperative
  process-tree termination; a cancelled run exits with code 130. Inspect partial
  effects, then use `agr retry <node> <graph>` before resuming a cancelled node.
- Use `agr unlock <graph> --force` only after the user verifies the recorded
  owner stopped; foreign-host and PID-reused locks fail closed.

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

- Exit code 5 and status `needs_attention` mean a node returned `partial` or
  `blocked`, or the runtime cannot safely retry it. Inspect its evidence and
  partial effects; never start another attempt automatically.
- `agr run <graph>` recovers ordinary nodes left running after interruption.
  An interrupted `external_action` stays retry-blocked until its partial effects
  are inspected and `agr retry` is invoked explicitly.
- Use `agr events`, `agr logs [node]`, and `agr report` instead of reading raw
  runtime files by hand. `agr runs` lists persisted runs.
- Use `agr retry <node-id> <graph>` only when the user or verified evidence
  requires re-execution. It invalidates that node and every descendant.
- Never edit `state.json` or `events.jsonl` manually.
- Never revert unexpected repository changes automatically. Preserve them and
  report the ownership failure.
- Never add `model` to a Claudex node. Its launcher owns model, effort, proxy,
  compaction, and context-window configuration.

## Passive advisor

- Inspect configured advice with `agr advisor status <graph>`; it is read-only,
  non-authoritative, and never replaces checks.
- After blocker reconciliation, use `agr advisor acknowledge <graph>`; this
  neither retries nor accepts a node.
- Ordinary advisor failure continues; write escape or uncertain termination
  fails closed and requires inspected acknowledgement.

## Authoring graphs

Read [references/graph-format.md](references/graph-format.md) when creating or
changing a graph. Keep graphs small, use explicit dependencies, declare
lockfiles/generated outputs, and require runtime acceptance for user-facing
work.

## Completion

Say complete only for `completed` with every required node `accepted`; report
all other states exactly as recorded.
