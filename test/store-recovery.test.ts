import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../src/store.js";
import { readRunEvents } from "../src/cli-tools.js";
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

test("store persists monotonically increasing event cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-events-"));
  try {
    const store = await RunStore.open(root, graph, []);
    await store.appendEvent({ at: new Date().toISOString(), type: "node_started", nodeId: "first" });
    await store.appendEvent({ at: new Date().toISOString(), type: "node_accepted", nodeId: "first" });

    const events = (await readFile(store.eventsPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { seq?: number });
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event reader assigns line-order cursors to legacy logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-legacy-events-"));
  try {
    const store = await RunStore.open(root, graph, []);
    await writeFile(
      store.eventsPath,
      `${JSON.stringify({ at: "2026-08-16T00:00:00.000Z", type: "run_started" })}\n${JSON.stringify({ at: "2026-08-16T00:00:01.000Z", type: "node_started", nodeId: "first" })}\n`,
      "utf8",
    );

    const events = await readRunEvents(root, graph.run.id);
    assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event reader reports a malformed historical line as an artifact error", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-invalid-events-"));
  try {
    const store = await RunStore.open(root, graph, []);
    await writeFile(store.eventsPath, `${JSON.stringify({ seq: 1, at: "2026-08-16T00:00:00.000Z", type: "run_started" })}\n{broken\n`, "utf8");

    await assert.rejects(
      readRunEvents(root, graph.run.id),
      (error: unknown) => {
        const candidate = error as { code?: string; message?: string };
        assert.equal(candidate.code, "EVENT_LOG_INVALID");
        assert.match(candidate.message ?? "", /events\.jsonl line 2/);
        return true;
      },
    );
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

test("store retry-blocks an external action left running by a hard interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-external-recovery-"));
  const externalGraph: GraphDefinition = {
    version: 1,
    run: {
      id: "external-recovery-fixture",
      objective: "Do not duplicate an uncertain external effect",
      repository: ".",
      maxConcurrency: 1,
      allowExternalActions: true,
    },
    nodes: [{
      id: "publish",
      type: "external_action",
      executor: "shell",
      target: "publish:fixture",
      needs: [],
      owns: [],
      checks: ["echo publish"],
      maxAttempts: 2,
    }],
  };
  try {
    const firstOpen = await RunStore.open(root, externalGraph, []);
    firstOpen.state.nodes.publish!.status = "running";
    firstOpen.state.nodes.publish!.attempts = 1;
    await firstOpen.save("external-action-started");

    const recovered = await RunStore.open(root, externalGraph, []);
    assert.equal(recovered.state.nodes.publish!.status, "failed");
    assert.equal(recovered.state.nodes.publish!.attempts, 1);
    assert.equal(recovered.state.nodes.publish!.retryBlocked, true);
    assert.match(recovered.state.nodes.publish!.lastError ?? "", /inspect partial effects/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
