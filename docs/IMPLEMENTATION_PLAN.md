# Agent Graph Runtime — implementation plan

Status: proposed implementation sequence for the target architecture in
[`ARCHITECTURE.md`](ARCHITECTURE.md) and the phased outcomes in
[`ROADMAP.md`](ROADMAP.md). The current v0.6 behavior remains governed by
[`SPEC.md`](SPEC.md).

## Implementation policy

- Preserve current public commands and persisted artifacts unless a phase
  explicitly introduces a versioned migration.
- Build migration and recovery support before writing the new format.
- Introduce domain seams only when the next accepted slice consumes them.
- Keep one owner for every mutable artifact and one authoritative coordinator
  transition path.
- Do not combine persistence migration, Git integration, dynamic expansion, and
  remote workers in one release slice.
- Commit implementation in independently revertible vertical slices.

## Required design records

Before implementation, promote the following decisions into stable ADRs if
their contract changes materially during development:

1. local-first and provider-agnostic product boundary;
2. append-only attempt and evidence identity;
3. run worktree, checkpoint, integration, and revert policy;
4. human mandate and deterministic policy authorization;
5. coordinator-only state authority and worker fencing;
6. filesystem/SQLite storage evolution and retention.

## Work package map

| Package | Outcome | Depends on |
|---|---|---|
| WP1 | Versioned, recoverable persistence | — |
| WP2 | Append-only attempts and evidence | WP1 |
| WP3 | Approval receipts and run mandates | WP1, WP2 |
| WP4 | At-most-once external-action control | WP3 |
| WP5 | Isolated run Git transaction | WP2 |
| WP6 | Explicit integrate and rollback | WP3, WP5 |
| WP7 | Graph patches and adaptive plan activation | WP2, WP3 |
| WP8 | Typed artifacts and dependency lineage | WP2, WP5 |
| WP9 | Resource-aware local scheduler and UI | WP7, WP8 |
| WP10 | Coordinator/worker contract and enrollment | WP1, WP8, WP9 |
| WP11 | SQLite, leases, and fencing | WP10 |
| WP12 | Distributed runtime acceptance | WP4, WP6, WP11 |

## WP1 — Versioned, recoverable persistence

### Scope

- Add explicit schema versions to state, events, evidence, reports, and run
  manifests.
- Add state revision and last-applied event sequence.
- Validate state/event coherence before mutation.
- Support atomic migration from unversioned v0.6 artifacts.
- Bootstrap one immutable base `PlanRevision` from every legacy graph before any
  migrated run may be mutated.
- Preserve all raw output and evidence files unchanged.

### Proposed state envelope

```ts
interface RunStateV2 {
  schemaVersion: 2;
  revision: number;
  lastAppliedEventSeq: number;
  runId: string;
  graphHash: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  repository: RepositorySnapshot;
  activePlanRevisionId: string;
  nodes: Record<string, NodeStateV2>;
  attempts: Record<string, AttemptRecord>;
  advisor?: AdvisorRunState;
}
```

### Migration contract

1. Missing `schemaVersion` means legacy v1.
2. Parse and validate state and the complete event log before writing.
3. Normalize wholly legacy cursorless events into new immutable, versioned state
   and log files under a temporary generation ID.
4. Preserve a local backup and content hash until the migrated run is verified.
5. Derive plan revision 1 deterministically from the legacy graph and
   `graphHash`, persist it, and reference it as `activePlanRevisionId`.
6. Validate and publish the immutable generation, then atomically replace one
   `CURRENT` manifest pointer containing its generation ID and file hashes under
   the exclusive run lock. This pointer swap is the only commit point.
7. Reads resolve only the generation named by a valid `CURRENT` pointer. An
   orphan temporary/published generation is ignored; an invalid pointer restores
   the last valid pointer from the migration journal or fails closed without
   combining files from different generations.
8. Never rewrite executor output or evidence content.
9. If any artifact is ambiguous or malformed, stop with an actionable migration
   error and leave every original file unchanged.

### Module impact

- `src/types.ts`: versioned domain envelopes.
- `src/store.ts`: expected-revision mutation protocol and migration entrypoint.
- `src/observation.ts`: version-aware reads and coherent snapshots.
- `src/operator-control.ts`: validate/migrate before mutation.
- New `src/migrations/`: one explicit migration per schema transition.
- New `src/plan-revisions.ts`: immutable base revision identity and lookup;
  adaptive patching remains deferred to WP7.

### Verification

- Golden fixtures for representative v0.1-v0.6 runs.
- Mixed, duplicate, decreasing, truncated, and malformed event logs.
- Crash injection before and after every generation file write, generation
  publish, journal write, and `CURRENT` pointer swap; recovery selects the old or
  new complete generation, never a mixed pair.
- Concurrent mutation confirms one expected revision succeeds.
- Every migrated run resolves its active base revision, and repeated migration
  derives the same revision identity without duplicate records.

## WP2 — Append-only attempts and evidence

### Scope

- Replace resettable attempt counters with immutable, globally unique attempt
  records and monotonic per-node ordinals.
- Add manual invalidation generations.
- Keep historical evidence addressable after retry and descendant invalidation.
- Make report and observation distinguish active, accepted, failed, and
  superseded attempts.

### Transition rules

- Starting a node creates a new globally unique `attemptId`.
- `ordinal` increases monotonically for the node and never resets.
- Manual retry increments `generation` and invalidates current descendants.
- Existing attempts and evidence remain immutable.
- Acceptance points to one exact attempt; later invalidation marks that pointer
  superseded without deleting history.
- Evidence filenames use attempt ID or reserved event sequence, never a resettable
  display counter.

### Module impact

- `src/lifecycle.ts`: attempt creation, invalidation, and supersession.
- `src/runner.ts`: write evidence against immutable attempt identity.
- `src/report.ts`: current and historical attempt views.
- `src/observation.ts`: attempt-aware stop explanations.
- New `src/attempt-ledger.ts`: attempt identity and append-only queries.

### Verification

- Retry the same node three times and verify all evidence hashes remain stable.
- Invalidate an accepted ancestor and preserve descendant history.
- Resume after a crash with an attempt left running.
- Prove a new attempt cannot reuse an old evidence path.

## WP3 — Approval receipts and run mandates

### Scope

- Replace target-only approval state with immutable receipts.
- Add bounded human-issued mandates.
- Add deterministic policy decisions inside a mandate.
- Invalidate authority on repository, evidence, plan, parameter, expiry, or
  policy drift.

### Policy boundary

- The human remains the only root principal.
- A policy can allow only action classes and targets present in its mandate.
- The policy evaluator is deterministic code, never a model call.
- Production, payment, deletion, outbound communication, and unknown external
  effects require an explicit human receipt by default.

### Module impact

- New `src/authority.ts`: mandate, policy decision, receipt reservation, and
  consumption validation.
- `src/lifecycle.ts`: append-only authority invalidation and consumption events.
- `src/operator-control.ts`: issue, inspect, and reconcile human decisions.
- `src/graph.ts`: validate action classes and policy declarations.

### Verification

- Mutate each bound field and prove the receipt becomes unusable.
- Attempt receipt reuse and prove the second effect is denied.
- Attempt policy escalation beyond mandate and prove fail-closed behavior.
- Confirm safe events and UI views reveal decisions without secrets.

## WP4 — At-most-once external-action control

### Scope

- Make every external action manual-retry only.
- Treat any uncertain or failed completion as reconciliation-required.
- Separate action preparation from coordinator-owned execution.
- Add optional idempotency metadata without weakening reconciliation.

### Rules

- Graph validation rejects an automatic retry policy for `external_action`.
- No worker, local or remote, may dispatch an external action or claim one
  completed; only the coordinator-local action service can do so.
- Before dispatch, the coordinator durably reserves one valid, single-use
  approval receipt for the exact action attempt, then appends its consumption
  record before invoking the executor.
- If the coordinator restarts after reservation or consumption but before a
  verified outcome, the attempt enters reconciliation; it is never replayed.
- Non-zero, timeout, cancellation, malformed output, lost process, or
  process-tree uncertainty sets `retryBlocked` and run attention.
- Plain `agr run` never repeats a blocked external action.
- `agr retry` requires recorded reconciliation evidence and a newly issued
  approval receipt.

### Verification

- Count actual side effects across non-zero, timeout, cancellation, restart, and
  repeated resume cases; each case executes once.
- Crash before reservation, after reservation, after consumption, and after
  dispatch; every uncertain post-reservation restart requires reconciliation.
- Prove reconciliation and explicit retry create a new attempt and authority
  receipt while preserving the prior attempt.
- Prove any worker result that claims an external action completed is rejected.

## WP5 — Isolated run Git transaction

### Scope

- Create writing runs in repository-local worktrees and run branches.
- Preserve the primary checkout, including existing dirty state.
- Create accepted wave checkpoint commits.
- Produce an immutable run result manifest.

### Proposed repository types

```ts
interface RepositorySnapshot {
  repositoryRoot: string;
  baseCommit: string;
  treeHash: string;
  userCheckoutFingerprint: string;
}

interface RunResult {
  runId: string;
  baseCommit: string;
  resultCommit: string;
  checkpointCommits: string[];
  planRevisionId: string;
  acceptedAttemptIds: string[];
  evidenceDigest: string;
}
```

### Rules

- Put runtime-created worktrees under `<repo>/.worktrees/<run-id>`.
- Add `.worktrees/` to the primary checkout's `.git/info/exclude` before the
  first runtime-created worktree; do not modify tracked `.gitignore` solely for
  this purpose.
- Require every writing run to start from an exact commit. A chained run records
  its parent run and starts from an explicit prior result commit, never another
  run's mutable worktree.
- Never stage `.agent-graph` state, prompts, outputs, or evidence into product
  commits.
- Do not auto-resolve merge conflicts.
- Serialize writers until per-node worktree isolation is accepted.

### Verification

- Clean and dirty primary checkouts remain unchanged.
- Track modified, untracked, renamed, deleted, binary, symlink, submodule, and
  Windows path cases.
- Fail checkpoint creation without advancing acceptance when Git state is
  inconsistent.
- Recover a run worktree and private ref after coordinator restart.

## WP6 — Explicit integrate and rollback

### Scope

- Add `agr integrate <run-id> [--dry-run]`.
- Add `agr rollback <run-id> [--dry-run]`.
- Validate lineage, current target branch, evidence digests, and final checks.
- Integrate without destructive history operations.

### Integration behavior

- Dry-run reports fast-forward, cherry-pick, or conflict outcome.
- Real integration requires a completed `RunResult` and any required human
  receipt.
- Conflict stops with preserved run branch and actionable paths.
- Successful integration appends an immutable `IntegrationRecord` referencing
  the unchanged `RunResult`, target branch, and resulting commit.

### Rollback behavior

- Rollback targets an `IntegrationRecord` and appends an immutable
  `RollbackRecord` referencing the created revert commit.
- It previews and then creates a revert commit.
- It never resets, cleans, force-pushes, or deletes unrelated data.
- External effects require separate reconciliation and are not implied to be
  reverted by Git.

### Verification

- Fast-forward, divergent, conflicting, already-integrated, and already-reverted
  cases.
- Revert restores repository content while preserving both histories.
- External-action evidence remains open until separately reconciled.

## WP7 — Immutable plan revisions and graph patches

### Scope

- Add immutable `PlanRevision` and proposed `GraphPatch` records.
- Freeze the revision used by each attempt.
- Activate validated patches only between waves.
- Enforce expansion budgets and proposal provenance.

### Validation order

1. Parse and schema validation.
2. Provenance and referenced evidence validation.
3. Dependency and cycle validation.
4. Ownership and named resource validation.
5. Executor capability validation.
6. Node, depth, duration, and cost budget validation.
7. Mandate and action authority validation.
8. Persist proposed and validated revision before activation.

### Verification

- Propose patches during an active wave and prove no mutation occurs.
- Reject cyclic, conflicting, unauthorized, unsupported, and over-budget
  patches.
- Reproduce every active revision from parent revision plus patch.
- Resume after a crash between validation and activation.

## WP8 — Typed artifacts and dependency lineage

### Scope

- Add `produces` and `consumes` contracts to graph nodes.
- Store content-addressed artifacts and producer attempt identity.
- Bind descendant readiness to accepted artifact fingerprints.
- Preserve full source artifacts and bounded derived views separately.

### Verification

- Mutate, delete, or replace an accepted dependency artifact and block stale
  descendants.
- Detect hash mismatch before model dispatch.
- Preserve raw artifacts when summaries or compact views are regenerated.
- Keep navigation/context tools explicitly non-authoritative.

## WP9 — Resource-aware local scheduler and UI

### Scope

- Add named shared/exclusive resource leases.
- Schedule by dependency, write isolation, resource capacity, and mandate budget.
- Add a loopback-only control UI backed by observation and command APIs.
- Require a per-session unguessable capability, strict Host and Origin checks,
  CSRF protection, and no wildcard CORS even on loopback.
- Require command-specific preview and authority validation for retry, approval,
  integration, rollback, and external effects.

### Verification

- Serialize browser profile, port, database, Docker, GPU, and external-target
  conflicts.
- Preserve useful parallelism for independent read-only work.
- Compare CLI and UI command effects against the same contract fixtures.
- Verify UI output omits prompts, secrets, tool arguments, and provider
  credentials.
- Reject missing/invalid session capabilities, hostile Host/Origin headers,
  cross-origin forms and WebSockets, replayed commands, and DNS rebinding.

## WP10 — Coordinator/worker contract and enrollment

### Scope

- Define coordinator RPC and worker enrollment.
- Register worker capabilities and health.
- Define immutable attempt, repository snapshot, patch bundle, artifact, and
  handoff envelopes without enabling remote attempt dispatch.

### Security boundary

- Initial remote workers are trusted user-owned machines.
- Registration secures transport identity but does not bypass result checks.
- Workers receive no state-store, mandate, approval, or integration credential.
- Source confidentiality cannot be established by result checks; untrusted
  workers require a separate sandbox and sanitized-input design.
- Remote attempt dispatch remains fail-closed until WP11 provides durable lease
  acquisition, fencing, and compare-and-set completion.

### Verification

- Reject unknown workers, unsupported capabilities, malformed bundles, and
  invalid artifact hashes.
- Confirm worker cannot mutate canonical state through any RPC.
- Confirm executor provider access comes only from worker-local user
  configuration.
- Confirm every dispatch endpoint rejects work before the WP11 capability flag
  is atomically activated.

## WP11 — SQLite, leases, and fencing

### Scope

- Implement coordinator-owned SQLite with WAL behind semantic storage ports.
- Persist workers, attempts, events, leases, fencing tokens, policy decisions,
  and artifact metadata.
- Keep artifact bytes outside the relational store.

### Rules

- Workers never connect to SQLite directly.
- Lease acquisition and fencing increment are atomic.
- Completion uses compare-and-set against attempt, lease, and fencing state.
- Expired results remain recorded as rejected evidence.

### Filesystem-to-SQLite cutover

1. Stop dispatch and acquire an exclusive coordinator migration lock.
2. Validate the complete filesystem state, event journal, plan revisions,
   authority records, and artifact hashes without writing either store.
3. Preserve a hash-addressed backup and source manifest.
4. Import into a temporary SQLite database and run the domain contract suite and
   deterministic reconciliation queries against it.
5. Atomically publish one authoritative-store marker that names the SQLite
   database identity and imported source manifest hash.
6. Enable leased dispatch only after the marker and database agree.
7. On any crash or mixed/ambiguous state, fail closed and resume the same
   migration or restore the filesystem authority from the untouched backup;
   never accept mutations into both stores.
8. Keep rollback available only before the first post-cutover mutation. After
   that boundary, recovery restores SQLite plus its journal rather than silently
   switching authority back to stale files.

### Verification

- Duplicate delivery, late completion, lease expiration, coordinator restart,
  database busy, and transaction rollback cases.
- SQLite and filesystem implementations pass the same domain contract suite
  where their supported behavior overlaps.
- Crash injection at every cutover seam proves exactly one store is authoritative
  and duplicate import is idempotent.
- Upgrade, rollback-before-first-mutation, mixed-state, and corrupt-marker
  fixtures fail closed with actionable recovery instructions.

## WP12 — Distributed runtime acceptance

### Scope

- Exercise the complete self-hosted flow on at least two user-controlled
  machines or isolated environments.
- Include local and hosted-model executors without changing provider ownership.
- Verify coordinator-side patch application, checks, checkpoint, integration,
  and rollback.

### Required scenarios

- Worker disappears before process start.
- Worker disappears while the model continues running.
- Lease expires and work is reassigned.
- Old worker returns a valid-looking late result.
- Patch escapes ownership.
- Coordinator restarts during result acceptance.
- Human mandate expires during a long run.
- External action requires reconciliation.
- Final branch diverges before integration.

No distributed phase is runtime-accepted until all required scenarios produce
bounded, explainable, and recoverable outcomes.

## Documentation and compatibility work in every package

- Update `SPEC.md` only when behavior is implemented and verified.
- Update JSON schema and authoring references with every public graph change.
- Include migration notes and rollback instructions.
- Mark planned, implemented, verified, runtime-accepted, and released states
  separately.
- Preserve stable CLI exit codes or version their changes explicitly.
- Keep examples executable and include at least one negative safety example.

## Definition of complete

A work package is complete only when:

1. its domain invariant exists in code rather than documentation alone;
2. persisted and public contracts are versioned;
3. negative, recovery, and compatibility tests pass;
4. representative runtime acceptance passes from a clean state;
5. documentation describes the delivered behavior rather than the plan;
6. independent review finds no unresolved outcome, safety, data, infrastructure,
   or public-contract blocker.
