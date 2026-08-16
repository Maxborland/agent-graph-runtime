import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exportRunBundle, verifyRunBundle } from "../src/export-bundle.js";
import { planRetention, executeRetention } from "../src/retention.js";
import { RunStore } from "../src/store.js";
import { CoordinatorDatabase, migrateRunToSqlite } from "../src/sqlite-coordinator.js";
import { acquireRunLock } from "../src/run-lock.js";
import type { GraphDefinition } from "../src/types.js";

async function completedRun(repository: string, runId: string): Promise<RunStore> {
  const graph: GraphDefinition = {
    version: 1, run: { id: runId, objective: "retain", repository, maxConcurrency: 1 },
    nodes: [{ id: "verify", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  const store = await RunStore.open(repository, graph, []);
  store.state.status = "completed";
  store.state.updatedAt = new Date(0).toISOString();
  await store.save("completed-for-retention");
  return store;
}

test("retention is dry-run first and preserves minimal authoritative manifests", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-retention-"));
  const store = await completedRun(repository, "old-run");
  await writeFile(join(store.promptsDirectory, "old.prompt.txt"), "secret prompt\n");
  const plan = await planRetention(repository, { olderThanMs: 1, now: Date.now() });
  assert.ok(plan.removable.some((entry) => entry.path.endsWith("old.prompt.txt")));
  assert.equal(await readFile(join(store.promptsDirectory, "old.prompt.txt"), "utf8"), "secret prompt\n");
  await executeRetention(repository, plan);
  await assert.rejects(() => stat(join(store.promptsDirectory, "old.prompt.txt")), /ENOENT/);
  assert.ok(await readFile(join(store.runDirectory, "CURRENT.json"), "utf8"));
  assert.ok(await readFile(join(store.runDirectory, "retention-manifest.json"), "utf8"));
});

test("unresolved external effects are never retention candidates", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-retention-"));
  const store = await completedRun(repository, "uncertain");
  store.state.status = "needs_attention";
  store.state.nodes.verify!.retryBlocked = true;
  await store.save("uncertain-effect");
  await writeFile(join(store.outputsDirectory, "uncertain.log"), "unknown outcome\n");
  const plan = await planRetention(repository, { olderThanMs: 0, now: Date.now() });
  assert.equal(plan.removable.length, 0);
  assert.ok(plan.protected.some((entry) => entry.reason.includes("unresolved")));
});

test("portable export detects changed, missing, and added bytes", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-export-"));
  await completedRun(repository, "exported");
  const destination = join(await mkdtemp(join(tmpdir(), "agr-bundle-parent-")), "bundle");
  const bundle = await exportRunBundle(repository, "exported", destination);
  assert.equal((await verifyRunBundle(bundle.destination)).valid, true);
  await writeFile(join(bundle.destination, "added.txt"), "not manifested\n");
  const invalid = await verifyRunBundle(bundle.destination);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.added.includes("added.txt"));
});

test("SQLite export includes rejected remote-attempt evidence", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-export-audit-"));
  await completedRun(repository, "audit-run");
  const databasePath = join(repository, ".agent-graph", "coordinator.sqlite");
  await migrateRunToSqlite(repository, "audit-run", databasePath);
  const database = new CoordinatorDatabase(databasePath);
  const worker = database.enrollWorker({ executors: ["codex"], resources: [], maxConcurrency: 1 }, 60_000, 100);
  database.createAttempt({ schemaVersion: 1, attemptId: "rejected-attempt", runId: "audit-run", nodeId: "remote", planRevisionId: "plan", repositorySnapshotHash: "snapshot", requiredCapabilities: ["executor:codex"], externalAction: false });
  const lease = database.acquireLease("rejected-attempt", worker.workerId, worker.token, 10, 100);
  database.completeAttempt({ attemptId: "rejected-attempt", workerId: worker.workerId, workerToken: worker.token, fencingToken: lease.fencingToken, completedAt: 105, resultHash: "late" }, 111);
  database.close();
  const destination = join(await mkdtemp(join(tmpdir(), "agr-bundle-parent-")), "bundle");
  const bundle = await exportRunBundle(repository, "audit-run", destination);
  assert.equal((await verifyRunBundle(bundle.destination)).valid, true);
  const audit = JSON.parse(await readFile(join(bundle.destination, "authoritative", "coordinator-audit.json"), "utf8")) as { rejectedResults: unknown[] };
  assert.equal(audit.rejectedResults.length, 1);
});

test("export refuses an active run instead of mixing cross-time artifacts", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-export-locked-"));
  await completedRun(repository, "locked-export");
  const lock = await acquireRunLock(repository, "locked-export");
  const destination = join(await mkdtemp(join(tmpdir(), "agr-bundle-parent-")), "bundle");
  try {
    await assert.rejects(() => exportRunBundle(repository, "locked-export", destination), /already owned/);
  } finally { await lock.release(); }
});

test("retention reports the real custom SQLite authority path", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-retention-custom-db-"));
  await completedRun(repository, "custom-db");
  const externalDirectory = await mkdtemp(join(tmpdir(), "agr-custom-sqlite-"));
  const databasePath = join(externalDirectory, "authority.sqlite");
  await migrateRunToSqlite(repository, "custom-db", databasePath);
  const plan = await planRetention(repository, { olderThanMs: 0, now: Date.now() });
  assert.ok(plan.protected.some((entry) => entry.path === databasePath && entry.reason.includes("outside repository")));
  assert.ok(!plan.protected.some((entry) => entry.path.endsWith(".agent-graph/coordinator.sqlite")));
});
