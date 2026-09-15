import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDependencyContext } from "../src/dependency-context.js";
import { RunStore } from "../src/store.js";
import type { GraphDefinition } from "../src/types.js";

test("dependency context survives resume, selects the accepted attempt, bounds payloads and rejects missing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-dependencies-"));
  const graph: GraphDefinition = {
    version: 1, run: { id: "context", objective: "test", repository: ".", maxConcurrency: 1 },
    nodes: ["source", "unrelated", "consumer"].map((id) => ({
      id, type: "review", executor: "codex", prompt: id,
      needs: id === "consumer" ? ["source"] : [], owns: [], checks: [], maxAttempts: 2,
    })),
  };
  try {
    const store = await RunStore.open(root, graph, []);
    store.state.nodes.source = { status: "accepted", attempts: 2, evidenceFiles: ["evidence/source-attempt-1.json", "evidence/source-attempt-2.json"] };
    const path = join(store.evidenceDirectory, "source-attempt-2.json");
    const evidence = {
      nodeId: "source", attempt: 2, failures: [], agentProcess: { exitCode: 0 },
      handoff: { status: "complete", summary: "CURRENT " + "x".repeat(20_000), changedFiles: [], verification: [], gaps: [] }, checks: [],
    };
    await writeFile(join(store.evidenceDirectory, "source-attempt-1.json"), JSON.stringify({ handoff: { summary: "STALE" } }));
    await writeFile(path, JSON.stringify(evidence));
    await store.save("fixture");
    const resumed = await RunStore.open(root, graph, []);
    const consumer = graph.nodes[2]!;
    const context = await buildDependencyContext(consumer, resumed);
    assert.match(context, /CURRENT/);
    assert.match(context, /Excerpt truncated/);
    assert.match(context, /source-attempt-2.json/);
    assert.ok(context.length < 13_000);
    assert.ok(!context.includes("STALE"));
    assert.ok(!context.includes("unrelated"));
    await writeFile(path, JSON.stringify({ ...evidence, attempt: 1 }));
    await assert.rejects(buildDependencyContext(consumer, resumed), /does not match/);
    await rm(path);
    await assert.rejects(buildDependencyContext(consumer, resumed), /ENOENT/);
    resumed.state.nodes.source!.evidenceFiles = [];
    await assert.rejects(buildDependencyContext(consumer, resumed), /no current evidence/);
    resumed.state.nodes.source!.status = "pending";
    await assert.rejects(buildDependencyContext(consumer, resumed), /not accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long upstream reports leave room for every dependency, including final review", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-context-budget-"));
  const ids = ["plan", "explore", "research", "work", "tests", "review"];
  const graph: GraphDefinition = {
    version: 1, run: { id: "budget", objective: "test", repository: ".", maxConcurrency: 1 },
    nodes: [...ids, "integrate"].map((id) => ({
      id, type: "review", executor: "codex", prompt: id,
      needs: id === "integrate" ? ids : [], owns: [], checks: [], maxAttempts: 1,
    })),
  };
  try {
    const store = await RunStore.open(root, graph, []);
    for (const id of ids) {
      store.state.nodes[id] = { status: "accepted", attempts: 1, evidenceFiles: [`evidence/${id}-attempt-1.json`] };
      await writeFile(join(store.evidenceDirectory, `${id}-attempt-1.json`), JSON.stringify({
        nodeId: id, attempt: 1, failures: [], agentProcess: { exitCode: 0 }, checks: [],
        handoff: { status: "complete", summary: `FINDING-${id} ` + "x".repeat(20_000), changedFiles: [], verification: [], gaps: [`CAVEAT-${id}`] },
      }));
    }
    const context = await buildDependencyContext(graph.nodes.at(-1)!, store);
    for (const id of ids) {
      assert.ok(context.includes(`FINDING-${id}`), `missing ${id} summary`);
      assert.ok(context.includes(`CAVEAT-${id}`), `missing ${id} caveat`);
    }
    assert.ok(context.length < 51_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted dependency evidence rejects damaged handoffs and contradictory checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-context-corrupt-"));
  const graph: GraphDefinition = {
    version: 1, run: { id: "corrupt", objective: "test", repository: ".", maxConcurrency: 1 },
    nodes: ["source", "consumer"].map((id) => ({
      id, type: "review", executor: "codex", prompt: id,
      needs: id === "consumer" ? ["source"] : [], owns: [], checks: id === "source" ? ["expected check"] : [], maxAttempts: 1,
    })),
  };
  try {
    const store = await RunStore.open(root, graph, []);
    store.state.nodes.source = { status: "accepted", attempts: 1, evidenceFiles: ["evidence/source-attempt-1.json"] };
    const path = join(store.evidenceDirectory, "source-attempt-1.json");
    const evidence = {
      nodeId: "source", attempt: 1, failures: [], agentProcess: { exitCode: 0 },
      handoff: { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] },
      checks: [{ command: "expected check", exitCode: 0, stdout: "RAW_CHECK_OUTPUT" }],
    };
    for (const patch of [
      { handoff: null }, { handoff: { ...evidence.handoff, status: "blocked" } },
      { handoff: { ...evidence.handoff, gaps: "broken" } }, { checks: [] },
      { checks: [{ command: "different check", exitCode: 0 }] },
      { checks: [{ command: "expected check", exitCode: 1 }] },
      { checks: [{ command: "expected check", exitCode: 0, timedOut: true }] },
      { agentProcess: { exitCode: 1 } }, { retryBlocked: true },
    ]) {
      await writeFile(path, JSON.stringify({ ...evidence, ...patch }));
      await assert.rejects(buildDependencyContext(graph.nodes[1]!, store), /dependency source:/, JSON.stringify(patch));
    }
    await writeFile(path, JSON.stringify({ ...evidence, handoff: { ...evidence.handoff, rawOutput: "RAW_AGENT_OUTPUT" } }));
    const context = await buildDependencyContext(graph.nodes[1]!, store);
    assert.ok(!context.includes("RAW_AGENT_OUTPUT"));
    assert.ok(!context.includes("RAW_CHECK_OUTPUT"));
    assert.ok(context.includes('"exitCode":0'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
