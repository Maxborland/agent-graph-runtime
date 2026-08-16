import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunStore } from "../src/store.js";
import { publishGeneration } from "../src/persistence.js";
import { createInitialState } from "../src/state.js";
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

test("store publishes one coherent versioned generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-generation-"));
  try {
    const store = await RunStore.open(root, graph, []);
    const current = JSON.parse(
      await readFile(join(store.runDirectory, "CURRENT.json"), "utf8"),
    ) as { schemaVersion?: number; generation?: string };
    assert.equal(current.schemaVersion, 1);
    assert.match(current.generation ?? "", /^[a-z0-9-]+$/i);

    const state = JSON.parse(await readFile(store.statePath, "utf8")) as {
      schemaVersion?: number;
      revision?: number;
      lastAppliedEventSeq?: number;
      activePlanRevisionId?: string;
    };
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.revision, 1);
    assert.equal(state.lastAppliedEventSeq, 1);
    assert.match(state.activePlanRevisionId ?? "", /^plan-/);

    const events = (await readFile(store.eventsPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { schemaVersion?: number; seq?: number })
      .map(({ schemaVersion, seq }) => ({ schemaVersion, seq }));
    assert.deepEqual(events, [{ schemaVersion: 2, seq: 1 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store migrates legacy artifacts with an immutable backup and base plan revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-legacy-migration-"));
  const runRoot = join(root, ".agent-graph", "runs", graph.run.id);
  const legacyState = {
    runId: graph.run.id,
    graphHash: (await import("../src/graph-hash.js")).graphHash(graph),
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:01.000Z",
    baselineChangedFiles: [],
    nodes: Object.fromEntries(graph.nodes.map((node) => [
      node.id,
      { status: "pending", attempts: 0, evidenceFiles: [] },
    ])),
  };
  const stateRaw = `${JSON.stringify(legacyState, null, 2)}\n`;
  const eventsRaw = `${JSON.stringify({ at: "2026-08-16T00:00:01.000Z", type: "run_started" })}\n`;
  try {
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "state.json"), stateRaw, "utf8");
    await writeFile(join(runRoot, "events.jsonl"), eventsRaw, "utf8");

    const migrated = await RunStore.open(root, graph, []);

    assert.equal(migrated.state.schemaVersion, 2);
    assert.equal(await readFile(join(runRoot, "backups", "legacy", "state.json"), "utf8"), stateRaw);
    assert.equal(await readFile(join(runRoot, "backups", "legacy", "events.jsonl"), "utf8"), eventsRaw);
    const plan = JSON.parse(
      await readFile(join(runRoot, "plan-revisions", `${migrated.state.activePlanRevisionId}.json`), "utf8"),
    ) as { schemaVersion?: number; revisionId?: string; graphHash?: string };
    assert.deepEqual({
      schemaVersion: plan.schemaVersion,
      revisionId: plan.revisionId,
      graphHash: plan.graphHash,
    }, {
      schemaVersion: 1,
      revisionId: migrated.state.activePlanRevisionId,
      graphHash: migrated.state.graphHash,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects a copied run from a different repository identity", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "agr-store-repo-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "agr-store-repo-b-"));
  try {
    const first = await RunStore.open(firstRoot, graph, []);
    await cp(first.runDirectory, join(secondRoot, ".agent-graph", "runs", graph.run.id), { recursive: true });

    await assert.rejects(
      RunStore.open(secondRoot, graph, []),
      /stored run repository identity does not match/,
    );
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("store recovers a torn current pointer from the latest complete journaled generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-pointer-recovery-"));
  try {
    const store = await RunStore.open(root, graph, []);
    store.state.status = "needs_attention";
    await store.save("second-generation");
    const expectedRevision = store.state.revision;
    await writeFile(join(store.runDirectory, "CURRENT.json"), "{torn", "utf8");

    const recovered = await RunStore.open(root, graph, []);

    assert.equal(recovered.state.revision, expectedRevision);
    assert.equal(recovered.state.status, "needs_attention");
    const pointer = JSON.parse(
      await readFile(join(store.runDirectory, "CURRENT.json"), "utf8"),
    ) as { generation?: string };
    assert.match(pointer.generation ?? "", /^[a-z0-9-]+$/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store fails closed on a versioned projection without a pointer or recovery journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-ambiguous-versioned-"));
  const runRoot = join(root, ".agent-graph", "runs", graph.run.id);
  try {
    await mkdir(runRoot, { recursive: true });
    const versioned = {
      schemaVersion: 2,
      revision: 4,
      lastAppliedEventSeq: 9,
      runId: graph.run.id,
      graphHash: (await import("../src/graph-hash.js")).graphHash(graph),
      activePlanRevisionId: "plan-ambiguous",
      repository: { repositoryId: root, root, baseCommit: "unborn" },
      status: "running",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:01.000Z",
      baselineChangedFiles: [],
      nodes: {},
    };
    await writeFile(join(runRoot, "state.json"), `${JSON.stringify(versioned)}\n`, "utf8");
    await writeFile(join(runRoot, "events.jsonl"), "", "utf8");

    await assert.rejects(
      RunStore.open(root, graph, []),
      /versioned run projection has no authoritative CURRENT\.json or recoverable journal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale stores cannot publish a second mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-stale-revision-"));
  try {
    const first = await RunStore.open(root, graph, []);
    const stale = await RunStore.open(root, graph, []);
    first.state.status = "needs_attention";
    await first.save("first-writer");
    stale.state.status = "completed";

    await assert.rejects(stale.save("stale-writer"), /stale run generation/);
    const current = await RunStore.open(root, graph, []);
    assert.equal(current.state.status, "needs_attention");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent stale stores have exactly one generation winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-concurrent-cas-"));
  try {
    await RunStore.open(root, graph, []);
    const first = await RunStore.open(root, graph, []);
    const second = await RunStore.open(root, graph, []);
    first.state.status = "needs_attention";
    second.state.status = "completed";

    const outcomes = await Promise.allSettled([first.save("first"), second.save("second")]);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects a state cursor ahead of its authoritative event generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-cursor-drift-"));
  const runRoot = join(root, ".agent-graph", "runs", graph.run.id);
  try {
    await mkdir(runRoot, { recursive: true });
    const state = createInitialState(graph, []);
    state.lastAppliedEventSeq = 2;
    await publishGeneration(runRoot, state, []);

    await assert.rejects(
      RunStore.open(root, graph, []),
      /state cursor 2 does not match authoritative event cursor 0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects a partial authority object in versioned state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-store-partial-authority-"));
  const runRoot = join(root, ".agent-graph", "runs", graph.run.id);
  try {
    const state = createInitialState(graph, []);
    const partial = state.authority as Partial<typeof state.authority>;
    delete partial.mandate;
    delete partial.receipts;
    delete partial.reservations;
    delete partial.consumptions;
    delete partial.reconciliations;
    await publishGeneration(runRoot, state, []);

    await assert.rejects(RunStore.open(root, graph, []), /invalid versioned run state/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const legacyRoot = join(root, ".agent-graph", "runs", graph.run.id);
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(
      join(legacyRoot, "events.jsonl"),
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
    const legacyRoot = join(root, ".agent-graph", "runs", graph.run.id);
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(join(legacyRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: "2026-08-16T00:00:00.000Z", type: "run_started" })}\n{broken\n`, "utf8");

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
