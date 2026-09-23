# Working on Agent Graph Runtime

These are repository-specific rules for developing AGR. Follow the user's
instructions and inherited collaboration/safety rules. This file is the shared
repository source of truth; avoid duplicating it in nested instruction files.

## Choose the execution context first

- For work **on AGR**, use the project skill
  [agr-development](.agents/skills/agr-development/SKILL.md) for non-trivial
  implementation, cross-module diagnosis, and independent review.
- When executing an **AGR-owned graph node**, complete only that node's contract.
  Do not invoke the development team, spawn nested agents, or duplicate graph
  nodes. The node prompt, ownership, checks, and human gates constrain the work.
- For operating a graph, use `skills/agent-graph-runtime/SKILL.md`. A graph run and
  a Codex development session are separate workflows, even in the same checkout.

## Development team

The root owns the user outcome, architecture, decomposition, integration, and
final acceptance. Delegate bounded work when it provides parallel speed,
specialization, context isolation, or independent challenge. Keep trivial edits
local. Use `explorer`, `worker`, `tester`, `reviewer`, and `researcher` from
`.codex/agents/`; do not create all five mechanically.

Before non-trivial work, state scope, non-goals, assumptions, risks, acceptance
criteria, and how each criterion will be observed. Give every delegated slice one
owner and a bounded brief. Parallel writers must own disjoint files. Only one
agent may rebuild or test the shared `dist` at a time. Children return findings
to the root rather than spawning their own teams.

Broad or high-risk work requires a fresh-context independent reviewer with the
original request and final artifact. The root inspects the result directly,
resolves material findings, and verifies the final state. Reports are claims;
passing unit tests alone do not prove a CLI journey or real provider integration.

## Mandatory development work logs

Every participant, including the root, must produce a factual work journal for
each development task, including root-only work. Before substantive work, the root
creates `.agent-graph/development/<UTC-timestamp>-<task-slug>/index.md` and assigns
each participant a unique ID, journal path, and delivery mode. The root owns the
index; each participant has a separate `<participant-id>.md`. Reuse that task's
directory on resume, and give replacement agents new IDs.

Record start/scope, meaningful progress, decisions with brief rationale, changed
files, verification commands and observed results, blockers, and the final handoff.
Include UTC timestamps, author, status, and next action. Append at each milestone
or status change and at least every 60 seconds during active work when tools allow;
after a blocking tool returns, record its result promptly. Keep entries concise.

Workers/testers write only their assigned journals in addition to owned task files.
Read-only explorer/researcher/reviewer agents send their own `WORK_LOG` entries to
the root via the collaboration message tool; the root promptly appends them to
their journals with both author and recorder identified. Never widen permissions
just for logging, and never invent a child's activity. If messaging is unavailable,
return the entries in the handoff and mark delayed delivery. Report storage failures
immediately; preserve unsaved entries in messages and report the logging gap.

Use the format and completion checks in `docs/development.md#work-logs`. Logs
contain observable actions and concise decision summaries, never hidden reasoning,
credentials, personal data, full prompts, or raw provider/tool output. They are
local, Git-ignored development records, separate from AGR run evidence. Do not
rewrite history; append corrections. Logs do not prove acceptance by themselves.
The root must reconcile each participant's final status, disclose missing entries,
and link the index in its final response. Missing required logs block an unqualified
completion claim, not unrelated safe work.

## Repository map and checks

See [docs/development.md](docs/development.md) for the subsystem map, role routing,
workflow, commands, and validation boundaries. Start with `README.md` and
`docs/SPEC.md`; graph contracts also live in
`skills/agent-graph-runtime/references/graph-format.md`.

Use Node.js 22+ and the pinned pnpm version. After `pnpm install --frozen-lockfile`,
build with `pnpm build`; run focused compiled tests, then the CI-equivalent suite
when runtime behavior changes:

```sh
node --test --test-concurrency=1 dist/test/*.test.js
npm pack --dry-run
```

Do not run builds concurrently. Use synthetic fixtures and fake providers in
tests; a live authenticated provider run needs explicit task authorization.

## Runtime invariants

- The graph owns dependencies, acceptance, retries, ownership, and human gates.
  Never replace deterministic checks or accepted evidence with model claims.
- Preserve public graph schemas and CLI exit codes. Contract changes need
  explicit scope and matching documentation/compatibility evidence.
- Preserve dirty user work, immutable attempt evidence, graph-hash checks,
  descendant invalidation, and exact invocation identity for model observations.
- Keep review nodes read-only. External actions require opt-in and exact human
  authorization. Never approve on the user's behalf.
- Keep `codex`, native `claude`, and `claudex` distinct; Claudex owns its routing.
  Runtime nodes must not acquire hidden subagent orchestration.
- Fail closed on uncertain process cleanup, ownership escape, and unsafe recovery.
  Inspect partial effects before an explicit retry; never edit run state by hand.
- Progress output is observability only. Do not expose prompts, reasoning,
  secrets, raw tool arguments, or sensitive provider output in operator messages.

## Change safety

Inspect status and relevant instructions before editing; preserve unrelated work.
Do not publish, deploy, migrate/delete user data, spend money, use production
secrets, or break public contracts without explicit authorization. Do not commit
runtime evidence, credentials, local caches, or generated `dist`.

If an isolated checkout is needed, put it under `.worktrees/<name>` and add
`.worktrees/` to the primary checkout's `.git/info/exclude` first. Do not create
worktrees solely to satisfy process. If `.codegraph/` exists, use CodeGraph before
text search to locate code; do not create an index automatically.
