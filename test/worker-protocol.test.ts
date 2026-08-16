import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startWorkerServer, dispatchToWorker, verifyWorkerResult } from "../src/worker-protocol.js";
import { repositorySnapshotHash } from "../src/repository-snapshot.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function initializeRepository(root: string): Promise<string> {
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: root });
  return repositorySnapshotHash(root);
}

test("worker RPC is capability-scoped and exposes no coordinator authority", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agr-worker-"));
  const snapshot = await initializeRepository(workspace);
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" })).stdout.trim();
  const worker = await startWorkerServer({
    host: "127.0.0.1",
    coordinatorToken: "coordinator-secret",
    workerId: "worker-1",
    capabilities: { executors: ["codex"], resources: ["gpu"], maxConcurrency: 1 },
    workspace,
    execute: async (request: { payload: { prompt: string } }, attemptWorkspace: string) => {
      await writeFile(join(attemptWorkspace, "result.txt"), request.payload.prompt);
      return { status: "complete", summary: "done", changedFiles: ["result.txt"], artifacts: [] };
    },
  });
  t.after(() => worker.close());
  assert.equal((await fetch(`${worker.origin}/v1/state`, { headers: { authorization: "Bearer coordinator-secret" } })).status, 404);
  assert.equal((await fetch(`${worker.origin}/v1/health`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  const result = await dispatchToWorker(worker.origin, "coordinator-secret", {
    envelope: { schemaVersion: 1, attemptId: "a1", runId: "r1", nodeId: "build", planRevisionId: "p1", repositorySnapshotHash: snapshot, requiredCapabilities: ["executor:codex", "resource:gpu"], externalAction: false },
    lease: { leaseId: "l1", attemptId: "a1", workerId: "worker-1", fencingToken: 7, expiresAt: Date.now() + 60_000 },
    payload: { executor: "codex", prompt: "local provider owns credentials", repositorySnapshot: { commit } },
  });
  verifyWorkerResult(result, { attemptId: "a1", workerId: "worker-1", fencingToken: 7 });
  assert.equal(result.patch.files[0]?.path, "result.txt");
  const tampered = structuredClone(result);
  tampered.patch.files[0]!.sha256 = "0".repeat(64);
  assert.throws(() => verifyWorkerResult(tampered, { attemptId: "a1", workerId: "worker-1", fencingToken: 7 }), /hash/);
});

test("worker refuses external actions and unsupported capabilities", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agr-worker-"));
  const snapshot = await initializeRepository(workspace);
  const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" })).stdout.trim();
  const worker = await startWorkerServer({
    coordinatorToken: "secret", workerId: "w", capabilities: { executors: ["claude"], resources: [], maxConcurrency: 1 },
    workspace,
    execute: async () => ({ status: "complete", summary: "done", changedFiles: [], artifacts: [] }),
  });
  t.after(() => worker.close());
  const base = { schemaVersion: 1 as const, attemptId: "a", runId: "r", nodeId: "n", planRevisionId: "p", repositorySnapshotHash: snapshot };
  await assert.rejects(() => dispatchToWorker(worker.origin, "secret", {
    envelope: { ...base, requiredCapabilities: [], externalAction: true },
    lease: { leaseId: "l", attemptId: "a", workerId: "w", fencingToken: 1, expiresAt: Date.now() + 1000 },
    payload: { executor: "claude", prompt: "publish", repositorySnapshot: { commit } },
  }), /external action/);
  await assert.rejects(() => dispatchToWorker(worker.origin, "secret", {
    envelope: { ...base, requiredCapabilities: ["executor:codex"], externalAction: false },
    lease: { leaseId: "l", attemptId: "a", workerId: "w", fencingToken: 2, expiresAt: Date.now() + 1000 },
    payload: { executor: "codex", prompt: "build", repositorySnapshot: { commit } },
  }), /capability/);
});
