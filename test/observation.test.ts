import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRunEventLog, RunObserver } from "../src/observation.js";
import type { GraphDefinition, RunState } from "../src/types.js";

test("observation reads one bounded state and event snapshot after a cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-snapshot-"));
  const runRoot = join(root, ".agent-graph", "runs", "observed");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "observed",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:02.000Z",
    baselineChangedFiles: [],
    nodes: {
      active: { status: "running", attempts: 1, evidenceFiles: [] },
      pending: { status: "pending", attempts: 0, evidenceFiles: [] },
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
    runId: "waiting",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    baselineChangedFiles: [],
    nodes: { active: { status: "running", attempts: 1, evidenceFiles: [] } },
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

test("observation separates finished executors from nodes awaiting wave acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-executor-finish-"));
  const runRoot = join(root, ".agent-graph", "runs", "wave");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "wave",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:03.000Z",
    baselineChangedFiles: [],
    nodes: {
      fast: { status: "running", attempts: 1, evidenceFiles: [] },
      slow: { status: "running", attempts: 1, evidenceFiles: [] },
    },
  };
  const events = [
    { seq: 1, at: "2026-08-16T00:00:00.000Z", type: "node_started", nodeId: "fast", attempt: 1 },
    { seq: 2, at: "2026-08-16T00:00:01.000Z", type: "node_execution_finished", nodeId: "fast", attempt: 1 },
    { seq: 3, at: "2026-08-16T00:00:01.000Z", type: "node_started", nodeId: "slow", attempt: 1 },
    { seq: 4, at: "2026-08-16T00:00:03.000Z", type: "node_progress", nodeId: "slow", phase: "verify", detail: "still running", percent: 35 },
  ];
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(
    join(runRoot, ".run.lock"),
    JSON.stringify({ token: "live-owner", pid: process.pid, host: hostname(), startedAt: state.createdAt }),
    "utf8",
  );

  try {
    const observer = new RunObserver(root, "wave");
    const snapshot = await observer.read();
    assert.deepEqual(snapshot.activeNodes, [{ id: "slow", attempts: 1 }]);
    assert.equal(snapshot.state.nodes.fast?.status, "running");
    const inspection = await observer.inspect(Date.parse("2026-08-16T00:00:04.000Z"));
    assert.deepEqual(inspection.activeNodes.map((node) => node.id), ["slow"]);
    assert.deepEqual(inspection.pendingAcceptanceNodes, [{ id: "fast", attempts: 1 }]);
    assert.equal(inspection.activeNodes[0]?.latestMilestone?.percent, 35);
    const follower = observer.follow(events.length, 1);
    try {
      const heartbeat = await follower.next();
      assert.deepEqual(heartbeat.value?.type === "observer_heartbeat" ? heartbeat.value.activeNodeIds : [], ["slow"]);
    } finally {
      await follower.return(undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation does not carry a previous attempt milestone into a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-retry-progress-"));
  const runRoot = join(root, ".agent-graph", "runs", "retried");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "retried",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:04.000Z",
    baselineChangedFiles: [],
    nodes: { node: { status: "running", attempts: 2, evidenceFiles: [] } },
  };
  const events = [
    { seq: 1, at: "2026-08-16T00:00:00.000Z", type: "node_started", nodeId: "node", attempt: 1 },
    { seq: 2, at: "2026-08-16T00:00:01.000Z", type: "node_progress", nodeId: "node", phase: "complete", percent: 100 },
    { seq: 3, at: "2026-08-16T00:00:02.000Z", type: "node_execution_finished", nodeId: "node", attempt: 1 },
    { seq: 4, at: "2026-08-16T00:00:03.000Z", type: "node_started", nodeId: "node", attempt: 2 },
  ];
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  try {
    const inspection = await new RunObserver(root, "retried").inspect(Date.parse("2026-08-16T00:00:05.000Z"));
    assert.equal(inspection.activeNodes[0]?.attempts, 2);
    assert.equal(inspection.activeNodes[0]?.latestMilestone, undefined);
    assert.deepEqual(inspection.pendingAcceptanceNodes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation why recommends explicit retry when the generation budget is exhausted", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-budget-"));
  const runRoot = join(root, ".agent-graph", "runs", "budget");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "budget",
    graphHash: "fixture",
    status: "failed",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:02.000Z",
    baselineChangedFiles: [],
    nodes: {
      check: {
        status: "failed",
        attempts: 4,
        generationAttempts: 2,
        lastError: "failed checks: lint",
        evidenceFiles: [],
      },
    },
  };
  const graph = {
    version: 1,
    run: { id: "budget", objective: "check attempt advice", repository: ".", maxConcurrency: 1 },
    nodes: [{ id: "check", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 2 }],
  } satisfies GraphDefinition;
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: state.updatedAt, type: "node_failed", nodeId: "check" })}\n`, "utf8");

  try {
    const explanation = await new RunObserver(root, "budget").explain(graph);
    assert.match(explanation.issues[0]!.nextAction, /agr retry check explicitly/);
    assert.match(explanation.issues[0]!.nextAction, /automatic attempt budget is exhausted/);
    assert.doesNotMatch(explanation.issues[0]!.nextAction, /agr run/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("follow reports a stale running owner with status-watch error semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-owner-lost-"));
  const runRoot = join(root, ".agent-graph", "runs", "orphaned");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "orphaned",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:01.000Z",
    baselineChangedFiles: [],
    nodes: { node: { status: "running", attempts: 1, evidenceFiles: [] } },
  };
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: state.updatedAt, type: "node_started", nodeId: "node", attempt: 1 })}\n`, "utf8");
  await writeFile(
    join(runRoot, ".run.lock"),
    JSON.stringify({ token: "dead-owner", pid: findMissingLocalPid(), host: hostname(), startedAt: state.createdAt }),
    "utf8",
  );

  try {
    await assert.rejects(
      async () => {
        for await (const item of new RunObserver(root, "orphaned").follow(1, 1)) void item;
      },
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "RUN_OWNER_MISSING");
        assert.equal((error as { exitCode?: number }).exitCode, 1);
        assert.match((error as Error).message, /resume it with agr run/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("follow rechecks terminal state if the owner disappears after yielding an event", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-owner-finished-"));
  const runRoot = join(root, ".agent-graph", "runs", "finished");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "finished",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:01.000Z",
    baselineChangedFiles: [],
    nodes: { node: { status: "running", attempts: 1, evidenceFiles: [] } },
  };
  const lockPath = join(runRoot, ".run.lock");
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(
    join(runRoot, "events.jsonl"),
    `${JSON.stringify({ seq: 1, at: state.createdAt, type: "run_started" })}\n${JSON.stringify({ seq: 2, at: state.updatedAt, type: "node_started", nodeId: "node", attempt: 1 })}\n`,
    "utf8",
  );
  await writeFile(lockPath, JSON.stringify({
    token: "live-owner",
    pid: process.pid,
    host: hostname(),
    startedAt: state.createdAt,
  }), "utf8");
  const follower = new RunObserver(root, "finished").follow(1, 1)[Symbol.asyncIterator]();

  try {
    const first = await follower.next();
    assert.equal(first.value?.type, "node_started");
    state.status = "completed";
    state.updatedAt = "2026-08-16T00:00:02.000Z";
    await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
    await writeFile(
      join(runRoot, "events.jsonl"),
      `${JSON.stringify({ seq: 1, at: state.createdAt, type: "run_started" })}\n${JSON.stringify({ seq: 2, at: "2026-08-16T00:00:01.000Z", type: "node_started", nodeId: "node", attempt: 1 })}\n${JSON.stringify({ seq: 3, at: state.updatedAt, type: "run_completed" })}\n`,
      "utf8",
    );
    await rm(lockPath, { force: true });
    assert.equal((await follower.next()).value?.type, "run_completed");
    assert.equal((await follower.next()).done, true);
  } finally {
    await follower.return?.(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("follow treats an initializing owner record as a startup race", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-owner-initializing-"));
  const runRoot = join(root, ".agent-graph", "runs", "initializing");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "initializing",
    graphHash: "fixture",
    status: "running",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:01.000Z",
    baselineChangedFiles: [],
    nodes: { node: { status: "running", attempts: 1, evidenceFiles: [] } },
  };
  await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: state.updatedAt, type: "node_started", nodeId: "node", attempt: 1 })}\n`, "utf8");
  await writeFile(join(runRoot, ".run.lock"), "{", "utf8");
  const follower = new RunObserver(root, "initializing").follow(1, 1)[Symbol.asyncIterator]();

  try {
    const heartbeat = await follower.next();
    assert.equal(heartbeat.done, false);
    assert.equal(heartbeat.value?.type, "observer_heartbeat");
    state.status = "completed";
    state.updatedAt = "2026-08-16T00:00:02.000Z";
    await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
    await writeFile(
      join(runRoot, "events.jsonl"),
      `${JSON.stringify({ seq: 1, at: "2026-08-16T00:00:01.000Z", type: "node_started", nodeId: "node", attempt: 1 })}\n${JSON.stringify({ seq: 2, at: state.updatedAt, type: "run_completed" })}\n`,
      "utf8",
    );
    const terminalEvent = await follower.next();
    assert.equal(terminalEvent.value?.type, "run_completed");
    assert.equal((await follower.next()).done, true);
  } finally {
    await follower.return?.(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("observation follow replays through the terminal event without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-observation-follow-"));
  const runRoot = join(root, ".agent-graph", "runs", "followed");
  await mkdir(runRoot, { recursive: true });
  const state: RunState = {
    runId: "followed",
    graphHash: "fixture",
    status: "completed",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:03.000Z",
    baselineChangedFiles: [],
    nodes: { node: { status: "accepted", attempts: 1, evidenceFiles: [] } },
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
    JSON.stringify({ seq: 1, at: "2026-08-16T00:00:00.000Z", type: "node_started", nodeId: "node", attempt: 0 }),
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

function findMissingLocalPid(): number {
  for (let pid = process.pid + 1; pid <= process.pid + 10_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find an unused local process ID for the stale-lock fixture");
}
