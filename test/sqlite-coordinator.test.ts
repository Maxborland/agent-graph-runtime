import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoordinatorDatabase, migrateRunToSqlite } from "../src/sqlite-coordinator.js";
import { RunStore } from "../src/store.js";
import { readCurrentGeneration } from "../src/persistence.js";
import { readRunStateArtifact } from "../src/observation.js";
import type { GraphDefinition } from "../src/types.js";

test("SQLite leases use durable fencing and CAS completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-sqlite-"));
  const database = new CoordinatorDatabase(join(root, "coordinator.sqlite"));
  assert.equal(database.journalMode(), "wal");
  const first = database.enrollWorker({ executors: ["codex"], resources: ["gpu"], maxConcurrency: 1 }, 60_000);
  const second = database.enrollWorker({ executors: ["codex"], resources: ["gpu"], maxConcurrency: 1 }, 60_000);
  database.createAttempt({
    schemaVersion: 1, attemptId: "attempt-1", runId: "run-1", nodeId: "build", planRevisionId: "plan-1",
    repositorySnapshotHash: "snapshot", requiredCapabilities: ["executor:codex", "resource:gpu"], externalAction: false,
  });
  assert.throws(() => database.acquireLease("attempt-1", first.workerId, first.token, 10, 100), /cutover/);
  database.activateDispatch("manifest-1");
  const oldLease = database.acquireLease("attempt-1", first.workerId, first.token, 10, 100);
  const currentLease = database.acquireLease("attempt-1", second.workerId, second.token, 10, 111);
  assert.ok(currentLease.fencingToken > oldLease.fencingToken);
  assert.equal(database.completeAttempt({ attemptId: "attempt-1", workerId: first.workerId, workerToken: first.token, fencingToken: oldLease.fencingToken, completedAt: 105, resultHash: "late" }, 112).accepted, false);
  assert.equal(database.completeAttempt({ attemptId: "attempt-1", workerId: second.workerId, workerToken: second.token, fencingToken: currentLease.fencingToken, completedAt: 112, resultHash: "current" }, 112).accepted, true);
  assert.equal(database.completeAttempt({ attemptId: "attempt-1", workerId: second.workerId, workerToken: second.token, fencingToken: currentLease.fencingToken, completedAt: 113, resultHash: "duplicate" }, 113).accepted, false);
  assert.equal(database.rejectedResults("attempt-1").length, 2);
  database.close();
});

test("workers cannot receive external actions or unsupported capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-sqlite-"));
  const database = new CoordinatorDatabase(join(root, "coordinator.sqlite"));
  const worker = database.enrollWorker({ executors: ["claude"], resources: [], maxConcurrency: 1 }, 60_000);
  database.activateDispatch("manifest");
  assert.throws(() => database.createAttempt({
    schemaVersion: 1, attemptId: "external", runId: "r", nodeId: "publish", planRevisionId: "p", repositorySnapshotHash: "s", requiredCapabilities: [], externalAction: true,
  }), /external actions/);
  database.createAttempt({
    schemaVersion: 1, attemptId: "codex", runId: "r", nodeId: "build", planRevisionId: "p", repositorySnapshotHash: "s", requiredCapabilities: ["executor:codex"], externalAction: false,
  });
  assert.throws(() => database.acquireLease("codex", worker.workerId, worker.token, 1000), /capability/);
  database.close();
});

test("filesystem cutover is backed up, idempotent, and publishes one authoritative marker", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-migrate-"));
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "migrate", objective: "migrate", repository, maxConcurrency: 1 },
    nodes: [{ id: "verify", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  await RunStore.open(repository, graph, []);
  const databasePath = join(repository, ".agent-graph", "coordinator.sqlite");
  const first = await migrateRunToSqlite(repository, "migrate", databasePath);
  const second = await migrateRunToSqlite(repository, "migrate", databasePath);
  assert.equal(second.sourceManifestHash, first.sourceManifestHash);
  const marker = JSON.parse(await readFile(join(repository, ".agent-graph", "AUTHORITATIVE_STORE.json"), "utf8")) as { kind: string; sourceManifestHash: string };
  assert.equal(marker.kind, "sqlite");
  assert.equal(marker.sourceManifestHash, first.sourceManifestHash);
  const database = new CoordinatorDatabase(databasePath);
  assert.equal(database.importedRun("migrate")?.sourceManifestHash, first.sourceManifestHash);
  database.close();
  const filesystemBefore = await readCurrentGeneration(join(repository, ".agent-graph", "runs", "migrate"));
  const reopened = await RunStore.open(repository, graph, []);
  reopened.state.status = "needs_attention";
  await reopened.save("sqlite-authoritative-mutation");
  const filesystemAfter = await readCurrentGeneration(join(repository, ".agent-graph", "runs", "migrate"));
  assert.equal(filesystemAfter?.pointer.generation, filesystemBefore?.pointer.generation, "filesystem generation is frozen after cutover");
  assert.equal((await readRunStateArtifact(repository, "migrate")).status, "needs_attention");
});

test("concurrent migrations publish every run under one repository-wide authority marker", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-migrate-concurrent-"));
  const makeGraph = (id: string): GraphDefinition => ({
    version: 1,
    run: { id, objective: id, repository, maxConcurrency: 1 },
    nodes: [{ id: "verify", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  });
  await RunStore.open(repository, makeGraph("run-one"), []);
  await RunStore.open(repository, makeGraph("run-two"), []);
  const databasePath = join(repository, ".agent-graph", "coordinator.sqlite");
  await Promise.all([
    migrateRunToSqlite(repository, "run-one", databasePath),
    migrateRunToSqlite(repository, "run-two", databasePath),
  ]);
  const marker = JSON.parse(await readFile(join(repository, ".agent-graph", "AUTHORITATIVE_STORE.json"), "utf8")) as { migratedRuns: Record<string, string> };
  assert.deepEqual(Object.keys(marker.migratedRuns).sort(), ["run-one", "run-two"]);
  const database = new CoordinatorDatabase(databasePath);
  assert.ok(database.importedRun("run-one"));
  assert.ok(database.importedRun("run-two"));
  database.close();
});
