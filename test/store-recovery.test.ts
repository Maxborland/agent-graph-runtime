import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../src/store.js";
import type { GraphDefinition } from "../src/types.js";

const graph: GraphDefinition = {
  version: 1,
  run: {
    id: "recovery-fixture",
    objective: "Recover an interrupted run",
    repository: ".",
    maxConcurrency: 1,
  },
  nodes: [
    {
      id: "first",
      type: "agent",
      executor: "codex",
      prompt: "first",
      needs: [],
      owns: ["first/**"],
      checks: [],
      maxAttempts: 1,
    },
    {
      id: "second",
      type: "agent",
      executor: "claude",
      prompt: "second",
      needs: ["first"],
      owns: ["second/**"],
      checks: [],
      maxAttempts: 2,
    },
  ],
};

test("store recovers running nodes without repeating accepted nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-"));
  try {
    const firstOpen = await RunStore.open(root, graph, []);
    firstOpen.state.nodes.first!.status = "accepted";
    firstOpen.state.nodes.second!.status = "running";
    firstOpen.state.nodes.second!.attempts = 1;
    await firstOpen.save("test-snapshot");

    const recovered = await RunStore.open(root, graph, []);
    assert.equal(recovered.state.nodes.first!.status, "accepted");
    assert.equal(recovered.state.nodes.second!.status, "pending");
    assert.equal(recovered.state.nodes.second!.attempts, 1);

    const events = await readFile(recovered.eventsPath, "utf8");
    assert.match(events, /"type":"node_interrupted"/);
    assert.match(events, /"nodeId":"second"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store refuses to resume a run when its graph contract changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-drift-"));
  try {
    const firstOpen = await RunStore.open(root, graph, []);
    await firstOpen.save("initial");
    const changed: GraphDefinition = JSON.parse(JSON.stringify(graph)) as GraphDefinition;
    changed.nodes[0]!.prompt = "a different task contract";

    await assert.rejects(
      RunStore.open(root, changed, []),
      /stored graph does not match the current graph/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
