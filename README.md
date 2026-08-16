# Agent Graph Runtime

`agr` is a local, resumable task-graph runtime that invokes the installed Codex
CLI, native Claude Code CLI, or proxy-routed Claudex launcher. The graph, not
any model's conversation, owns
dependencies, retries, path ownership, checks, evidence, and human approvals.

Current status: working local v0.7.0, not published to npm.

## Documentation

- [Behavioral specification](docs/SPEC.md) — implemented v0.6 baseline contract.
- [v0.7 delivery specification](docs/V0.7-DELIVERY-SPEC.md) — implemented
  integrity, authority, and Git-transaction contract with acceptance mapping.
- [Target architecture](docs/ARCHITECTURE.md) — proposed local-first,
  provider-agnostic coordinator, Git transaction, worker trust, and authority
  boundaries.
- [Implementation roadmap](docs/ROADMAP.md) — evidence-gated v0.7-v1.0 outcome
  sequence.
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — ordered work packages,
  data contracts, module impact, migrations, and verification requirements.

The v0.7 slice of the architecture and roadmap is implemented. v0.8-v1.0
capabilities remain planned and are not claims about current behavior.

## Requirements

- Node.js 22+, Git, and pnpm
- PowerShell 7 (`pwsh`) when using a Windows `claudex.ps1` launcher
- authenticated `codex`, native `claude`, and/or configured `claudex` on `PATH`
- a trusted Git checkout; shell checks in a graph execute as local commands

## Install and use

```powershell
pnpm install
pnpm build
npm link
agr install-skills --project C:\path\to\repo
```

`npm link` is the verified Windows development install and does not depend on a
pnpm global-bin directory. For a relocatable local artifact, use `pnpm pack` and
install the resulting `.tgz`; publishing to npm is intentionally not automatic.

Put the graph at `<repo>/.agent-graph/graph.json`, run commands from the repo
root, then:

```powershell
agr doctor
agr plan
agr run --verbose
agr follow
```

`agr run` immediately prints node transitions, provider activity, explicit node
milestones, and a heartbeat (10 seconds by default) to stderr. Agent nodes can
report an operator-safe milestone with `agr progress --phase verify --message
"13 of 14 browser gates passed" --percent 93`; the runtime authenticates the
ephemeral local channel, appends the report to `events.jsonl`, and repeats the
latest milestone in heartbeats. Reports are observability only and never satisfy
acceptance or evidence. `--verbose` includes safe tool names without arguments
and uses a 5-second heartbeat. `--json` keeps stdout machine-readable. Only one live owner
may run a given run ID; `agr cancel` and Ctrl+C terminate active process trees,
persist cancellation, release the lock, and exit with code 130. Cancelled nodes
and external actions left running by a hard interruption are retry-blocked until
their partial effects are inspected. Retrying an uncertain external action
additionally requires a fresh approval receipt and `agr retry <node>
--reconciliation <evidence-file>`.

When the run shell is backgrounded, `agr follow --format human` stays attached
until completion, approval, attention, failure, or cancellation. Parent agents
can resume a machine stream with `agr follow --after <cursor> --format jsonl`,
or poll without treating silence as completion:

```powershell
agr wait --after 42 --timeout-ms 60000 --json
agr inspect --json
agr why --json
```

Every durable safe event carries a monotonic `seq` cursor. Synthetic observer
heartbeats do not advance it.

At a gate, `agr run` exits with code 2. The runtime cannot approve for you:

```powershell
agr approve approve-production deploy:production
agr run
```

To deliberately rerun a node and invalidate all descendants:

```powershell
agr retry implementation
agr run
```

Writing runs execute in `.worktrees/<run-id>` from an exact commit and produce
an immutable `result.json`. To chain work before integration, set
`run.baseCommit` to an explicit prior `resultCommit`. Integration and rollback
are always separate human commands:

```powershell
agr integrate <run-id> --target main --dry-run
agr integrate <run-id> --target main
agr rollback <run-id> --dry-run
agr rollback <run-id>
```

These commands serialize through one repository-wide Git-operation lock,
record an immutable pre-effect intent, and reconcile the expected tree after an
interruption before another mutation is allowed.

Operator and authoring commands:

```powershell
agr init --template codex-claudex
agr runs --json
agr events
agr follow --format jsonl
agr wait --timeout-ms 60000 --json
agr inspect
agr why
agr logs implementation
agr report
agr schema
agr node explain implementation
agr graph --format mermaid
agr completion powershell
agr install-skills --project C:\path\to\repo --dry-run
agr unlock --force # only after verifying a foreign/PID-reused owner is stopped
agr advisor status
agr advisor acknowledge # only after reconciling a recorded advisor blocker
```

An optional `run.advisor` configures a second Codex, Claude, or Claudex model as
a passive read-only reviewer between waves. Notes and concerns are injected as
non-authoritative context for later nodes and stored as separate evidence. A
hard blocker stops before the next wave until `agr advisor acknowledge`; that
command never retries or accepts graph nodes.

Stable exit codes are `0` success, `1` execution failure, `2` human approval
required, `3` invalid input/graph, `4` live-run conflict, `5` operator attention
required, and `130` cancelled.

See [examples/read-only-smoke.graph.json](examples/read-only-smoke.graph.json)
for a safe graph that exercises both native adapters,
[examples/claudex-smoke.graph.json](examples/claudex-smoke.graph.json) for the
proxy-routed launcher, and
[skills/agent-graph-runtime/references/graph-format.md](skills/agent-graph-runtime/references/graph-format.md)
for the complete graph format.

## Runtime contract

- `codex` nodes use `codex exec`, JSON schema output, and Codex sandboxing.
- `claude` nodes use native `claude -p`, JSON schema output, and bounded tools.
- `claudex` nodes use the same print-mode protocol through the PATH-resolved
  Claudex launcher. They retain distinct evidence and never fall back to native
  Claude or Codex. Implementation nodes use Claude's `auto` safety mode, an
  AGR PreToolUse guard that confines direct paths (with read-only access to
  installed skill references) and permits Bash only for standalone `agr
  progress`, plus pre-authorized skills and a small low-side-effect Playwright
  MCP set. Direct `browser_navigate` is localhost-only, uploads stay inside the
  repository, and host-code execution is unavailable. Interactive browser tools
  remain subject to Claude `auto`; because clicks and history can change origin,
  this is not an OS-level browser-network sandbox. Direct
  `Workflow`, `Task`, and `Agent` tools remain denied; review nodes load no user/project/local settings, use an empty
  strict MCP configuration, and expose only `Read`, `Glob`, `Grep`, and `Skill`.
  Hidden Workflow/subagent orchestration is contractually forbidden because a
  graph node must finish its own work before returning a handoff.
- review nodes are read-only; implementation direct file tools are repository-
  scoped. Model-controlled Bash is fail-closed except for `agr progress`;
  deterministic commands belong in graph checks or a trusted approved
  `external_action`. Agent
  timeouts terminate the complete spawned process tree through Windows tree
  termination or a dedicated POSIX process group before an attempt ends. An
  unconfirmed tree kill retains raw output and cannot retry automatically;
  `agr retry` explicitly clears that terminal block after operator cleanup.
- check timeouts and cancellation use the same process-tree policy. An
  unconfirmed cleanup is persisted as terminal evidence and blocks retry.
- local stale locks recover automatically through a serialized recovery guard.
  Foreign-host or PID-reused locks fail closed and require deliberate
  `agr unlock --force` only after the operator confirms the recorded owner is
  stopped. An abandoned
  partial lock or unreadable recovery guard also requires this explicit forced
  recovery; live recovery owners remain protected.
- configured checks run outside the model and gate acceptance.
- state is atomically persisted under `.agent-graph/runs/<run-id>/`; raw CLI
  output, prompts, evidence, events, and the final report remain auditable.
  `CURRENT.json` selects one hash-verified immutable state/event generation;
  root `state.json` and `events.jsonl` are compatibility projections, not
  authority.
- changed graph content cannot resume under an existing `run.id`.
- ownership compares content-aware dirty snapshots around every wave, so a
  second write to an already-dirty unowned path is still an escape.
- `partial` or `blocked` agent handoffs stop as `needs_attention` with exit 5;
  they never consume another attempt until the operator inspects evidence and
  explicitly runs `agr retry`.
- attempts and evidence are append-only across manual retry generations. Every
  evidence document is bound to a unique attempt ID, producer, hash, and size.
- external actions are off by default and require graph opt-in, an exact
  single-use receipt bound to repository and evidence state, and durable receipt
  consumption before dispatch. An uncertain effect cannot retry without
  reconciliation evidence and a new receipt.

Claudex owns its proxy, authentication, top-level model routing, effort,
compaction, and context-window settings. A graph using
`executor: "claudex"` therefore cannot set `model`.
Claudex nodes can declare `requiredModelUsage` to require observed model,
provider, and context-window metadata before acceptance. The field is rejected
on `verify` and `human_gate` nodes because they do not dispatch an agent adapter.

## Security and limitations

Review graph files before running them: `checks` are trusted shell commands.
The runtime never bypasses CLI permissions, auto-approves a gate, reverts an
ownership violation, deploys, pushes, or sends messages unless an explicitly
authorized external-action node defines that operation.

Nodes in one run share that run's isolated checkout. Their ownership patterns
must be disjoint, and wave changes plus handoff claims are checked. Because Git
cannot attribute a same-worktree path to one concurrent process, use
`maxConcurrency: 1` when strict per-process attribution matters. Per-node
worktrees, a hosted UI, distributed workers, and automatic task invention remain
outside this version.

## Development

```powershell
pnpm test
pnpm pack --dry-run
```

The behavioral contracts and acceptance mappings are in
[docs/SPEC.md](docs/SPEC.md) and
[docs/V0.7-DELIVERY-SPEC.md](docs/V0.7-DELIVERY-SPEC.md).
