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

test("store preserves the legacy event format when appending after resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-legacy-resume-"));
  try {
    const firstStore = await RunStore.open(root, graph, []);
    const legacy = [
      { at: "2026-08-16T00:00:00.000Z", type: "run_started" },
      { at: "2026-08-16T00:00:01.000Z", type: "node_started", nodeId: "first" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(firstStore.eventsPath, legacy, "utf8");

    const resumed = await RunStore.open(root, graph, []);
    await resumed.appendEvent({ at: "2026-08-16T00:00:02.000Z", type: "node_accepted", nodeId: "first" });

    const raw = await readFile(resumed.eventsPath, "utf8");
    assert.ok(raw.startsWith(legacy));
    const records = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert(records.every((record) => !Object.hasOwn(record, "seq")));
    assert.deepEqual((await readRunEvents(root, graph.run.id)).map((event) => event.seq), [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store resumes cursor events after the last sequence even when history has gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-sequence-gaps-"));
  try {
    const firstStore = await RunStore.open(root, graph, []);
    const events = [
      { seq: 5, at: "2026-08-16T00:00:00.000Z", type: "run_started" },
      { seq: 10, at: "2026-08-16T00:00:01.000Z", type: "state_saved", detail: "old" },
    ];
    await writeFile(firstStore.eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

    const resumed = await RunStore.open(root, graph, []);
    const appended = await resumed.appendEvent({ at: "2026-08-16T00:00:02.000Z", type: "state_saved", detail: "resume" });

    assert.equal(appended.seq, 11);
    const persisted = (await readFile(resumed.eventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { seq: number });
    assert.equal(persisted.at(-1)?.seq, 11);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store separates a resumed legacy event when the final record has no newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-legacy-no-newline-"));
  try {
    const firstStore = await RunStore.open(root, graph, []);
    const legacy = JSON.stringify({ at: "2026-08-16T00:00:00.000Z", type: "run_started" });
    await writeFile(firstStore.eventsPath, legacy, "utf8");

    const resumed = await RunStore.open(root, graph, []);
    await resumed.appendEvent({ at: "2026-08-16T00:00:01.000Z", type: "node_started", nodeId: "first" });

    const raw = await readFile(resumed.eventsPath, "utf8");
    assert.ok(raw.startsWith(`${legacy}\n`));
    assert.deepEqual((await readRunEvents(root, graph.run.id)).map((event) => event.seq), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store separates a resumed cursor event when the final record has no newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-cursor-no-newline-"));
  try {
    const firstStore = await RunStore.open(root, graph, []);
    const cursorEvent = JSON.stringify({ seq: 7, at: "2026-08-16T00:00:00.000Z", type: "run_started" });
    await writeFile(firstStore.eventsPath, cursorEvent, "utf8");

    const resumed = await RunStore.open(root, graph, []);
    const appended = await resumed.appendEvent({ at: "2026-08-16T00:00:01.000Z", type: "state_saved", detail: "resume" });

    assert.equal(appended.seq, 8);
    const raw = await readFile(resumed.eventsPath, "utf8");
    assert.ok(raw.startsWith(`${cursorEvent}\n`));
    assert.deepEqual((await readRunEvents(root, graph.run.id)).map((event) => event.seq), [7, 8]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store refuses malformed or mixed event logs without changing their bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-invalid-resume-"));
  try {
    const firstStore = await RunStore.open(root, graph, []);
    const invalidLogs = [
      `${JSON.stringify({ at: "2026-08-16T00:00:00.000Z", type: "run_started" })}\n{broken\n`,
      [
        { at: "2026-08-16T00:00:00.000Z", type: "run_started" },
        { seq: 2, at: "2026-08-16T00:00:01.000Z", type: "state_saved" },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    ];
    for (const invalid of invalidLogs) {
      await writeFile(firstStore.eventsPath, invalid, "utf8");
      await assert.rejects(
        RunStore.open(root, graph, []),
        (error: unknown) => (error as { code?: string }).code === "EVENT_LOG_INVALID",
      );
      assert.equal(await readFile(firstStore.eventsPath, "utf8"), invalid);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct store open rejects unsafe run and node IDs before creating artifact paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-unsafe-id-"));
  const unsafeRun: GraphDefinition = JSON.parse(JSON.stringify(graph)) as GraphDefinition;
  unsafeRun.run.id = "../escaped";
  const unsafeNode: GraphDefinition = JSON.parse(JSON.stringify(graph)) as GraphDefinition;
  unsafeNode.nodes[0]!.id = "nested/node";
  try {
    for (const candidate of [unsafeRun, unsafeNode]) {
      await assert.rejects(
        RunStore.open(root, candidate, []),
        (error: unknown) => (error as { code?: string }).code === "INVALID_ARTIFACT_ID",
      );
      await assert.rejects(readFile(join(root, ".agent-graph"), "utf8"), { code: "ENOENT" });
    }
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
