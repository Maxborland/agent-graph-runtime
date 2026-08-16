# Agent Graph Runtime — behavioral specification

## Goal

Provide a local, resumable graph runtime that executes repository work through
the installed Codex CLI, native Claude Code CLI, or proxy-routed Claudex launcher, while keeping dependencies,
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
- No modification of the user-owned Claudex launcher, proxy configuration,
  model routing, effort, authentication, or context-window settings.
- No write-capable plugin, MCP, shell, or editor access from a review node.
- No automatic merge of node worktrees into a dirty checkout. Optional isolated
  execution remains a later contract because safe merge, conflict, untracked-file,
  and user-change preservation semantics require a separate design.
- No automatic npm publication or mutation of the user's shell profile.

## Public interfaces

- `agr validate [graph]`: validate graph structure, dependencies, cycles, and
  concurrent ownership conflicts.
- `agr run [graph] [--verbose]`: create or resume a run and execute ready nodes until the
  graph completes, fails without retry capacity, or reaches a human gate.
- `agr progress --phase PHASE --message MESSAGE [--percent N]`: report one
  non-authoritative milestone from an active agent node through its ephemeral
  local channel.
- `agr follow [graph] [--after N] [--format human|jsonl]`: replay durable
  events after a cursor and remain attached until the run reaches a terminal or
  operator-decision state.
- `agr wait [graph] [--after N] [--timeout-ms N]`: return a bounded event batch,
  current cursor, and run status; a quiet timeout is data rather than completion.
- `agr inspect [graph]`: summarize active attempts, elapsed and silent time,
  latest milestones, and attention state without mutating the run.
- `agr why [graph]`: explain the current stop or continuation condition with
  retry safety, affected paths, and the next operator action.
- `agr status [graph]`: render current run and node states without mutation.
- `agr approve <node> <target> [graph]`: record explicit approval for one human
  gate and its exact target, then allow a later `run` to continue.
- `agr install-skills [--project DIR | --user]`: install the bundled open-agent
  skill for Codex and Claude Code discovery locations.
- `agr doctor [graph]`: inspect the local toolchain, selected executors, graph,
  repository, and run readiness without authenticated or billable provider calls.
- `agr init [graph] [--template NAME]`: create a non-destructive starter graph;
  existing files are never overwritten without an explicit future contract.
- `agr plan [graph]`: render execution waves, ownership, checks, gates, external
  actions, and required model evidence without starting an executor.
- `agr runs [graph]`, `agr events [graph]`, `agr logs [node] [graph]`, and
  `agr report [graph]`: inspect persisted runs and evidence without mutation.
- `agr cancel [graph]`: request cooperative cancellation of the active run.
- `agr unlock [graph] --force`: explicitly recover a foreign-host or PID-reused
  lock only after the operator verifies that its recorded owner is stopped.
- `agr advisor status [graph]` and `agr advisor acknowledge [graph]`: inspect an
  optional passive advisor or explicitly clear only its reconciled blocker.
- `agr schema`, `agr node explain <node> [graph]`, `agr graph [graph]
  --format mermaid`, and `agr completion <shell>`: graph authoring and shell UX.

The graph file is JSON. Runtime state is stored under
`.agent-graph/runs/<run-id>/` as an append-only `events.jsonl`, an atomically
rewritten `state.json`, executor outputs, prompts, and evidence.

## Acceptance criteria

### Live node progress extension

Goal: make a long `agr run` understandable while it is running by exposing an
explicit, safe milestone channel from the active graph node to the operator.

Non-goals: progress cannot send commands into an agent, mutate graph state,
approve, retry, cancel, satisfy evidence, or authorize nested agents. Provider
prompts, reasoning, tool arguments, command text, and raw output remain private.

- **AC27 Node progress channel:** An active agent node receives an ephemeral,
  token-authenticated local IPC endpoint and instructions for
  `agr progress --phase PHASE --message MESSAGE [--percent N]`. Valid reports
  are bounded, single-line, rate-limited, emitted live, and appended as
  `node_progress` events. The latest report for every active node appears in
  later heartbeats. Invalid, spoofed, or unavailable reports never alter node
  state or acceptance.
- **AC28 Verbose activity:** `agr run --verbose` emits safe provider tool names
  and more frequent heartbeats without exposing tool arguments, model text,
  prompts, reasoning, commands, or raw output. Normal and JSON modes retain
  their existing output contracts.

Edge cases: `agr progress` outside an active node returns a stable invalid-input
error; percentage is 0–100; phase and message are length-bounded; multiline and
control characters are rejected; a closed channel fails boundedly; progress
rendering, persistence, or reporter failure cannot fail the executor.

Traceable test plan:

- AC27 → CLI reporter rejects a missing channel and delivers one authenticated
  report; runner integration persists the report and includes it in a heartbeat.
- AC28 → adapter contract exposes safe tool names only in verbose mode; CLI
  subprocess output remains live and `--json` stdout remains one JSON value.

### Observable supervisor and advisor extension

Goal: let a human or parent agent attach to a running graph, resume observation
without duplicate events, understand why it stopped, and optionally receive
passive independent advice between execution waves.

Non-goals: this extension does not add a daemon, hidden subagents, arbitrary
prompt injection into an active one-shot executor, automatic approval/retry, or
cross-worktree merge automation. Advisor output is untrusted model advice and
never substitutes for ownership, checks, evidence, or human authority.

- **AC29 Ordered durable events:** Persisted safe run events have a monotonically
  increasing `seq` cursor. Existing pre-cursor event logs remain readable by
  assigning line-order cursors in memory. Lifecycle transitions, safe provider
  activity, node milestones, advisor observations, and terminal outcomes are
  durable; raw model text, tool arguments, commands, prompts, and reasoning are
  excluded. A state snapshot remains the recovery source; the event stream is
  the observation and audit source.
- **AC30 Follow:** `agr follow [graph] [--after N] [--format human|jsonl]
  [--interval-ms N]` emits durable events after the cursor, waits while the run
  is active, emits bounded synthetic heartbeat observations when no durable
  event arrives, and exits only when the run is terminal or needs operator
  action. JSONL emits one valid object per line and can resume without replaying
  events at or before `N`.
- **AC31 Wait:** `agr wait [graph] [--after N] [--timeout-ms N] [--json]`
  waits for a new durable event or a status that no longer runs, then returns a
  bounded batch containing `status`, `terminal`, `timedOut`, `cursor`, events,
  and active-node summaries. Reaching the observation timeout is a successful
  read, not an execution failure, so an agent can poll safely.
- **AC32 Inspect and why:** `agr inspect [graph]` returns a compact current view
  with active nodes, latest milestones, elapsed/silent durations, blocker
  metadata, and cursor. `agr why [graph]` returns structured issue codes,
  retry-safety, affected nodes/paths when known, and exact non-destructive next
  actions derived from runtime state/evidence rather than free-form handoff
  claims. Both commands are read-only and support `--json`.
- **AC33 Passive advisor role:** A run may declare one optional advisor with an
  explicit Codex, Claude, or Claudex executor and optional model/instructions.
  After each completed wave and before another wave starts, AGR dispatches one
  synthetic read-only review attempt over the objective, graph/state summary,
  safe events, and current repository. `complete`, `partial`, and `blocked`
  advisor handoffs map to `note`, `concern`, and `blocker`. Each attempt has
  separate raw output, usage, and evidence. The latest note/concern is injected
  as clearly non-authoritative context into later node prompts.
- **AC34 Advisor safety and recovery:** Advisor configuration is visible in
  validation/plan/doctor and never grants ownership. Ordinary advisor failure
  emits `advisor_failed` and execution continues. An advisor write outside
  `.agent-graph/**`, an unconfirmed advisor process-tree termination, or an
  advisor `blocker` when `stopOnBlocker` is not false stops before the next wave
  as `needs_attention`. `agr advisor acknowledge [graph]` is the only operation
  that clears that run-level blocker; it does not retry, accept, or mutate a
  graph node. Advisor failures never consume node attempts.
- **AC35 Agent monitoring contract:** Bundled Codex/Claude skills instruct a
  parent agent that launched AGR in the background to use `agr follow` or a
  bounded `agr wait` loop and never declare completion while status is
  `running`. A terminal, approval, or attention state is still reported to the
  user instead of being automatically acted upon.

Edge cases: `after` is a non-negative integer; follow/wait tolerate an event
line appended between state and event reads; malformed historical lines produce
an actionable artifact error instead of being silently skipped; synthetic
heartbeats never advance the durable cursor; advisor summaries and instructions
are length-bounded in live output; advisor absence adds no executor calls.

Traceable test plan:

- AC29 → store and CLI tests prove cursor monotonicity, legacy normalization,
  durable activity/terminal events, and safe payload boundaries.
- AC30 → subprocess tests prove follow resume, JSONL validity, heartbeat, and
  terminal exit behavior.
- AC31 → CLI tests prove event wake-up, timeout-as-data, bounded batches, and
  a terminal snapshot.
- AC32 → fixture tests cover running, failed ownership, attention, approval,
  completed, and missing-run diagnostics.
- AC33 → runner tests prove one read-only advisor attempt per wave, evidence,
  severity mapping, later-prompt injection, and no call when unconfigured.
- AC34 → runner/CLI tests prove ordinary advisor failure continues, blocker
  stops before the next wave, acknowledgement resumes without retrying accepted
  nodes, and advisor ownership escape fails closed.
- AC35 → packaged-skill tests assert the background monitoring loop and its
  terminal/attention stop conditions.

### Architecture deepening extension

Goal: concentrate the runtime's lifecycle, observation, advisor, and explicit
operator-mutation rules behind deep Modules while preserving every v0.6 CLI,
graph, state, event, evidence, recovery, and safety contract.

Non-goals: no command or JSON-format redesign; no new executor, daemon,
database, worktree isolation, automatic retry/approval, or state migration; do
not split the already-deep `GraphRunner` merely by file size.

Assumption: these are internal Interface changes. Existing CLI commands and
persisted v0.1-v0.6 artifacts remain the user-visible Interface and source of
compatibility truth.

- **AC36 Deep lifecycle Module:** One lifecycle Module owns state-transition
  invariants for readiness, wave/node progress, acceptance/failure, terminal
  decisions, recovery, approval, retry invalidation, cancellation, and advisor
  attention. Runner, store recovery, advisor, and operator mutations do not
  encode competing transition rules. Invalid transitions fail before state is
  persisted; accepted nodes and interrupted external actions retain their
  existing recovery behavior.
- **AC37 Deep observation Module:** One observation Module owns ordered event
  parsing, legacy cursor normalization, coherent state/event snapshots, bounded
  cursor reads, wait timing, active-node derivation, inspection, and stop
  explanation. `follow`, `wait`, `inspect`, `why`, and advisor context consume
  that Module; human and JSON rendering remain thin callers. Malformed logs and
  missing runs retain their stable CLI errors.
- **AC38 Deep advisor Module:** One advisor Module owns passive-wave dispatch,
  safe prompt context, adapter selection, ownership inspection, severity and
  failure classification, evidence, stored observation, status, and domain
  acknowledgement. `GraphRunner` invokes one advisor operation between waves;
  ordinary failure continues, safety uncertainty blocks, and no graph-node
  attempt is consumed.
- **AC39 Deep operator-control Module:** One operator-control Module owns the
  mutation protocol for approve, retry, and advisor acknowledgement: validation,
  exclusive run lock, lifecycle transition, event persistence, and lock release.
  CLI parsing/rendering contains no duplicate domain validation. Concurrent or
  invalid mutations fail without partial state changes or stateless run
  directories.

Failure behavior and edge cases: a lifecycle transition and its domain events
are persisted in a deterministic order; an event-read race cannot regress a
cursor; observation timeout remains successful data; advisor raw failures stay
in evidence rather than the safe event stream; operator-control always releases
its lock; graph-hash mismatch still prevents every mutation.

Traceable test plan:

- AC36 → lifecycle Interface tests cover approval, descendant retry,
  attention/terminal decisions, cancellation, and interrupted external-action
  recovery; existing runner/store/CLI suites prove compatibility.
- AC37 → observation Interface tests cover legacy and current event logs,
  coherent cursor snapshots, timeout/event wake-up, active milestones, and
  structured stop reasons; existing follow/wait/inspect/why tests remain green.
- AC38 → advisor Interface tests cover note injection, blocker, ordinary
  failure, write escape, evidence, status, and acknowledgement; runner tests
  prove one invocation per completed wave.
- AC39 → operator-control Interface tests cover approve/retry/acknowledge,
  invalid input, mutation contention, graph mismatch, and lock release; CLI
  tests prove unchanged output and exit behavior.

### Review remediation extension

Goal: close the six independently verified lifecycle, Claudex authorization,
advisor evidence, event-log, and packaged-skill defects without weakening the
v0.6 evidence or explicit-operator contracts.

Non-goals: no automatic rollback of repository changes; no general-purpose
shell parser; no new daemon, network sandbox, or event/state migration; no
automatic retry after an uncertain effect.

Assumptions: graph checks and `executor: "shell"` are trusted configuration
owned by the graph author. Model-controlled Claudex Bash is not a trustworthy
authorization or process-isolation boundary, so it is limited to the exact
authenticated `agr progress` reporter command.

- **AC40 Post-execution cancellation:** Cancellation observed after executors
  finish but before ownership inspection completes finalizes every completed
  outcome as interrupted and retry-blocked. Ownership inspection aborts are not
  reclassified as retryable ownership failures, and a later plain `agr run`
  cannot repeat the effect without explicit `agr retry`.
- **AC41 Claudex nested-executor isolation:** A Claudex implementation node may
  use Bash only for a standalone bounded `agr progress` command. Every other
  Bash command is denied before execution, including computed, encoded, or
  indirect Codex, Claude, Claudex, and AGR launches. Repository file tools and
  the bounded Playwright tool set remain available.
- **AC42 Claudex external-action isolation:** The same fail-closed Bash boundary
  denies model-controlled push, publish, deploy, HTTP mutation, and arbitrary
  shell commands in ordinary Claudex nodes. External actions use an explicitly
  approved graph node and trusted graph-owned execution rather than an ordinary
  model-controlled Bash call.
- **AC43 Durable advisor invocation identity:** Every advisor invocation reserves
  a persisted monotonically increasing sequence before dispatch. Prompt, raw
  output, evidence, observation, and event identities use that sequence, so
  resume after a gate, blocker, failure, or crash never overwrites earlier
  advisor artifacts.
- **AC44 Semantic event-log validation:** Event history accepts either a wholly
  legacy log without cursors or current events with positive strictly increasing
  integer cursors. Every record must be an object with a valid timestamp and
  known event type; optional fields retain their declared types. Mixed,
  duplicate, decreasing, or malformed records fail with `EVENT_LOG_INVALID`
  and an actionable line number.
- **AC45 Bounded bundled skill:** The packaged `SKILL.md` remains below 100
  physical lines, including frontmatter and blank lines. Detailed operational
  guidance lives in its reference file, and packaging tests enforce the limit.

Failure behavior and edge cases: cancellation wins over an ownership error when
the signal is aborted; a Bash denial never falls through to Claude `auto`;
advisor sequence reservation survives an adapter failure; legacy event cursors
are assigned only when no record declares `seq`; an empty event file remains
valid.

Traceable test plan:

- AC40 → runner regression aborts during post-executor ownership inspection,
  asserts `cancelled` plus `retryBlocked`, and proves a plain resume makes no
  second adapter call.
- AC41 → guard tests reject character-code, base64, variable, and indirect
  nested-executor commands while retaining standalone `agr progress`.
- AC42 → guard tests reject push, publish, deploy, HTTP mutation, and ordinary
  local shell commands; adapter tests prove the hook remains installed.
- AC43 → advisor/runner integration crosses a human gate and proves two unique
  advisor identities, prompts, outputs, evidence files, and stable historical
  event references.
- AC44 → observation tests reject primitive, missing-field, invalid-type,
  mixed-cursor, duplicate, and decreasing histories while preserving valid
  current and wholly legacy logs.
- AC45 → installer/package test counts physical `SKILL.md` lines and requires
  fewer than 100.

- **AC1 Graph validity:** Duplicate node IDs, missing dependencies, cycles,
  invalid executors/types, and ownership conflicts among nodes that could be
  ready together are rejected before any executor starts.
- **AC2 Readiness:** A node starts only after all dependencies are accepted.
  Ready nodes with non-overlapping ownership may run concurrently up to the
  configured limit.
- **AC3 Real adapters:** Agent nodes invoke `codex exec`, native `claude -p`, or
  the installed `claudex` launcher in the graph repository. All receive a
  structured-output schema and least-privilege mode: implementation is
  workspace-scoped; review is read-only. `claude` and `claudex` remain distinct
  executor identities with separate evidence artifacts and failure messages.
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
  state from disk. Ordinary nodes left `running` become `ready` with an
  interrupted attempt event; an `external_action` left running becomes failed
  and retry-blocked until explicit reconciliation. Already accepted nodes are
  not repeated.
- **AC8 Retry and invalidation:** A failed agent node retries only up to
  `maxAttempts`. Re-executing a previously accepted node invalidates every
  downstream acceptance and its evidence. A process-tree termination failure
  blocks automatic retry, but an explicit `agr retry` clears that terminal flag
  after the operator has handled any surviving process.
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
- **AC13 Claudex launcher authority:** On Windows, a PATH-resolved `claudex.ps1`
  is invoked explicitly through non-interactive PowerShell 7 so JSON arguments
  survive the launcher-to-native-CLI boundary. Graph nodes cannot
  override its model because the launcher owns Sol/Luna routing, effort, proxy
  authentication, compaction, and the 262144-token context contract.
- **AC14 Claudex extension discovery:** The runtime does not replace Claudex's
  default direct tool set for implementation nodes, but explicitly denies
  `Workflow`, `Task`, and `Agent`, uses Claude's `auto` safety mode, and installs
  an AGR PreToolUse guard that rejects direct paths outside `repositoryRoot`
  except read-only installed skill references. Bash is available only for one
  standalone bounded `agr progress` command; every other shell command is
  rejected before Claude `auto`. Only skills and a small low-side-effect
  Playwright MCP set are pre-authorized: direct `browser_navigate` is
  localhost-only, uploads stay under `repositoryRoot`, and host-code execution
  is unavailable. Interactive browser tools remain subject to Claude `auto`;
  clicks and history are trusted actions rather than an OS-level network sandbox.
  Review nodes expose only `Read`,
  `Glob`, `Grep`, and `Skill` and explicitly deny Workflow, shell, and editor
  tools. User, project, and local settings sources and MCP configurations are
  disabled for the review process so hooks and plugin/MCP tools cannot act
  around that boundary. Repository ownership verification remains a second
  line of defense, not the read-only boundary.
  Model-controlled implementation Bash is not trusted execution. Deterministic
  commands run as graph-authored checks; external effects require an approved
  `external_action` and trusted graph-owned execution.
- **AC15 Executor deadline:** When an agent timeout expires, the runtime
  terminates the complete spawned process tree before completing the attempt.
  Windows uses recursive tree termination for the `pwsh.exe` to `claude.exe`
  launcher chain; POSIX launches the adapter in its own process group, signals
  the group, and escalates when needed. If tree termination cannot be confirmed,
  the runtime also terminates or detaches its tree-kill helper, records the root
  PID, detaches inherited streams, preserves output captured so far, and becomes
  terminal within a bounded interval so neither the helper nor an automatic retry
  can overlap a possible survivor. Cleanup of temporary process input can never
  preempt tracking of an already spawned executor or mask a terminal outcome.
- **AC16 Required model usage:** A Claudex node may declare
  `requiredModelUsage` entries containing a model identity, provider, and
  context window. The adapter retains Claudex's structured `modelUsage`, the
  runner persists it as evidence, and the attempt fails when an entry is
  missing or its provider or context window differs. The field is valid only on
  node types that dispatch an agent adapter and evaluate its outcome; `verify`
  and `human_gate` nodes reject it during graph validation.
- **AC17 Live run observability:** `agr run` emits an immediate run-start line,
  node/wave transitions, and a heartbeat containing active node IDs and elapsed
  time at least every 15 seconds while work is active. Progress never includes
  prompts, secrets, raw model output, or chain-of-thought. Machine-readable mode
  keeps stdout valid JSON and sends optional progress to stderr.
- **AC18 Single-owner lifecycle:** Only one live `agr run` may own a run ID in a
  repository. A lock records PID, host, and start time; live conflicts fail with
  an actionable error, while local stale recovery is serialized and foreign
  locks require explicit operator recovery. An abandoned partial lock is never
  deleted by a contender and requires `unlock --force`; recovery guards carry
  owner identity so stale local guards recover safely while live owners remain
  protected. Ctrl+C and
  `agr cancel` cooperatively terminate active executor process trees, persist an
  interruption/cancellation event, retry-block interrupted nodes until explicit
  reconciliation, release the lock, and return a stable code.
- **AC19 Portable graph resolution:** A graph supplied by path resolves its
  relative `run.repository` from the graph file's directory, not the caller's
  current working directory. For backward compatibility, the conventional
  `.agent-graph/graph.json` plus `repository: "."` aliases its repository root.
- **AC20 Automation contract:** Every read-oriented command supports `--json`.
  JSON stdout is a single documented object; human diagnostics use stderr.
  Stable exit codes distinguish success (0), execution failure (1), approval
  required (2), invalid input/graph (3), live-run conflict (4), operator
  attention required (5), and interruption (130). Unknown options and commands
  show a concise next action.
- **AC21 Operator commands:** `doctor` is side-effect free and verifies only
  local availability/version/path; `plan` shows real concurrency waves rather
  than a misleading linear order; `status --watch` refreshes until terminal;
  logs/events/report/runs expose existing artifacts with clear missing-run
  guidance; cancel never approves or retries work.
- **AC22 Graph authoring:** `init` refuses overwrite, produces a valid starter
  graph, and supports safe built-in templates. `schema` emits the graph JSON
  schema. Node explanation and Mermaid output are deterministic and execute no
  graph nodes. Shell completion is generated for PowerShell, bash, and zsh.
- **AC23 Installation UX:** `install-skills --dry-run` performs no writes and
  reports both destinations. A real install reports `installed`, `updated`, or
  `unchanged` using content hashes. The locally packed npm artifact exposes the
  same CLI without requiring pnpm's global-bin configuration.
- **AC24 Semantic attention:** An agent handoff with status `partial` or
  `blocked` is evidence, not a transient executor failure. The node becomes
  retry-blocked, the run stops as `needs_attention`, and the CLI exits 5 without
  starting another attempt. Still-running siblings in the same concurrent wave
  are cooperatively cancelled and retry-blocked for reconciliation; siblings
  that already finished before attention was observable retain their evidence.
  A sibling that reports success only after attention was observed is rejected
  and retry-blocked even if its executor swallowed cancellation.
  Other retry-blocked failures use the same operator state. `agr retry` is the
  only operation that clears this block.
- **AC25 Safe provider activity:** Native adapters stream bounded activity
  summaries while running. Human mode prints provider/event categories without
  prompt text, reasoning, commands, tool arguments, or raw output; JSON stdout
  remains a single machine-readable result.
- **AC26 Graph-owned orchestration:** A graph node is the unit of execution and
  acceptance. A node must not launch a hidden Workflow/subagent and return while
  that work is pending. Model-specific or independently accepted work is
  represented as an explicit graph node; runs use a dedicated checkout with no
  unrelated writer.

## Failure behavior and edge cases

- Executor binary missing: fail the node with an actionable error; do not try a
  different provider.
- Claudex launcher missing or proxy authentication invalid: fail only the
  Claudex node; never fall back to native Claude or Codex.
- Invalid or truncated JSON output: fail the attempt and retain raw output.
- Check timeout: terminate the child process, mark the check failed, retain
  bounded stdout/stderr.
- Agent timeout: terminate the spawned process and all descendants before the
  attempt resolves; failure to terminate the tree is reported as an executor
  failure, raw process output is retained, and no automatic retry overlaps the
  survivor. A process that handles the termination signal and exits with code
  zero after the deadline still fails as timed out.
- Dirty repository at start: allowed, but its baseline changed-file set is
  recorded. Per-wave content-aware snapshots preserve those paths while still
  detecting a second write, deletion, staging change, or overwrite during a node.
- Concurrent nodes: ownership is reserved before spawn. A conservative overlap
  check may serialize safe work, but must not run ambiguous ownership in parallel.
- Same-checkout concurrency cannot prove which process authored a path that was
  reserved to another node in the same wave. Use `maxConcurrency: 1` for strict
  per-process attribution; isolated worktree merge automation is a v1 non-goal.
- Secret values: environment is inherited by the native CLIs; the runtime does
  not serialize environment variables or prompt contents into the final report.
- Review nodes: must declare no writable ownership and use read-only tools.
- Claudex model-usage requirements are evaluated only from top-level launcher
  metadata, never from handoff text or agent claims.
- Progress rendering failure cannot fail or alter a run; missing historical
  artifacts produce actionable CLI errors rather than raw filesystem messages.
- A cancellation request left by a dead run is consumed only by the matching
  run ID and cannot cancel a future run after terminal cleanup.
- A check whose process tree cannot be confirmed terminated records that
  uncertainty and is retry-blocked rather than presenting ordinary timeout or
  cancellation success.
- A semantic `partial`/`blocked` handoff never consumes another attempt
  automatically. The report and CLI identify the exact node and preserve its
  evidence for operator reconciliation.
- Provider activity is derived only from event envelope metadata. Untrusted
  model text and tool payloads are retained in raw artifacts but never copied to
  the live progress channel.

## Assumptions

- Node.js 22+ and Git are installed.
- PowerShell 7 (`pwsh`) is installed when a Windows `.ps1` Claudex launcher is used.
- Codex/Claude authentication is already configured by the user.
- Claudex, when selected, is already configured by the user and available on
  PATH. The runtime forwards supported Claude Code print-mode arguments but
  does not own or rewrite launcher-scoped model/environment settings.
- The repository is trusted and each run uses a dedicated checkout when the
  surrounding product requires isolation.
- Shell checks are authored by the graph owner and therefore are trusted local
  configuration; graph files from untrusted repositories must be reviewed first.

## Traceable test plan

- AC1 → `validate rejects malformed and cyclic graphs`; `validate rejects
  overlapping parallel ownership`.
- AC2 → `scheduler only returns dependency-ready non-overlapping nodes`.
- AC3/AC4 → adapter contract tests using fake `codex`, `claude`, and `claudex`
  executables; optional installed-CLI smoke with read-only fixture.
- AC5 → `node fails when new Git paths escape ownership`.
- AC6 → `checks gate acceptance and persist bounded evidence`.
- AC7 → `interrupted run resumes without repeating accepted nodes`.
- AC8 → `retry stops at maxAttempts`; `rerun invalidates descendants`; explicit
  retry clears a persisted `retryBlocked` terminal flag.
- AC9 → `human gate stops run until exact approval`; `external action remains
  disabled without opt-in`.
- AC10 → `CodeGraph unavailable returns labeled fallback`.
- AC11 → skill validation and project/user installer tests.
- AC12 → CLI integration fixture covering complete, failed, and awaiting states.
- AC13 → graph validation rejects `model` on Claudex nodes; Windows command
  resolution wraps `.ps1` through non-interactive PowerShell; real read-only
  Claudex smoke preserves launcher-owned routing.
- AC14 → adapter argv test proves Claudex receives no restrictive `--tools`
  override for implementation work but denies nested agent tools; review argv is
  allowlisted to read and skill tools, denies Workflow/shell/editor tools, and
  disables settings/MCP sources; a live probe proves writes and hidden
  orchestration are unavailable.
- AC15 → Windows integration test starts a native child through a PowerShell
  launcher, times out the adapter, and proves both wrapper and descendant exit
  before the rejection returns; POSIX integration proves a process-group
  descendant exits; a failed tree-kill fixture with a surviving inherited-stdio
  descendant proves the attempt still finalizes and retains raw output; a hung
  tree-kill helper fixture proves the complete runtime process exits boundedly.
- AC16 → adapter contract retains model usage; runner tests reject missing or
  mismatched required usage and persist matching usage; graph validation rejects
  usage requirements on non-dispatched node types; the Claudex smoke graph
  requires first-party Sol and Luna with a 262144-token context window.
- AC17 → CLI subprocess test observes immediate progress and a heartbeat while a
  slow fake node runs; JSON mode remains parseable and excludes prompt text.
- AC18 → two CLI subprocesses cannot run the same run ID concurrently; stale
  lock recovery, Ctrl+C/cancel process-tree termination, event persistence, and
  lock cleanup have regression coverage.
- AC19 → CLI test invokes a graph from a different cwd and proves repository
  resolution is relative to the graph file.
- AC20 → table-driven CLI tests cover JSON output, unknown flags, and exit codes
  0/1/2/3/4/130.
- AC21 → public-command integration tests cover doctor, plan waves, watch status,
  artifact inspection, run listing, and cooperative cancel.
- AC22 → init overwrite refusal plus validate, schema parse, node explanation,
  Mermaid graph, and completion snapshot tests.
- AC23 → installer tests prove dry-run writes nothing, repeat installation is
  unchanged, changed content updates, and `pnpm pack --dry-run` exposes the CLI.
- AC24 → runner test proves a `partial`/`blocked` handoff with attempts remaining
  stops after one call as `needs_attention`; CLI integration proves exit 5;
  explicit retry clears the block and allows a later complete handoff.
- AC25 → adapter tests feed Codex and Claude stream events containing sensitive
  payloads and assert that live activity exposes only safe event categories;
  CLI progress remains on stderr in JSON mode.
- AC26 → adapter argv prevents Workflow, the runtime prompt makes the node
  boundary explicit, and the KISS-PM consumer graph uses direct executor nodes
  in a dedicated checkout without concurrent writers.
