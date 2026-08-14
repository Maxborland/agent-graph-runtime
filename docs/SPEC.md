# Agent Graph Runtime — behavioral specification

## Goal

Provide a local, resumable graph runtime that executes repository work through
the installed Codex CLI and Claude Code CLI, while keeping dependencies,
ownership, evidence, verification, and human authorization outside agent
conversation state.

## Users and outcome

The primary user is a developer or product owner running a multi-step change in
a trusted Git repository. They define a small task graph, run one command, and
receive an auditable result that maps each accepted node to its executor output,
changed files, and deterministic checks.

## Non-goals

- No hosted control plane, web UI, issue-tracker integration, or deployment.
- No automatic invention of product requirements or task dependencies.
- No cross-worktree merge automation in v1; one run owns one repository checkout.
- No claim that CodeGraph context, agent handoffs, or model review prove correctness.
- No bypass of Codex or Claude permission systems.

## Public interfaces

- `agr validate [graph]`: validate graph structure, dependencies, cycles, and
  concurrent ownership conflicts.
- `agr run [graph]`: create or resume a run and execute ready nodes until the
  graph completes, fails without retry capacity, or reaches a human gate.
- `agr status [graph]`: render current run and node states without mutation.
- `agr approve <node> <target> [graph]`: record explicit approval for one human
  gate and its exact target, then allow a later `run` to continue.
- `agr install-skills [--project DIR | --user]`: install the bundled open-agent
  skill for Codex and Claude Code discovery locations.

The graph file is JSON. Runtime state is stored under
`.agent-graph/runs/<run-id>/` as an append-only `events.jsonl`, an atomically
rewritten `state.json`, executor outputs, prompts, and evidence.

## Acceptance criteria

- **AC1 Graph validity:** Duplicate node IDs, missing dependencies, cycles,
  invalid executors/types, and ownership conflicts among nodes that could be
  ready together are rejected before any executor starts.
- **AC2 Readiness:** A node starts only after all dependencies are accepted.
  Ready nodes with non-overlapping ownership may run concurrently up to the
  configured limit.
- **AC3 Real adapters:** Agent nodes invoke `codex exec` or `claude -p` in the
  graph repository. Both receive a structured-output schema and least-privilege
  mode: implementation is workspace-scoped; review is read-only.
- **AC4 Structured handoff:** An agent process is successful only when it exits
  zero and returns a valid handoff with `status`, `summary`, `changedFiles`,
  `verification`, and `gaps`. Agent claims alone never accept a node.
- **AC5 Ownership:** After an execution wave finishes, Git-reported changed
  files must be covered by that wave's disjoint reserved ownership. Each agent's
  claimed changed files must also be covered by its own `owns` patterns.
  Unexpected paths fail the node and are reported; the runtime never reverts
  them automatically.
- **AC6 Deterministic verification:** Every configured check runs directly in
  the repository. A nonzero exit fails the attempt. Captured command, exit code,
  and bounded output are written as evidence.
- **AC7 Recovery:** Re-running `agr run` after process interruption reconstructs
  state from disk. Nodes left `running` become `ready` with an interrupted
  attempt event; already accepted nodes are not repeated.
- **AC8 Retry and invalidation:** A failed agent node retries only up to
  `maxAttempts`. Re-executing a previously accepted node invalidates every
  downstream acceptance and its evidence.
- **AC9 Human authority:** `human_gate` and `external_action` nodes never run on
  model authority. Approval is scoped to one node and exact target. External
  actions are disabled unless the graph opts in and the gate was explicitly
  approved through `agr approve`.
- **AC10 Context:** When requested, the runtime asks the locally installed
  CodeGraph for status, symbol search, impact, and affected tests. Missing or
  stale/unavailable CodeGraph produces a labeled fallback, not fabricated
  context or a failed run.
- **AC11 Skills:** Bundled skill instructions are under 100 lines, use the open
  `SKILL.md` format, and tell Codex/Claude to operate the deterministic CLI rather
  than recreating graph state in conversation.
- **AC12 Final status:** A run is complete only when every required node is
  accepted. The final report distinguishes completed, failed, blocked,
  awaiting-approval, and unverified states.

## Failure behavior and edge cases

- Executor binary missing: fail the node with an actionable error; do not try a
  different provider.
- Invalid or truncated JSON output: fail the attempt and retain raw output.
- Check timeout: terminate the child process, mark the check failed, retain
  bounded stdout/stderr.
- Dirty repository at start: allowed, but its baseline changed-file set is
  recorded and excluded from ownership attribution for later nodes.
- Concurrent nodes: ownership is reserved before spawn. A conservative overlap
  check may serialize safe work, but must not run ambiguous ownership in parallel.
- Same-checkout concurrency cannot prove which process authored a path that was
  reserved to another node in the same wave. Use `maxConcurrency: 1` for strict
  per-process attribution; isolated worktree merge automation is a v1 non-goal.
- Secret values: environment is inherited by the native CLIs; the runtime does
  not serialize environment variables or prompt contents into the final report.
- Review nodes: must declare no writable ownership and use read-only tools.

## Assumptions

- Node.js 22+ and Git are installed.
- Codex/Claude authentication is already configured by the user.
- The repository is trusted and each run uses a dedicated checkout when the
  surrounding product requires isolation.
- Shell checks are authored by the graph owner and therefore are trusted local
  configuration; graph files from untrusted repositories must be reviewed first.

## Traceable test plan

- AC1 → `validate rejects malformed and cyclic graphs`; `validate rejects
  overlapping parallel ownership`.
- AC2 → `scheduler only returns dependency-ready non-overlapping nodes`.
- AC3/AC4 → adapter contract tests using fake `codex` and `claude` executables;
  optional installed-CLI smoke with read-only fixture.
- AC5 → `node fails when new Git paths escape ownership`.
- AC6 → `checks gate acceptance and persist bounded evidence`.
- AC7 → `interrupted run resumes without repeating accepted nodes`.
- AC8 → `retry stops at maxAttempts`; `rerun invalidates descendants`.
- AC9 → `human gate stops run until exact approval`; `external action remains
  disabled without opt-in`.
- AC10 → `CodeGraph unavailable returns labeled fallback`.
- AC11 → skill validation and project/user installer tests.
- AC12 → CLI integration fixture covering complete, failed, and awaiting states.
