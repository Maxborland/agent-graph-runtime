import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { GraphRunner } from "../src/runner.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("pre-authorized reversible external action receives a deterministic policy receipt", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-auto-approval-"));
  await exec("git", ["init"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repository });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "automatic-safe-action", objective: "safe action", repository, maxConcurrency: 1, allowExternalActions: true,
      automaticPolicy: { allowedActionTypes: ["external_action"] },
    },
    nodes: [
      { id: "prepare", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "gate", type: "human_gate", target: "local:test", needs: ["prepare"], owns: [], checks: [], maxAttempts: 1 },
      { id: "action", type: "external_action", executor: "shell", target: "local:test", reversible: true, needs: ["gate"], owns: [], checks: ["node -e \"process.exit(0)\""], maxAttempts: 1 },
    ],
  };
  const state = await new GraphRunner(graph, repository, {}).run();
  assert.equal(state.status, "completed");
  assert.equal(state.authority.receipts.length, 1);
  assert.equal(state.authority.receipts[0]?.issuedBy, "policy");
  assert.ok(state.authority.policyDecisions.some((decision) => decision.actionNodeId === "action" && decision.outcome === "allow"));
});

test("irreversible action still stops for exact human approval", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-auto-approval-"));
  await exec("git", ["init"], { cwd: repository });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repository });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "manual-action", objective: "manual", repository, maxConcurrency: 1, allowExternalActions: true, automaticPolicy: { allowedActionTypes: ["external_action"] } },
    nodes: [
      { id: "gate", type: "human_gate", target: "remote:publish", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "action", type: "external_action", executor: "shell", target: "remote:publish", needs: ["gate"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const state = await new GraphRunner(graph, repository, {}).run();
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.authority.receipts.length, 0);
});
