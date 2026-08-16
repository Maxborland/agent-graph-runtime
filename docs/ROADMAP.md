# Agent Graph Runtime — implementation roadmap

Status: proposed. This roadmap sequences target capabilities behind evidence
gates. Version labels express dependency order, not delivery dates.

## Roadmap rules

- Current behavior remains defined by [`SPEC.md`](SPEC.md).
- Target boundaries and invariants are defined by
  [`ARCHITECTURE.md`](ARCHITECTURE.md).
- A capability is not complete because its schema, mock, or UI exists. It must
  pass its real runtime acceptance gate.
- A later phase cannot weaken an invariant accepted in an earlier phase.
- Every persistence change includes upgrade fixtures and crash recovery tests.
- Every authority change includes a negative authorization test.
- Every distributed behavior includes duplicate, late, interrupted, and
  network-partition cases.

## v0.7 — Integrity and Git transactions

### Outcome

A local writing run has append-only history, cannot duplicate an uncertain
external effect, executes in an isolated Git transaction, and can be integrated
or reverted explicitly without touching unrelated user work.

### Deliverables

#### Versioned persistence

- Add schema versions to run state, events, evidence, and reports.
- Add state revision and last-applied event sequence.
- Treat missing versions as the documented v1 legacy format.
- Validate persisted artifacts before any mutation.
- Migrate legacy event cursors atomically without creating mixed logs.
- Add fault injection around evidence write, event append, state snapshot,
  checkpoint commit, and lock release.

#### Append-only attempt ledger

- Introduce globally unique attempt IDs and monotonic per-node ordinals.
- Separate manual invalidation generation from attempt ordinal.
- Preserve all prior evidence references and physical artifacts.
- Mark prior accepted descendants as superseded rather than deleting history.
- Update logs, report, inspect, retry, and why output to distinguish current
  from historical attempts.

#### External-action safety

- Force manual retry policy for every `external_action`.
- Convert any non-success, timeout, interruption, or unknown completion into
  `needs_attention` with `retryBlocked`.
- Add reconciliation evidence before explicit retry.
- Add optional provider idempotency keys without treating them as proof of no
  partial effect.

#### Approval receipts and run mandates

- Bind approvals to target, action parameters, plan revision, repository
  fingerprint, dependency evidence digest, expiry, and single-use state.
- Add a bounded human-issued run mandate.
- Implement a deterministic local policy decision record.
- Retain explicit human gates for actions outside the mandate.

#### Run Git transaction

- Record exact repository identity and base commit.
- Create isolated run worktrees and branches for writing runs.
- Create accepted wave checkpoint commits with evidence metadata.
- Produce an immutable `RunResult` on completion.
- Add dry-run previews for `agr integrate` and `agr rollback`.
- Integrate explicitly; rollback through revert commits.

### Acceptance gate

- Three retries preserve three independently hashable evidence generations.
- A failed external action executes once across repeated `agr run` calls.
- Repository or evidence drift invalidates an existing approval.
- A dirty user checkout remains byte-for-byte unchanged during a writing run.
- A chained writing run starts only from an explicit committed `RunResult`, not
  from mutable state left in another run worktree.
- A completed run integrates from a clean checkout and reverts through a new
  commit.
- Process termination at every persistence seam either recovers coherently or
  fails closed with an actionable diagnosis.
- Legacy v0.1-v0.6 fixtures remain inspectable and migrate deterministically.

## v0.8 — Governed adaptive local graph

### Outcome

The local coordinator can accept evidence-backed graph expansion proposals
without allowing an agent to mutate an executing plan or exceed human-defined
authority and resource budgets.

### Deliverables

#### Immutable plan revisions

- Add `PlanRevision` and `GraphPatch` domain types.
- Freeze one plan revision for each active wave.
- Validate graph patches for cycles, ownership, resources, executor capability,
  budgets, and authority.
- Record proposal provenance and rejection evidence.
- Invalidate affected descendants when an accepted output or plan dependency
  changes.

#### Typed artifacts and dependency lineage

- Add `produces` and `consumes` artifact contracts.
- Store artifact hashes, producer attempt, plan revision, content type, and
  local path.
- Prevent a descendant from starting against mutated accepted inputs.
- Preserve full artifacts while presenting bounded model/operator views.

#### Resource and budget scheduling

- Add named shared/exclusive resource leases.
- Enforce node count, expansion depth, wall time, provider concurrency, and
  optional cost budgets.
- Keep write-capable nodes serialized until node-level worktree isolation is
  accepted.
- Add risk-aware `agr plan` and `agr validate` diagnostics.

#### Local control UI

- Add a loopback-only read model and event stream.
- Render runs, revisions, attempts, evidence, checkpoints, mandates, resources,
  and stop reasons.
- Send mutations through existing application services, never through direct
  state editing.
- Provide integrate, rollback, retry, and approval previews before commands.
- Protect loopback sessions with unguessable capabilities, strict Host and
  Origin checks, CSRF defenses, restrictive CORS, and equivalent WebSocket
  validation; LAN mode adds authenticated enrollment and protected transport.

### Acceptance gate

- An agent proposal cannot modify the active wave.
- Invalid, over-budget, cyclic, conflicting, or unauthorized graph patches are
  rejected without changing active state.
- Accepted graph expansion is reproducible from its parent revision and
  evidence.
- Mutating an accepted dependency prevents descendants from running silently.
- UI and CLI produce equivalent command effects and stable machine-readable
  results.
- The UI exposes no prompt, secret, raw tool argument, or provider credential.
- Hostile origins, DNS rebinding, cross-origin forms/WebSockets, missing session
  capabilities, and replayed mutation commands are rejected.

## v0.9 — Self-hosted distributed scheduler

### Outcome

One local coordinator can dispatch repository attempts to registered
user-controlled workers while retaining exclusive state authority and accepting
only coordinator-verified results.

### Deliverables

#### Coordinator service

- Introduce a coordinator RPC boundary and worker enrollment flow.
- Move durable state and event contracts to coordinator-owned SQLite with WAL.
- Cut over under an exclusive migration lock: validate and hash the filesystem
  source, import into a temporary database, verify it, then atomically publish
  one authoritative-store marker.
- Preserve the source backup and allow rollback only before the first
  post-cutover mutation; mixed or ambiguous authority fails closed.
- Keep artifacts content-addressed and local or on explicitly configured user
  storage.
- Add stable worker, lease, attempt, and artifact IDs.

#### Worker protocol

- Register worker identity and capabilities.
- Dispatch immutable repository snapshots and attempt contracts.
- Return patch bundles, artifacts, executor metadata, and structured handoffs.
- Deny workers direct state-store, approval, integration, and external-action
  authority.

#### Lease and fencing safety

- Use bounded leases with monotonically increasing fencing tokens.
- Reject expired, duplicate, or superseded completions.
- Reconcile network partitions and late worker results.
- Make completion acceptance idempotent.
- Keep external actions coordinator-local.

#### Coordinator verification

- Apply worker patches in a clean integration worktree.
- Verify ownership and artifact hashes.
- Rerun deterministic coordinator-owned checks.
- Create checkpoint commits only after verification.
- Record the rejected worker result when verification fails.

### Acceptance gate

- A worker disconnected after receiving work cannot submit an accepted late
  result after reassignment.
- Duplicate delivery results in at most one accepted completion.
- A worker writing outside ownership cannot affect the canonical run branch.
- A compromised or malformed result cannot become accepted or mutate the
  canonical run branch or accepted artifacts; the coordinator may append only
  bounded rejection evidence and audit events.
- Coordinator restart preserves leases, run state, and reconciliation duties.
- Crash injection across every filesystem-to-SQLite cutover seam leaves exactly
  one authoritative store and supports deterministic resume or rollback.
- Local-only execution remains supported without a coordinator network service.

## v1.0 — Autonomous local control plane

### Outcome

The user can supervise bounded autonomous repository work across local or
trusted remote workers from a self-hosted UI, with predictable authority,
resources, integration, rollback, and retention.

### Deliverables

- Automatic activation of safe graph patches within a run mandate.
- Deterministic policy authorization for pre-authorized reversible actions.
- Resource-aware worker placement and provider concurrency enforcement.
- End-to-end time and optional cost accounting.
- Configurable retention with dry-run pruning and permanent minimal manifests.
- Exportable integrity-checked run bundles.
- Optional PostgreSQL storage only when multiple coordinators or high
  availability become an evidenced need.
- Authenticated LAN access to the local control UI.

### Acceptance gate

- Long-running adaptive runs remain within node, depth, duration, resource, and
  authority limits without operator babysitting.
- Every accepted output maps to a plan revision, attempt, worker, artifact set,
  checks, checkpoint commit, and authority decision.
- Every integrated run can be reverted from its recorded lineage.
- Actions outside a mandate stop with one clear human decision.
- Retention never silently removes unresolved failure or external-action
  evidence.

## Cross-cutting verification program

### Lifecycle model tests

- Generate valid and invalid transition sequences.
- Prove accepted nodes cannot regress without explicit invalidation.
- Prove attempt and evidence identities are never reused.
- Prove authority cannot be acquired from agent output.

### Crash and partition tests

- Terminate after every durable write boundary.
- Restart coordinator with active local and remote attempts.
- Deliver late, duplicate, malformed, and out-of-order results.
- Partition worker and coordinator before and after external process completion.

### Git safety tests

- Start from clean, dirty, detached, renamed, submodule, and Windows worktrees.
- Preserve unrelated tracked and untracked user files.
- Exercise checkpoint, conflict, integration, and revert behavior.
- Verify runtime artifacts are never staged into product commits.

### Security and privacy tests

- Confirm workers receive only scoped repository snapshots and no coordinator
  secrets.
- Confirm UI and safe events exclude prompts, raw commands, secrets, and tool
  payloads.
- Confirm policy and approval drift fails closed.
- Confirm executor network behavior remains user-configured and observable.

### Runtime acceptance

Each phase requires representative end-to-end runs through the real CLI and, if
applicable, UI and worker transport. Unit tests, schemas, and static plans are
implementation evidence, not runtime acceptance.

## Deliberately deferred

- Multi-tenancy, organizations, subscriptions, or SaaS hosting.
- Runtime-owned provider APIs, accounts, or credentials.
- Multiple active coordinators before a high-availability requirement exists.
- Unregistered public workers or a worker marketplace.
- LLM-based approval or policy decisions.
- Silent merge conflict resolution or destructive Git rollback.
