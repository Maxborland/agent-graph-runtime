import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRunEventLog, RunObserver } from "../src/observation.js";
import type { RunState } from "../src/types.js";

const versionedState = {
  schemaVersion: 2 as const,
  revision: 1,
  lastAppliedEventSeq: 0,
  activePlanRevisionId: "plan-fixture",
  repository: { repositoryId: "fixture", root: ".", baseCommit: "fixture" },
  attempts: {},
  authority: {
    schemaVersion: 1 as const,
    mandate: {
      schemaVersion: 1 as const,
      mandateId: "mandate-fixture",
      issuedBy: "human" as const,
      planRevisionId: "plan-fixture",
      allowedActions: [],
      allowedTargets: [],
      maxNodes: 0,
      maxDepth: 0,
      maxDurationMs: 0,
      policyHash: "fixture",
      issuedAt: "2026-08-16T00:00:00.000Z",
    },
    policyDecisions: [],
    receipts: [],
    reservations: [],
    consumptions: [],
    reconciliations: [],
  },
};

test("observation reads one bounded state and event snapshot after a cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-snapshot-"));
  const runRoot = join(root, ".agent-graph", "runs", "observed");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    ...versionedState,
    runId: "observed",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:02.000Z",
    baselineChangedFiles: [],
    nodes: {
      active: { status: "running", attempts: 1, generation: 0, generationAttempts: 1, evidenceFiles: [] },
      pending: { status: "pending", attempts: 0, generation: 0, generationAttempts: 0, evidenceFiles: [] },
    },
  };
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(
    join(runRoot, "events.jsonl"),
    [
      { seq: 1, at: "2026-08-16T00:00:00.000Z", type: "run_started" },
      { seq: 2, at: "2026-08-16T00:00:01.000Z", type: "node_started", nodeId: "active", detail: "attempt 1" },
      { seq: 3, at: "2026-08-16T00:00:02.000Z", type: "node_progress", nodeId: "active", phase: "verify", detail: "half", percent: 50 },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  try {
    const observer = new RunObserver(root, "observed");
    const snapshot = await observer.read(1, 1);
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.cursor, 2);
    assert.deepEqual(snapshot.events.map((event) => event.seq), [2]);
    assert.deepEqual(snapshot.activeNodes, [{ id: "active", attempts: 1 }]);
    const inspection = await observer.inspect();
    assert.equal(inspection.activeNodes[0]?.latestMilestone?.phase, "verify");
    assert.equal(inspection.activeNodes[0]?.latestMilestone?.percent, 50);
    assert.equal(inspection.cursor, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation wait returns timeout as data and wakes on a new event", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-wait-"));
  const runRoot = join(root, ".agent-graph", "runs", "waiting");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    ...versionedState,
    runId: "waiting",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    baselineChangedFiles: [],
    nodes: { active: { status: "running", attempts: 1, generation: 0, generationAttempts: 1, evidenceFiles: [] } },
  };
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: state.updatedAt, type: "node_started", nodeId: "active" })}\n`, "utf8");
  const observer = new RunObserver(root, "waiting");

  try {
    const timedOut = await observer.wait(1, 20);
    assert.equal(timedOut.timedOut, true);
    assert.deepEqual(timedOut.events, []);

    const append = new Promise<void>((resolveAppend, rejectAppend) => {
      setTimeout(() => {
        writeFile(
          join(runRoot, "events.jsonl"),
          `${JSON.stringify({ seq: 1, at: state.updatedAt, type: "node_started", nodeId: "active" })}\n${JSON.stringify({ seq: 2, at: "2026-08-16T00:00:01.000Z", type: "node_progress", nodeId: "active", detail: "ready" })}\n`,
          "utf8",
        ).then(resolveAppend, rejectAppend);
      }, 20);
    });
    const awakened = await observer.wait(1, 300);
    await append;
    assert.equal(awakened.timedOut, false);
    assert.deepEqual(awakened.events.map((event) => event.seq), [2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation explains an ownership stop with retry safety and paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-explain-"));
  const runRoot = join(root, ".agent-graph", "runs", "stopped");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    ...versionedState,
    runId: "stopped",
    graphHash: "fixture",
    status: "needs_attention",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:01:00.000Z",
    baselineChangedFiles: [],
    nodes: {
      implementation: {
        status: "failed",
        attempts: 1,
        generation: 0,
        generationAttempts: 1,
        retryBlocked: true,
        lastError: "unexpected changed paths: apps/landing/a.ts, output/playwright/a.png",
        evidenceFiles: ["evidence/implementation-attempt-1.json"],
      },
    },
  };
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: state.updatedAt, type: "run_needs_attention" })}\n`, "utf8");

  try {
    const explanation = await new RunObserver(root, "stopped").explain();
    assert.deepEqual(explanation.issues[0], {
      code: "OWNERSHIP_ESCAPE",
      nodeId: "implementation",
      retrySafety: "inspect_required",
      paths: ["apps/landing/a.ts", "output/playwright/a.png"],
      nextAction: "Stop or isolate every external writer, inspect the paths and evidence, then run agr retry implementation explicitly.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation follow replays through the terminal event without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-follow-"));
  const runRoot = join(root, ".agent-graph", "runs", "followed");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    ...versionedState,
    runId: "followed",
    graphHash: "fixture",
    status: "completed",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:03.000Z",
    baselineChangedFiles: [],
    nodes: { node: { status: "accepted", attempts: 1, generation: 0, generationAttempts: 1, evidenceFiles: [] } },
  };
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(
    join(runRoot, "events.jsonl"),
    [
      { seq: 1, at: "2026-08-16T00:00:00.000Z", type: "run_started" },
      { seq: 2, at: "2026-08-16T00:00:01.000Z", type: "node_accepted", nodeId: "node" },
      { seq: 3, at: "2026-08-16T00:00:03.000Z", type: "run_completed" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  try {
    const observed = [];
    for await (const item of new RunObserver(root, "followed").follow(1, 5)) observed.push(item);
    assert.deepEqual(observed.map((item) => item.type), ["node_accepted", "run_completed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation rejects semantically invalid or unordered event histories", () => {
  const valid = (seq: number) => JSON.stringify({ seq, at: "2026-08-16T00:00:00.000Z", type: "run_started" });
  const cases = [
    "42",
    "{}",
    JSON.stringify({ seq: 1, at: 7, type: "run_started" }),
    JSON.stringify({ seq: 1, at: "2026-08-16T00:00:00.000Z", type: "bogus" }),
    JSON.stringify({ seq: 1, at: "2026-08-16T00:00:00.000Z", type: "node_progress", percent: "50" }),
    `${valid(1)}\n${valid(1)}`,
    `${valid(2)}\n${valid(1)}`,
    `${valid(1)}\n${JSON.stringify({ at: "2026-08-16T00:00:01.000Z", type: "run_completed" })}`,
  ];

  for (const history of cases) {
    assert.throws(
      () => parseRunEventLog(`${history}\n`),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "EVENT_LOG_INVALID");
        assert.match((error as Error).message, /events\.jsonl line/);
        return true;
      },
      history,
    );
  }
});
