import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DistributedCoordinator } from "../src/distributed-coordinator.js";
import { coordinatorSnapshotHash } from "../src/distributed-coordinator.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CoordinatorDatabase } from "../src/sqlite-coordinator.js";
import { startWorkerServer } from "../src/worker-protocol.js";
import type { GraphNodeDefinition } from "../src/types.js";
import type { GraphDefinition } from "../src/types.js";
import { GraphRunner } from "../src/runner.js";

test("two isolated environments recover a coordinator crash during result acceptance", async (t) => {
  const coordinatorRoot = await mkdtemp(join(tmpdir(), "agr-coordinator-env-"));
  const workerParent = await mkdtemp(join(tmpdir(), "agr-worker-env-"));
  const exec = promisify(execFile);
  await exec("git", ["init", "--quiet"], { cwd: coordinatorRoot });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: coordinatorRoot });
  await exec("git", ["config", "user.name", "Test"], { cwd: coordinatorRoot });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: coordinatorRoot });
  const workerRoot = join(workerParent, "checkout");
  await exec("git", ["clone", "--quiet", coordinatorRoot, workerRoot]);
  const databasePath = join(coordinatorRoot, ".agent-graph", "coordinator.sqlite");
  const database = new CoordinatorDatabase(databasePath);
  database.activateDispatch("verified-cutover");
  const enrollment = database.enrollWorker({ executors: ["codex"], resources: [], maxConcurrency: 1 }, 60_000);
  const coordinatorToken = "coordinator-auth-token";
  const worker = await startWorkerServer({
    coordinatorToken, workerId: enrollment.workerId,
    capabilities: { executors: ["codex"], resources: [], maxConcurrency: 1 },
    workspace: workerRoot,
    execute: async (_request, attemptWorkspace) => {
      await writeFile(join(attemptWorkspace, "owned.txt"), "from isolated worker\n");
      return { status: "complete", summary: "done", changedFiles: ["owned.txt"], artifacts: [] };
    },
  });
  t.after(async () => { await worker.close(); database.close(); });
  const connection = new Map([[enrollment.workerId, {
    workerId: enrollment.workerId, endpoint: worker.origin, coordinatorToken, workerToken: enrollment.token,
  }]]);
  const node: GraphNodeDefinition = { id: "build", type: "agent", executor: "codex", prompt: "build", needs: [], owns: ["owned.txt"], checks: [], maxAttempts: 1 };
  const coordinator = new DistributedCoordinator(database, connection);
  const snapshotHash = await coordinatorSnapshotHash(coordinatorRoot);
  await assert.rejects(() => coordinator.dispatchAndAccept({
    node,
    envelope: { schemaVersion: 1, attemptId: "attempt-distributed", runId: "run", nodeId: "build", planRevisionId: "plan", repositorySnapshotHash: snapshotHash, requiredCapabilities: ["executor:codex"], externalAction: false },
    workerId: enrollment.workerId, worktree: coordinatorRoot, payload: { executor: "codex", prompt: "build" }, leaseTtlMs: 60_000,
    afterIntentStaged: () => { throw new Error("simulated coordinator crash"); },
  }), /simulated coordinator crash/);
  assert.equal(database.pendingAcceptanceIntents().length, 1);
  const restarted = new DistributedCoordinator(database, connection);
  assert.deepEqual(await restarted.reconcilePending(() => ({ node, worktree: coordinatorRoot, repositorySnapshotHash: snapshotHash })), ["attempt-distributed"]);
  assert.equal(await readFile(join(coordinatorRoot, "owned.txt"), "utf8"), "from isolated worker\n");
  assert.equal(database.pendingAcceptanceIntents().length, 0);
});

test("coordinator reconciles a crash after CAS but before applying the worker patch", async (t) => {
  const coordinatorRoot = await mkdtemp(join(tmpdir(), "agr-coordinator-after-cas-"));
  const workerParent = await mkdtemp(join(tmpdir(), "agr-worker-after-cas-"));
  const exec = promisify(execFile);
  await exec("git", ["init", "--quiet"], { cwd: coordinatorRoot });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: coordinatorRoot });
  await exec("git", ["config", "user.name", "Test"], { cwd: coordinatorRoot });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: coordinatorRoot });
  const workerRoot = join(workerParent, "checkout");
  await exec("git", ["clone", "--quiet", coordinatorRoot, workerRoot]);
  const database = new CoordinatorDatabase(join(coordinatorRoot, ".agent-graph", "coordinator.sqlite"));
  database.activateDispatch("verified-cutover");
  const enrollment = database.enrollWorker({ executors: ["codex"], resources: [], maxConcurrency: 1 }, 60_000);
  const coordinatorToken = "coordinator-after-cas";
  const worker = await startWorkerServer({
    coordinatorToken, workerId: enrollment.workerId,
    capabilities: { executors: ["codex"], resources: [], maxConcurrency: 1 }, workspace: workerRoot,
    execute: async (_request, attemptWorkspace) => {
      await writeFile(join(attemptWorkspace, "owned.txt"), "applied after restart\n");
      return { status: "complete", summary: "done", changedFiles: ["owned.txt"], artifacts: [] };
    },
  });
  t.after(async () => { await worker.close(); database.close(); });
  const connection = new Map([[enrollment.workerId, { workerId: enrollment.workerId, endpoint: worker.origin, coordinatorToken, workerToken: enrollment.token }]]);
  const node: GraphNodeDefinition = { id: "build", type: "agent", executor: "codex", prompt: "build", needs: [], owns: ["owned.txt"], checks: [], maxAttempts: 1 };
  const snapshotHash = await coordinatorSnapshotHash(coordinatorRoot);
  const coordinator = new DistributedCoordinator(database, connection);
  await assert.rejects(() => coordinator.dispatchAndAccept({
    node,
    envelope: { schemaVersion: 1, attemptId: "after-cas", runId: "run", nodeId: "build", planRevisionId: "plan", repositorySnapshotHash: snapshotHash, requiredCapabilities: ["executor:codex"], externalAction: false },
    workerId: enrollment.workerId, worktree: coordinatorRoot, payload: { executor: "codex", prompt: "build" }, leaseTtlMs: 60_000,
    afterCompletionAccepted: () => { throw new Error("crash after CAS"); },
  }), /crash after CAS/);
  await assert.rejects(() => readFile(join(coordinatorRoot, "owned.txt")), /ENOENT/);
  const restarted = new DistributedCoordinator(database, connection);
  assert.deepEqual(await restarted.reconcilePending(() => ({ node, worktree: coordinatorRoot, repositorySnapshotHash: snapshotHash })), ["after-cas"]);
  assert.equal(await readFile(join(coordinatorRoot, "owned.txt"), "utf8"), "applied after restart\n");
});

test("post-CAS coordinator drift is never overwritten and leaves reconciliation pending", async (t) => {
  const coordinatorRoot = await mkdtemp(join(tmpdir(), "agr-coordinator-drift-"));
  const workerParent = await mkdtemp(join(tmpdir(), "agr-worker-drift-"));
  const exec = promisify(execFile);
  await exec("git", ["init", "--quiet"], { cwd: coordinatorRoot });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: coordinatorRoot });
  await exec("git", ["config", "user.name", "Test"], { cwd: coordinatorRoot });
  await writeFile(join(coordinatorRoot, "owned.txt"), "base\n");
  await exec("git", ["add", "owned.txt"], { cwd: coordinatorRoot });
  await exec("git", ["commit", "-m", "base"], { cwd: coordinatorRoot });
  const workerRoot = join(workerParent, "checkout");
  await exec("git", ["clone", "--quiet", coordinatorRoot, workerRoot]);
  const database = new CoordinatorDatabase(join(coordinatorRoot, ".agent-graph", "coordinator.sqlite"));
  database.activateDispatch("verified-cutover");
  const enrollment = database.enrollWorker({ executors: ["codex"], resources: [], maxConcurrency: 1 }, 60_000);
  const coordinatorToken = "coordinator-drift-token";
  const worker = await startWorkerServer({
    coordinatorToken, workerId: enrollment.workerId,
    capabilities: { executors: ["codex"], resources: [], maxConcurrency: 1 }, workspace: workerRoot,
    execute: async (_request, attemptWorkspace) => {
      await writeFile(join(attemptWorkspace, "owned.txt"), "worker\n");
      return { status: "complete", summary: "done", changedFiles: ["owned.txt"], artifacts: [] };
    },
  });
  t.after(async () => { await worker.close(); database.close(); });
  const connections = new Map([[enrollment.workerId, { workerId: enrollment.workerId, endpoint: worker.origin, coordinatorToken, workerToken: enrollment.token }]]);
  const node: GraphNodeDefinition = { id: "build", type: "agent", executor: "codex", prompt: "build", needs: [], owns: ["owned.txt"], checks: [], maxAttempts: 1 };
  const snapshotHash = await coordinatorSnapshotHash(coordinatorRoot);
  await assert.rejects(() => new DistributedCoordinator(database, connections).dispatchAndAccept({
    node,
    envelope: { schemaVersion: 1, attemptId: "drifted", runId: "run", nodeId: "build", planRevisionId: "plan", repositorySnapshotHash: snapshotHash, requiredCapabilities: ["executor:codex"], externalAction: false },
    workerId: enrollment.workerId, worktree: coordinatorRoot, payload: { executor: "codex", prompt: "build" }, leaseTtlMs: 60_000,
    afterCompletionAccepted: () => { writeFileSync(join(coordinatorRoot, "owned.txt"), "local\n"); },
  }), /drifted after acceptance/);
  assert.equal(await readFile(join(coordinatorRoot, "owned.txt"), "utf8"), "local\n");
  assert.equal(database.pendingAcceptanceIntents().length, 1);
});

test("GraphRunner transfers successive immutable snapshots to a remote worker", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "agr-remote-runner-"));
  const workerParent = await mkdtemp(join(tmpdir(), "agr-remote-worker-"));
  const exec = promisify(execFile);
  await exec("git", ["init", "--quiet"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repository });
  const workerRoot = join(workerParent, "checkout");
  await exec("git", ["clone", "--quiet", repository, workerRoot]);
  const database = new CoordinatorDatabase(join(repository, ".agent-graph", "coordinator.sqlite"));
  database.activateDispatch("verified-cutover");
  const enrollment = database.enrollWorker({ executors: ["codex"], resources: [], maxConcurrency: 1 }, 60_000);
  const coordinatorToken = "remote-runner-token";
  const worker = await startWorkerServer({
    coordinatorToken,
    workerId: enrollment.workerId,
    capabilities: { executors: ["codex"], resources: [], maxConcurrency: 1 },
    workspace: workerRoot,
    execute: async (request, attemptWorkspace) => {
      const path = request.envelope.nodeId === "build" ? "owned.txt" : "reviewed.txt";
      await writeFile(join(attemptWorkspace, path), `${request.envelope.nodeId} remote accepted\n`);
      return { status: "complete", summary: "remote complete", changedFiles: [path], artifacts: [] };
    },
  });
  t.after(async () => { await worker.close(); database.close(); });
  const remoteCoordinator = new DistributedCoordinator(database, new Map([[enrollment.workerId, {
    workerId: enrollment.workerId, endpoint: worker.origin, coordinatorToken, workerToken: enrollment.token,
  }]]));
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "remote-run", objective: "remote execution", repository, maxConcurrency: 1 },
    nodes: [
      { id: "build", type: "agent", executor: "codex", placement: "remote", prompt: "build", needs: [], owns: ["owned.txt"], checks: [], maxAttempts: 1 },
      { id: "review", type: "agent", executor: "codex", placement: "remote", prompt: "review", needs: ["build"], owns: ["reviewed.txt"], checks: [], maxAttempts: 1 },
    ],
  };
  const result = await new GraphRunner(graph, repository, {}, { remoteCoordinator }).run();
  assert.equal(result.status, "completed");
  assert.ok(result.git?.resultCommit);
  assert.equal((await exec("git", ["show", `${result.git!.resultCommit}:owned.txt`], { cwd: repository })).stdout, "build remote accepted\n");
  assert.equal((await exec("git", ["show", `${result.git!.resultCommit}:reviewed.txt`], { cwd: repository })).stdout, "review remote accepted\n");
});

test("agr run reaches an enrolled remote worker from a workers config", async (t) => {
  const repository = await mkdtemp(join(tmpdir(), "agr-remote-cli-"));
  const workerParent = await mkdtemp(join(tmpdir(), "agr-remote-cli-worker-"));
  const exec = promisify(execFile);
  await exec("git", ["init", "--quiet"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repository });
  const workerRoot = join(workerParent, "checkout");
  await exec("git", ["clone", "--quiet", repository, workerRoot]);
  const agentGraph = join(repository, ".agent-graph");
  await mkdir(agentGraph, { recursive: true });
  const databasePath = join(agentGraph, "coordinator.sqlite");
  const database = new CoordinatorDatabase(databasePath);
  const enrollment = database.enrollWorker({ executors: ["codex"], resources: [], maxConcurrency: 1 }, 60_000);
  database.close();
  const coordinatorToken = "remote-cli-token";
  const worker = await startWorkerServer({
    coordinatorToken,
    workerId: enrollment.workerId,
    capabilities: { executors: ["codex"], resources: [], maxConcurrency: 1 },
    workspace: workerRoot,
    execute: async (_request, attemptWorkspace) => {
      await writeFile(join(attemptWorkspace, "owned.txt"), "remote cli accepted\n");
      return { status: "complete", summary: "remote CLI complete", changedFiles: ["owned.txt"], artifacts: [] };
    },
  });
  t.after(() => worker.close());
  const graphPath = join(agentGraph, "graph.json");
  await writeFile(graphPath, `${JSON.stringify({
    version: 1,
    run: { id: "remote-cli", objective: "remote CLI", repository, maxConcurrency: 1 },
    nodes: [{ id: "build", type: "agent", executor: "codex", placement: "remote", prompt: "build", needs: [], owns: ["owned.txt"], checks: [], maxAttempts: 1 }],
  }, null, 2)}\n`);
  const configPath = join(agentGraph, "workers.json");
  await writeFile(configPath, `${JSON.stringify({ databasePath: "coordinator.sqlite", workers: [{
    workerId: enrollment.workerId, endpoint: worker.origin, coordinatorToken, workerToken: enrollment.token,
  }] }, null, 2)}\n`);
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const { stdout } = await exec(process.execPath, [cliPath, "run", graphPath, "--workers", configPath, "--json"], { cwd: repository, encoding: "utf8" });
  const state = JSON.parse(stdout) as { status: string; git?: { resultCommit?: string } };
  assert.equal(state.status, "completed");
  assert.ok(state.git?.resultCommit);
});
