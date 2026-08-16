import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlanRegistry } from "../src/adaptive-plan.js";
import type { GraphDefinition } from "../src/types.js";

function graph(): GraphDefinition {
  return {
    version: 1,
    run: { id: "adaptive", objective: "adapt safely", repository: ".", maxConcurrency: 2 },
    nodes: [{
      id: "prepare", type: "agent", executor: "codex", prompt: "prepare", needs: [], owns: [], checks: [], maxAttempts: 1,
      produces: [{ name: "plan", type: "application/json", path: "plan.json" }],
    }],
  };
}

test("plan proposals are immutable and activate only between waves", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-plan-"));
  const registry = await PlanRegistry.open(root, graph(), {
    maxNodes: 3, maxDepth: 3, maxDurationMs: 60 * 60_000, maxProviderCalls: 3, maxCostUsd: 2,
  });
  const proposed = graph();
  proposed.nodes.push({
    id: "review", type: "review", executor: "claude", prompt: "review", needs: ["prepare"], owns: [], checks: [], maxAttempts: 1,
    consumes: [{ name: "plan", type: "application/json", from: "prepare" }],
  });
  const patch = await registry.propose(proposed, { proposer: "coordinator", rationale: "add evidence review" });
  await assert.rejects(() => registry.activate(patch.patchId, { activeAttemptIds: ["attempt-1"] }), /between waves/);
  const active = await registry.activate(patch.patchId, { activeAttemptIds: [] });
  assert.equal(active.graph.nodes.length, 2);
  assert.equal((await registry.active()).revisionId, active.revisionId);
  const raw = await readFile(join(root, "plan-patches", `${patch.patchId}.json`), "utf8");
  await assert.rejects(() => registry.propose(proposed, { proposer: "coordinator", rationale: "add evidence review", patchId: patch.patchId }), /immutable/);
  assert.equal(await readFile(join(root, "plan-patches", `${patch.patchId}.json`), "utf8"), raw);
});

test("patch validation rejects cycles, artifact mismatch, and mandate expansion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-plan-invalid-"));
  const registry = await PlanRegistry.open(root, graph(), {
    maxNodes: 2, maxDepth: 2, maxDurationMs: 60_000, maxProviderCalls: 2, maxCostUsd: 1,
  });
  const proposed = graph();
  proposed.nodes[0]!.needs = ["review"];
  proposed.nodes.push({
    id: "review", type: "review", executor: "claude", prompt: "review", needs: ["prepare"], owns: [], checks: [], maxAttempts: 1,
    consumes: [{ name: "plan", type: "text/plain", from: "prepare" }],
  });
  const patch = await registry.propose(proposed, { proposer: "worker:w1", rationale: "bad expansion" });
  await assert.rejects(() => registry.activate(patch.patchId, { activeAttemptIds: [] }), /cycle|artifact/i);

  const tooLarge = graph();
  tooLarge.nodes.push(...["a", "b"].map((id) => ({
    id, type: "agent" as const, executor: "codex" as const, prompt: id, needs: ["prepare"], owns: [], checks: [], maxAttempts: 1,
  })));
  const largePatch = await registry.propose(tooLarge, { proposer: "coordinator", rationale: "too many nodes" });
  await assert.rejects(() => registry.activate(largePatch.patchId, { activeAttemptIds: [] }), /maxNodes/);
});
