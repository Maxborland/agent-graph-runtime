import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { mkdirSync } from "node:fs";

import { verifyRunEvidenceArtifacts } from "./evidence.js";
import { readCurrentGeneration, sha256 } from "./persistence.js";
import { assertSafeRunId } from "./run-id.js";
import type { RunState } from "./types.js";
import { acquireRunLock } from "./run-lock.js";

const require = createRequire(import.meta.url);
let databaseConstructor: typeof DatabaseSyncType | undefined;
function sqliteConstructor(): typeof DatabaseSyncType {
  databaseConstructor ??= (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
  return databaseConstructor;
}

export interface WorkerCapabilities {
  executors: string[];
  resources: string[];
  capabilities?: string[];
  maxConcurrency: number;
}

export interface WorkerEnrollment {
  workerId: string;
  token: string;
  expiresAt: number;
}

export interface RemoteAttemptEnvelope {
  schemaVersion: 1;
  attemptId: string;
  runId: string;
  nodeId: string;
  planRevisionId: string;
  repositorySnapshotHash: string;
  requiredCapabilities: string[];
  externalAction: boolean;
}

export interface WorkerLease {
  leaseId: string;
  attemptId: string;
  workerId: string;
  fencingToken: number;
  expiresAt: number;
}

export interface WorkerCompletion {
  attemptId: string;
  workerId: string;
  workerToken: string;
  fencingToken: number;
  completedAt: number;
  resultHash: string;
}

export class CoordinatorDatabase {
  private readonly database: DatabaseSyncType;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    const DatabaseSync = sqliteConstructor();
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers (
        worker_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, capabilities_json TEXT NOT NULL,
        enrolled_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL, envelope_hash TEXT NOT NULL, status TEXT NOT NULL,
        fencing_token INTEGER NOT NULL DEFAULT 0, result_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS leases (
        attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id), lease_id TEXT NOT NULL,
        worker_id TEXT NOT NULL REFERENCES workers(worker_id), fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rejected_results (
        rejection_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, worker_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL, result_hash TEXT NOT NULL, reason TEXT NOT NULL,
        rejected_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imported_runs (
        run_id TEXT PRIMARY KEY, source_manifest_hash TEXT NOT NULL, state_json TEXT NOT NULL,
        events_jsonl TEXT NOT NULL, imported_at INTEGER NOT NULL, storage_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS acceptance_intents (
        attempt_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
        result_json TEXT NOT NULL, result_hash TEXT NOT NULL, staged_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `);
  }

  close(): void { this.database.close(); }

  journalMode(): string {
    const row = this.database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    return row.journal_mode.toLowerCase();
  }

  hasPostCutoverMutation(): boolean {
    return (this.database.prepare("SELECT value FROM meta WHERE key='post_cutover_mutation'").get() as { value: string } | undefined)?.value === "true";
  }

  enrollWorker(capabilities: WorkerCapabilities, ttlMs: number, now = Date.now()): WorkerEnrollment {
    if (!Number.isInteger(capabilities.maxConcurrency) || capabilities.maxConcurrency < 1) throw new Error("worker maxConcurrency must be positive");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("worker enrollment TTL must be positive");
    const workerId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + ttlMs;
    this.database.prepare("INSERT INTO workers VALUES (?, ?, ?, ?, ?)").run(
      workerId, sha256(token), JSON.stringify(capabilities), now, expiresAt,
    );
    return { workerId, token, expiresAt };
  }

  createAttempt(envelope: RemoteAttemptEnvelope): void {
    if (envelope.schemaVersion !== 1 || !envelope.attemptId || !envelope.runId || !envelope.nodeId || !envelope.planRevisionId) throw new Error("invalid attempt envelope");
    if (envelope.externalAction) throw new Error("workers may never execute external actions");
    const raw = canonical(envelope);
    try {
      this.database.prepare("INSERT INTO attempts(attempt_id, run_id, node_id, envelope_json, envelope_hash, status) VALUES (?, ?, ?, ?, ?, 'pending')")
        .run(envelope.attemptId, envelope.runId, envelope.nodeId, raw, sha256(raw));
    } catch (error) {
      const existing = this.database.prepare("SELECT envelope_hash FROM attempts WHERE attempt_id = ?").get(envelope.attemptId) as { envelope_hash: string } | undefined;
      if (!existing || existing.envelope_hash !== sha256(raw)) throw error;
    }
  }

  attemptEnvelope(attemptId: string): RemoteAttemptEnvelope | undefined {
    const row = this.database.prepare("SELECT envelope_json FROM attempts WHERE attempt_id=?").get(attemptId) as { envelope_json: string } | undefined;
    return row ? JSON.parse(row.envelope_json) as RemoteAttemptEnvelope : undefined;
  }

  activateDispatch(sourceManifestHash: string): void {
    if (!sourceManifestHash) throw new Error("verified source manifest hash is required for dispatch cutover");
    this.database.prepare("INSERT INTO meta(key, value) VALUES ('dispatch_manifest', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(sourceManifestHash);
  }

  acquireLease(attemptId: string, workerId: string, token: string, ttlMs: number, now = Date.now()): WorkerLease {
    if (!this.database.prepare("SELECT value FROM meta WHERE key='dispatch_manifest'").get()) throw new Error("remote dispatch is disabled until verified SQLite cutover");
    const worker = this.requireWorker(workerId, token, now);
    const attempt = this.database.prepare("SELECT envelope_json, status, fencing_token FROM attempts WHERE attempt_id=?").get(attemptId) as {
      envelope_json: string; status: string; fencing_token: number;
    } | undefined;
    if (!attempt) throw new Error(`unknown attempt ${attemptId}`);
    if (attempt.status === "completed") throw new Error(`attempt ${attemptId} is already completed`);
    const envelope = JSON.parse(attempt.envelope_json) as RemoteAttemptEnvelope;
    this.requireCapabilities(worker, envelope.requiredCapabilities);
    const leaseId = randomUUID();
    const expiresAt = now + ttlMs;
    this.transaction(() => {
      const current = this.database.prepare("SELECT status, fencing_token FROM attempts WHERE attempt_id=?").get(attemptId) as { status: string; fencing_token: number };
      const held = this.database.prepare("SELECT expires_at FROM leases WHERE attempt_id=?").get(attemptId) as { expires_at: number } | undefined;
      if (current.status === "completed") throw new Error(`attempt ${attemptId} is already completed`);
      if (held && held.expires_at > now) throw new Error(`attempt ${attemptId} already has a live lease`);
      const fencingToken = current.fencing_token + 1;
      this.database.prepare("UPDATE attempts SET status='leased', fencing_token=? WHERE attempt_id=?").run(fencingToken, attemptId);
      this.database.prepare(`INSERT INTO leases(attempt_id, lease_id, worker_id, fencing_token, expires_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET lease_id=excluded.lease_id, worker_id=excluded.worker_id,
        fencing_token=excluded.fencing_token, expires_at=excluded.expires_at`).run(attemptId, leaseId, workerId, fencingToken, expiresAt);
    });
    const tokenRow = this.database.prepare("SELECT fencing_token FROM attempts WHERE attempt_id=?").get(attemptId) as { fencing_token: number };
    return { leaseId, attemptId, workerId, fencingToken: tokenRow.fencing_token, expiresAt };
  }

  completeAttempt(completion: WorkerCompletion, receivedAt = Date.now()): { accepted: boolean; reason?: string } {
    const staged = this.database.prepare("SELECT result_hash, staged_at FROM acceptance_intents WHERE attempt_id=?").get(completion.attemptId) as { result_hash: string; staged_at: number } | undefined;
    const authorityTime = staged?.result_hash === completion.resultHash ? staged.staged_at : receivedAt;
    this.requireWorker(completion.workerId, completion.workerToken, authorityTime);
    return this.transaction(() => {
      const attempt = this.database.prepare("SELECT status, fencing_token, result_hash FROM attempts WHERE attempt_id=?").get(completion.attemptId) as { status: string; fencing_token: number; result_hash: string | null } | undefined;
      const lease = this.database.prepare("SELECT worker_id, fencing_token, expires_at FROM leases WHERE attempt_id=?").get(completion.attemptId) as { worker_id: string; fencing_token: number; expires_at: number } | undefined;
      let reason = "";
      if (attempt?.status === "completed" && attempt.result_hash === completion.resultHash) return { accepted: true };
      if (!attempt || !lease) reason = "attempt has no current lease";
      else if (attempt.status !== "leased") reason = `attempt status is ${attempt.status}`;
      else if (attempt.fencing_token !== completion.fencingToken || lease.fencing_token !== completion.fencingToken) reason = "stale fencing token";
      else if (lease.worker_id !== completion.workerId) reason = "lease belongs to another worker";
      else if (lease.expires_at < authorityTime) reason = "lease expired before coordinator receipt";
      if (reason) {
        this.recordRejection(completion, reason, receivedAt);
        return { accepted: false, reason };
      }
      const changed = this.database.prepare("UPDATE attempts SET status='completed', result_hash=? WHERE attempt_id=? AND status='leased' AND fencing_token=?")
        .run(completion.resultHash, completion.attemptId, completion.fencingToken).changes;
      if (Number(changed) !== 1) {
        reason = "compare-and-set completion lost";
        this.recordRejection(completion, reason, receivedAt);
        return { accepted: false, reason };
      }
      this.database.prepare("DELETE FROM leases WHERE attempt_id=?").run(completion.attemptId);
      return { accepted: true };
    });
  }

  stageAcceptanceIntent(completion: WorkerCompletion, resultJson: string, receivedAt = Date.now()): void {
    this.requireWorker(completion.workerId, completion.workerToken, receivedAt);
    const attempt = this.database.prepare("SELECT status, fencing_token FROM attempts WHERE attempt_id=?").get(completion.attemptId) as { status: string; fencing_token: number } | undefined;
    const lease = this.database.prepare("SELECT worker_id, fencing_token, expires_at FROM leases WHERE attempt_id=?").get(completion.attemptId) as { worker_id: string; fencing_token: number; expires_at: number } | undefined;
    if (!attempt || !lease || attempt.status !== "leased" || attempt.fencing_token !== completion.fencingToken || lease.fencing_token !== completion.fencingToken || lease.worker_id !== completion.workerId || lease.expires_at < receivedAt) {
      throw new Error("cannot stage result acceptance without the current live fenced lease");
    }
    const hash = sha256(resultJson);
    const existing = this.database.prepare("SELECT result_hash FROM acceptance_intents WHERE attempt_id=?").get(completion.attemptId) as { result_hash: string } | undefined;
    if (existing && existing.result_hash !== hash) throw new Error("a different result acceptance intent already exists");
    this.database.prepare("INSERT INTO acceptance_intents VALUES (?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(attempt_id) DO NOTHING")
      .run(completion.attemptId, completion.workerId, completion.fencingToken, resultJson, hash, receivedAt);
  }

  pendingAcceptanceIntents(runId?: string): Array<{ attemptId: string; workerId: string; fencingToken: number; resultJson: string }> {
    const rows = (runId === undefined
      ? this.database.prepare("SELECT attempt_id, worker_id, fencing_token, result_json FROM acceptance_intents WHERE status='pending' ORDER BY staged_at, attempt_id").all()
      : this.database.prepare("SELECT i.attempt_id, i.worker_id, i.fencing_token, i.result_json FROM acceptance_intents i JOIN attempts a ON a.attempt_id=i.attempt_id WHERE i.status='pending' AND a.run_id=? ORDER BY i.staged_at, i.attempt_id").all(runId)) as Array<{
      attempt_id: string; worker_id: string; fencing_token: number; result_json: string;
    }>;
    return rows.map((row) => ({ attemptId: row.attempt_id, workerId: row.worker_id, fencingToken: row.fencing_token, resultJson: row.result_json }));
  }

  resolveAcceptanceIntent(attemptId: string): void {
    this.database.prepare("UPDATE acceptance_intents SET status='resolved' WHERE attempt_id=? AND status='pending'").run(attemptId);
  }

  rejectedResults(attemptId: string): Array<Record<string, unknown>> {
    return this.database.prepare("SELECT * FROM rejected_results WHERE attempt_id=? ORDER BY rejected_at, rejection_id").all(attemptId) as Array<Record<string, unknown>>;
  }

  importedRun(runId: string): { sourceManifestHash: string } | undefined {
    const row = this.database.prepare("SELECT source_manifest_hash FROM imported_runs WHERE run_id=?").get(runId) as { source_manifest_hash: string } | undefined;
    return row ? { sourceManifestHash: row.source_manifest_hash } : undefined;
  }

  cutoverInventory(): { importedRuns: Array<{ runId: string; sourceManifestHash: string }>; attemptCount: number } {
    const importedRuns = this.database.prepare("SELECT run_id, source_manifest_hash FROM imported_runs ORDER BY run_id").all() as Array<{ run_id: string; source_manifest_hash: string }>;
    const attempts = this.database.prepare("SELECT COUNT(*) AS count FROM attempts").get() as { count: number };
    return {
      importedRuns: importedRuns.map((run) => ({ runId: run.run_id, sourceManifestHash: run.source_manifest_hash })),
      attemptCount: Number(attempts.count),
    };
  }

  runProjection(runId: string): { sourceManifestHash: string; stateRaw: string; eventsRaw: string; storageRevision: number } | undefined {
    const row = this.database.prepare("SELECT source_manifest_hash, state_json, events_jsonl, storage_revision FROM imported_runs WHERE run_id=?").get(runId) as {
      source_manifest_hash: string; state_json: string; events_jsonl: string; storage_revision: number;
    } | undefined;
    return row ? { sourceManifestHash: row.source_manifest_hash, stateRaw: row.state_json, eventsRaw: row.events_jsonl, storageRevision: row.storage_revision } : undefined;
  }

  saveRunProjection(runId: string, expectedStorageRevision: number, stateRaw: string, eventsRaw: string): number {
    const next = expectedStorageRevision + 1;
    const changed = this.database.prepare("UPDATE imported_runs SET state_json=?, events_jsonl=?, storage_revision=? WHERE run_id=? AND storage_revision=?")
      .run(stateRaw, eventsRaw, next, runId, expectedStorageRevision).changes;
    if (Number(changed) !== 1) throw new Error(`stale SQLite run projection for ${runId}`);
    this.database.prepare("INSERT INTO meta(key,value) VALUES ('post_cutover_mutation','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
    return next;
  }

  workers(): Array<{ workerId: string; capabilities: WorkerCapabilities; enrolledAt: number; expiresAt: number }> {
    const rows = this.database.prepare("SELECT worker_id, capabilities_json, enrolled_at, expires_at FROM workers ORDER BY enrolled_at, worker_id").all() as Array<{
      worker_id: string; capabilities_json: string; enrolled_at: number; expires_at: number;
    }>;
    return rows.map((row) => ({
      workerId: row.worker_id,
      capabilities: JSON.parse(row.capabilities_json) as WorkerCapabilities,
      enrolledAt: row.enrolled_at,
      expiresAt: row.expires_at,
    }));
  }

  exportRunAudit(runId: string): Record<string, unknown> {
    const attempts = this.database.prepare("SELECT * FROM attempts WHERE run_id=? ORDER BY attempt_id").all(runId) as Array<Record<string, unknown>>;
    const attemptIds = attempts.map((attempt) => String(attempt.attempt_id));
    const leases: Array<Record<string, unknown>> = [];
    const rejectedResults: Array<Record<string, unknown>> = [];
    const acceptanceIntents: Array<Record<string, unknown>> = [];
    for (const attemptId of attemptIds) {
      const lease = this.database.prepare("SELECT * FROM leases WHERE attempt_id=?").get(attemptId) as Record<string, unknown> | undefined;
      if (lease) leases.push(lease);
      rejectedResults.push(...this.database.prepare("SELECT * FROM rejected_results WHERE attempt_id=? ORDER BY rejected_at, rejection_id").all(attemptId) as Array<Record<string, unknown>>);
      const intent = this.database.prepare("SELECT * FROM acceptance_intents WHERE attempt_id=?").get(attemptId) as Record<string, unknown> | undefined;
      if (intent) acceptanceIntents.push(intent);
    }
    const workerIds = new Set([...leases, ...rejectedResults, ...acceptanceIntents].map((record) => String(record.worker_id)));
    const workers = [...workerIds].sort().flatMap((workerId) => {
      const worker = this.database.prepare("SELECT worker_id, capabilities_json, enrolled_at, expires_at FROM workers WHERE worker_id=?").get(workerId) as Record<string, unknown> | undefined;
      if (!worker) throw new Error(`coordinator audit references missing worker ${workerId}`);
      return [worker];
    });
    return { schemaVersion: 1, runId, workers, attempts, leases, rejectedResults, acceptanceIntents };
  }

  exportRunSnapshot(runId: string): { stateRaw: string; eventsRaw: string; audit: Record<string, unknown> } {
    this.database.exec("BEGIN");
    try {
      const projection = this.runProjection(runId);
      if (!projection) throw new Error(`SQLite has no authoritative projection for ${runId}`);
      const snapshot = { stateRaw: projection.stateRaw, eventsRaw: projection.eventsRaw, audit: this.exportRunAudit(runId) };
      this.database.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  selectWorker(requiredCapabilities: string[], now = Date.now()): string {
    const candidates = this.workers().filter((worker) => worker.expiresAt >= now).flatMap((worker) => {
      const available = new Set([
        ...worker.capabilities.executors.map((value) => `executor:${value}`),
        ...worker.capabilities.resources.map((value) => `resource:${value}`),
        ...(worker.capabilities.capabilities ?? []).map((value) => `capability:${value}`),
      ]);
      if (requiredCapabilities.some((value) => !available.has(value))) return [];
      const active = this.database.prepare("SELECT COUNT(*) AS count FROM leases WHERE worker_id=? AND expires_at>?").get(worker.workerId, now) as { count: number };
      if (active.count >= worker.capabilities.maxConcurrency) return [];
      return [{ workerId: worker.workerId, active: active.count }];
    }).sort((left, right) => left.active - right.active || left.workerId.localeCompare(right.workerId));
    if (!candidates[0]) throw new Error(`no enrolled worker satisfies capabilities: ${requiredCapabilities.join(", ")}`);
    return candidates[0].workerId;
  }

  importRun(runId: string, manifestHash: string, stateRaw: string, eventsRaw: string): void {
    const existing = this.importedRun(runId);
    if (existing && existing.sourceManifestHash !== manifestHash) throw new Error("run was already imported from a different source manifest");
    this.database.prepare(`INSERT INTO imported_runs(run_id, source_manifest_hash, state_json, events_jsonl, imported_at, storage_revision) VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(run_id) DO NOTHING`).run(runId, manifestHash, stateRaw, eventsRaw, Date.now());
  }

  private requireWorker(workerId: string, token: string, now: number): WorkerCapabilities {
    const row = this.database.prepare("SELECT token_hash, capabilities_json, expires_at FROM workers WHERE worker_id=?").get(workerId) as {
      token_hash: string; capabilities_json: string; expires_at: number;
    } | undefined;
    if (!row || row.token_hash !== sha256(token)) throw new Error("unknown or invalid worker credential");
    if (row.expires_at < now) throw new Error("worker enrollment expired");
    return JSON.parse(row.capabilities_json) as WorkerCapabilities;
  }

  private requireCapabilities(worker: WorkerCapabilities, requirements: string[]): void {
    const available = new Set([
      ...worker.executors.map((value) => `executor:${value}`),
      ...worker.resources.map((value) => `resource:${value}`),
      ...(worker.capabilities ?? []).map((value) => `capability:${value}`),
    ]);
    const missing = requirements.filter((value) => !available.has(value));
    if (missing.length > 0) throw new Error(`worker capability mismatch: ${missing.join(", ")}`);
  }

  private recordRejection(completion: WorkerCompletion, reason: string, rejectedAt: number): void {
    this.database.prepare("INSERT INTO rejected_results VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), completion.attemptId, completion.workerId, completion.fencingToken,
      completion.resultHash, reason, rejectedAt,
    );
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export interface CutoverResult {
  sourceManifestHash: string;
  databasePath: string;
  markerPath: string;
}

export async function readSqliteRunProjection(repositoryRoot: string, runId: string): Promise<{
  databasePath: string;
  sourceManifestHash: string;
  stateRaw: string;
  eventsRaw: string;
  storageRevision: number;
} | undefined> {
  const markerRaw = await readOptional(join(repositoryRoot, ".agent-graph", "AUTHORITATIVE_STORE.json"));
  if (!markerRaw) return undefined;
  const marker = JSON.parse(markerRaw) as {
    schemaVersion: number; kind: string; databasePath: string; runId?: string;
    sourceManifestHash: string; migratedRuns?: Record<string, string>; postCutoverMutation?: boolean;
  };
  if (marker.schemaVersion !== 1 || marker.kind !== "sqlite" || !marker.databasePath) throw new Error("ambiguous or corrupt authoritative-store marker");
  const expected = marker.migratedRuns?.[runId] ?? (marker.runId === runId ? marker.sourceManifestHash : undefined);
  if (!expected) return undefined;
  const database = new CoordinatorDatabase(marker.databasePath);
  let mutated = false;
  let projection: ReturnType<CoordinatorDatabase["runProjection"]>;
  try {
    projection = database.runProjection(runId);
    if (!projection || projection.sourceManifestHash !== expected) throw new Error("authoritative marker and SQLite run projection do not agree");
    mutated = database.hasPostCutoverMutation();
  } finally { database.close(); }
  if (mutated && marker.postCutoverMutation !== true) {
    await markSqlitePostCutoverMutation(repositoryRoot, runId);
  }
  return { databasePath: resolve(marker.databasePath), ...projection! };
}

export async function markSqlitePostCutoverMutation(repositoryRoot: string, runId: string): Promise<void> {
  const markerLock = await acquireStorageMigrationLock(repositoryRoot);
  try {
    await markSqlitePostCutoverMutationLocked(repositoryRoot, runId);
  } finally { await markerLock.release(); }
}

async function markSqlitePostCutoverMutationLocked(repositoryRoot: string, runId: string): Promise<void> {
  const markerPath = join(repositoryRoot, ".agent-graph", "AUTHORITATIVE_STORE.json");
  const raw = await readOptional(markerPath);
  if (!raw) throw new Error("SQLite mutation has no authoritative-store marker");
  const marker = JSON.parse(raw) as Record<string, unknown> & { runId?: string; migratedRuns?: Record<string, string> };
  if (marker.runId !== runId && !marker.migratedRuns?.[runId]) throw new Error(`run ${runId} is not named by the SQLite authority marker`);
  if (marker.postCutoverMutation === true) return;
  const temporary = `${markerPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, canonical({ ...marker, postCutoverMutation: true, firstPostCutoverMutationAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
  await rename(temporary, markerPath);
}

export async function migrateRunToSqlite(repositoryRoot: string, runId: string, databasePath: string): Promise<CutoverResult> {
  const migrationLock = await acquireStorageMigrationLock(repositoryRoot);
  try {
    return await migrateRunToSqliteLocked(repositoryRoot, runId, databasePath);
  } finally { await migrationLock.release(); }
}

async function acquireStorageMigrationLock(repositoryRoot: string): Promise<Awaited<ReturnType<typeof acquireRunLock>>> {
  const coordinationRoot = join(repositoryRoot, ".agent-graph", "coordination");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { return await acquireRunLock(coordinationRoot, "storage-migration"); } catch (error) {
      if ((error as { code?: string }).code !== "RUN_LOCKED" || attempt === 199) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error("storage migration lock acquisition exhausted");
}

async function migrateRunToSqliteLocked(repositoryRoot: string, runId: string, databasePath: string): Promise<CutoverResult> {
  assertSafeRunId(runId);
  const markerPath = join(repositoryRoot, ".agent-graph", "AUTHORITATIVE_STORE.json");
  const existingMarker = await readOptional(markerPath);
  let existingMarkerRecord: { schemaVersion: number; kind: string; databasePath: string; sourceManifestHash: string; runId?: string; migratedRuns?: Record<string, string>; postCutoverMutation?: boolean } | undefined;
  if (existingMarker) {
    const marker = JSON.parse(existingMarker) as typeof existingMarkerRecord;
    if (!marker) throw new Error("ambiguous or corrupt authoritative-store marker");
    if (marker.schemaVersion !== 1 || marker.kind !== "sqlite" || resolve(marker.databasePath) !== resolve(databasePath)) throw new Error("ambiguous or corrupt authoritative-store marker");
    const expected = marker.migratedRuns?.[runId] ?? (marker.runId === runId ? marker.sourceManifestHash : undefined);
    if (expected) {
      const database = new CoordinatorDatabase(databasePath);
      try {
      if (!expected || database.importedRun(runId)?.sourceManifestHash !== expected) throw new Error("authoritative marker and SQLite import do not agree");
      } finally { database.close(); }
      return { sourceManifestHash: expected, databasePath: resolve(databasePath), markerPath };
    }
    existingMarkerRecord = marker;
  }
  const runDirectory = join(repositoryRoot, ".agent-graph", "runs", runId);
  const generation = await readCurrentGeneration(runDirectory);
  if (!generation) throw new Error(`run ${runId} has no authoritative filesystem generation to migrate`);
  const state = JSON.parse(generation.stateRaw) as RunState;
  if (state.runId !== runId) throw new Error("filesystem run identity mismatch during migration");
  await verifyRunEvidenceArtifacts(runDirectory, state);
  const manifest = await sourceManifest(runDirectory);
  const manifestRaw = canonical({ schemaVersion: 1, runId, files: manifest });
  const sourceManifestHash = sha256(manifestRaw);
  const backupDirectory = join(repositoryRoot, ".agent-graph", "migration-backups", sourceManifestHash);
  await mkdir(backupDirectory, { recursive: true });
  await writeImmutable(join(backupDirectory, "manifest.json"), manifestRaw);
  await cp(generation.statePath, join(backupDirectory, "state.json"), { force: false, errorOnExist: false });
  await cp(generation.eventsPath, join(backupDirectory, "events.jsonl"), { force: false, errorOnExist: false });

  if (existingMarkerRecord) {
    const database = new CoordinatorDatabase(databasePath);
    try {
      database.importRun(runId, sourceManifestHash, generation.stateRaw, generation.eventsRaw);
      database.activateDispatch(existingMarkerRecord.sourceManifestHash);
    } finally { database.close(); }
    const updated = canonical({
      ...existingMarkerRecord,
      migratedRuns: { ...(existingMarkerRecord.migratedRuns ?? (existingMarkerRecord.runId ? { [existingMarkerRecord.runId]: existingMarkerRecord.sourceManifestHash } : {})), [runId]: sourceManifestHash },
      updatedAt: new Date().toISOString(),
    });
    const temporaryMarker = `${markerPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryMarker, updated, { encoding: "utf8", flag: "wx" });
    await rename(temporaryMarker, markerPath);
    return { sourceManifestHash, databasePath: resolve(databasePath), markerPath };
  }

  await mkdir(dirname(databasePath), { recursive: true });
  const databaseAlreadyExists = await stat(databasePath).then(() => true, (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (databaseAlreadyExists) {
    const existingDatabase = new CoordinatorDatabase(databasePath);
    try {
      const inventory = existingDatabase.cutoverInventory();
      const conflicting = inventory.importedRuns.filter((run) => run.runId !== runId || run.sourceManifestHash !== sourceManifestHash);
      if (inventory.attemptCount > 0 || conflicting.length > 0) throw new Error("SQLite path contains coordinator mutations without an authoritative marker; recovery is required");
      existingDatabase.importRun(runId, sourceManifestHash, generation.stateRaw, generation.eventsRaw);
      existingDatabase.activateDispatch(sourceManifestHash);
    } finally { existingDatabase.close(); }
    const marker = canonical({
      schemaVersion: 1,
      kind: "sqlite",
      runId,
      databasePath: resolve(databasePath),
      databaseIdentity: sha256(`${resolve(databasePath)}\0${sourceManifestHash}`),
      sourceManifestHash,
      migratedRuns: { [runId]: sourceManifestHash },
      cutoverAt: new Date().toISOString(),
      postCutoverMutation: false,
    });
    const temporaryMarker = `${markerPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryMarker, marker, { encoding: "utf8", flag: "wx" });
    await rename(temporaryMarker, markerPath);
    return { sourceManifestHash, databasePath: resolve(databasePath), markerPath };
  }
  const temporaryDatabase = `${databasePath}.importing-${randomUUID()}`;
  const database = new CoordinatorDatabase(temporaryDatabase);
  try {
    database.importRun(runId, sourceManifestHash, generation.stateRaw, generation.eventsRaw);
    database.activateDispatch(sourceManifestHash);
  } finally { database.close(); }
  await rename(temporaryDatabase, databasePath);
  const marker = canonical({
    schemaVersion: 1,
    kind: "sqlite",
    runId,
    databasePath: resolve(databasePath),
    databaseIdentity: sha256(`${resolve(databasePath)}\0${sourceManifestHash}`),
    sourceManifestHash,
    migratedRuns: { [runId]: sourceManifestHash },
    cutoverAt: new Date().toISOString(),
    postCutoverMutation: false,
  });
  const temporaryMarker = `${markerPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryMarker, marker, { encoding: "utf8", flag: "wx" });
  await rename(temporaryMarker, markerPath);
  return { sourceManifestHash, databasePath: resolve(databasePath), markerPath };
}

async function sourceManifest(root: string): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const entries: Array<{ path: string; sha256: string; size: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.endsWith(".lock") || entry.name.includes(".tmp")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        entries.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: sha256(bytes), size: bytes.byteLength });
      }
    }
  };
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeImmutable(path: string, content: string): Promise<void> {
  try { await writeFile(path, content, { encoding: "utf8", flag: "wx" }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error(`immutable migration artifact differs: ${path}`);
  }
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item)}\n`;
}
