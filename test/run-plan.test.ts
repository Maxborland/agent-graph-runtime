import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { PlanRegistry } from "../src/adaptive-plan.js";
import { GraphRunner } from "../src/runner.js";
import { RunStore } from "../src/store.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("runner automatically activates only a reversible in-mandate patch between waves", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-run-plan-"));
  await exec("git", ["init"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repository });
  const base: GraphDefinition = {
    version: 1,
    run: {
      id: "adaptive-run", objective: "adapt", repository, maxConcurrency: 1,
      budgets: { maxNodes: 2, maxDepth: 2, maxDurationMs: 60_000, maxProviderCalls: 1 },
      automaticPolicy: { allowReversiblePatches: true },
    },
    nodes: [{ id: "first", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1, timeoutMs: 10_000 }],
  };
  const store = await RunStore.open(repository, base, []);
  const registry = await PlanRegistry.open(store.runDirectory, base, base.run.budgets!);
  const expanded = structuredClone(base);
  expanded.nodes.push({ id: "second", type: "verify", needs: ["first"], owns: [], checks: [], maxAttempts: 1, timeoutMs: 10_000 });
  await registry.propose(expanded, { proposer: "worker:planner", rationale: "add final verification", reversible: true });
  const result = await new GraphRunner(base, repository, {}).run();
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.second?.status, "accepted");
  assert.notEqual(result.activePlanRevisionId, `plan-${result.graphHash.slice(0, 24)}`, "state uses the activated immutable revision identity");
  assert.ok(result.authority.policyDecisions.some((decision) => decision.actionNodeId.startsWith("patch:")));
  assert.ok(result.git?.resultId, "adaptive runs are isolated before a worker-proposed revision can write");
});

test("automatic patch cannot smuggle trusted shell checks", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-run-plan-check-"));
  await exec("git", ["init"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repository });
  const base: GraphDefinition = {
    version: 1,
    run: {
      id: "adaptive-check", objective: "adapt", repository, maxConcurrency: 1,
      budgets: { maxNodes: 2, maxDepth: 2, maxDurationMs: 60_000, maxProviderCalls: 1 },
      automaticPolicy: { allowReversiblePatches: true },
    },
    nodes: [{ id: "first", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  const store = await RunStore.open(repository, base, []);
  const registry = await PlanRegistry.open(store.runDirectory, base, base.run.budgets!);
  const expanded = structuredClone(base);
  expanded.nodes.push({ id: "unsafe", type: "verify", needs: ["first"], owns: ["owned.txt"], checks: ["node -e \"require('node:fs').writeFileSync('owned.txt','unsafe')\""], maxAttempts: 1 });
  await registry.propose(expanded, { proposer: "worker:planner", rationale: "claim reversible", reversible: true });
  await assert.rejects(() => new GraphRunner(base, repository, {}).run(), /trusted checks/);
  await assert.rejects(() => readFile(join(repository, "owned.txt")), /ENOENT/);
});
