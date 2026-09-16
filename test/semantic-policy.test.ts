import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { NonRetryableAdapterError, type AgentAdapter } from "../src/adapters.js";
import { GraphRunner } from "../src/runner.js";
import { validateGraph } from "../src/graph.js";
import type { AgentHandoff, GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);
const done = (status: AgentHandoff["status"] = "complete") => ({
  exitCode: 0, stdout: "retained raw output", stderr: "",
  handoff: { status, summary: "Independent finding", changedFiles: [] as string[], verification: ["inspected"], gaps: [] },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function graph(): GraphDefinition {
  return { version: 1, run: { id: "semantic-policy", objective: "Retain independent evidence", repository: ".", maxConcurrency: 2,
    semanticFailurePolicy: "finish-independent-read-only" }, nodes: [
    { id: "finding", type: "review", executor: "codex", prompt: "Review A", needs: [], owns: [], checks: [], maxAttempts: 2 },
    { id: "peer", type: "review", executor: "codex", prompt: "Review B", needs: [], owns: [], checks: [], maxAttempts: 2 },
    { id: "dependent", type: "review", executor: "codex", prompt: "Must not run", needs: ["finding", "peer"], owns: [], checks: [], maxAttempts: 1 },
  ] };
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "agr-semantic-policy-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

for (const status of ["blocked", "partial"] as const) {
  test(`opt-in retains a peer completing after ${status}, stops descendants and preserves finding`, { timeout: 15000 }, async () => fixture(async (root) => {
    const inspected = deferred();
    const started = deferred();
    const calls: string[] = [];
    const adapter: AgentAdapter = { async execute(request) {
      calls.push(request.node.id);
      if (request.node.id === "finding") {
        await started.promise;
        const result = done(status);
        Object.defineProperty(result.handoff, "status", { enumerable: true, get() { inspected.resolve(); return status; } });
        return result;
      }
      started.resolve();
      await inspected.promise;
      assert.equal(request.signal?.aborted, false);
      return done();
    } };
    const g = graph();
    g.run.advisor = { executor: "codex" };
    g.nodes.push({ ...g.nodes[1]!, id: "queued-independent" });
    const state = await new GraphRunner(g, root, { codex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.deepEqual(calls.sort(), ["finding", "peer"]);
    assert.equal(state.nodes.finding!.retryBlocked, true);
    assert.equal(state.nodes.finding!.attempts, 1);
    assert.equal(state.nodes.peer!.status, "accepted");
    const evidence = JSON.parse(await readFile(join(root, ".agent-graph/runs/semantic-policy", state.nodes.peer!.evidenceFiles[0]!), "utf8"));
    assert.equal(evidence.handoff.status, "complete");
    assert.deepEqual(evidence.failures, []);
    assert.equal((await new GraphRunner(g, root, { codex: adapter }).run()).status, "needs_attention");
    assert.equal(calls.length, 2);
  }));
}

for (const mode of ["default", "explicit-stop", "mixed-writer", "claimed-write", "actual-write", "default-actual-write", "mixed-actual-write", "unknown-error", "termination", "external"] as const) {
  test(`${mode} still aborts peers and rejects success after abort`, { timeout: 15000 }, async () => fixture(async (root) => {
    const g = graph();
    if (mode === "default" || mode === "default-actual-write") delete g.run.semanticFailurePolicy;
    if (mode === "explicit-stop") g.run.semanticFailurePolicy = "stop";
    if (mode === "mixed-writer" || mode === "mixed-actual-write") { g.nodes[1]!.type = "agent"; g.nodes[1]!.owns = ["owned/**"]; }
    if (mode === "external") {
      g.run.allowExternalActions = true;
      g.nodes[1] = { ...g.nodes[1]!, type: "external_action", target: "test:effect", needs: ["gate"] };
      g.nodes[0]!.needs = ["gate"];
      g.nodes.unshift({ id: "gate", type: "human_gate", target: "test:effect", needs: [], owns: [], checks: [], maxAttempts: 1 });
      // Use a mixed-wave external action only after its explicit human gate.
      const { RunStore } = await import("../src/store.js");
      const store = await RunStore.open(root, g, []);
      store.state.nodes.gate!.approvedTarget = "test:effect";
      await store.save("test-approval");
    }
    const started = deferred();
    let aborted = false;
    const adapter: AgentAdapter = { async execute(request) {
      if (request.node.id === "finding") {
        await started.promise;
        if (mode === "unknown-error") throw new Error("unknown executor failure");
        if (mode === "termination") throw new NonRetryableAdapterError("termination unconfirmed");
        if (mode === "actual-write" || mode === "default-actual-write" || mode === "mixed-actual-write") await writeFile(join(root, "escaped.txt"), "unsafe");
        const result = done(mode.endsWith("actual-write") ? "complete" : "blocked");
        if (mode === "claimed-write") result.handoff.changedFiles = ["escaped.txt"];
        return result;
      }
      started.resolve();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = true;
      return done(); // Deliberately non-cooperative success must not be accepted.
    } };
    const state = await new GraphRunner(g, root, { codex: adapter }).run();
    assert.equal(aborted, true);
    assert.equal(state.status, "needs_attention");
    assert.equal(state.nodes.peer!.status, "failed");
    assert.equal(state.nodes.peer!.retryBlocked, true);
    assert.equal(state.nodes.dependent!.attempts, 0);
  }));
}

test("user cancellation overrides retention", { timeout: 15000 }, async () => fixture(async (root) => {
  const controller = new AbortController();
  const inspected = deferred();
  const started = deferred();
  const adapter: AgentAdapter = { async execute(request) {
    if (request.node.id === "finding") {
      await started.promise;
      const result = done("partial");
      Object.defineProperty(result.handoff, "status", { enumerable: true, get() { inspected.resolve(); return "partial"; } });
      return result;
    }
    started.resolve();
    await inspected.promise;
    controller.abort();
    return done();
  } };
  const state = await new GraphRunner(graph(), root, { codex: adapter }, { signal: controller.signal }).run();
  assert.equal(state.status, "cancelled");
  assert.equal(state.nodes.peer!.retryBlocked, true);
  assert.equal(state.nodes.dependent!.attempts, 0);
}));

test("an already-running verify check completes and keeps output after semantic finding", { timeout: 15000 }, async () => fixture(async (root) => {
  const g = graph();
  g.nodes[1] = { id: "peer", type: "verify", needs: [], owns: [], maxAttempts: 1, timeoutMs: 5000,
    checks: [`${JSON.stringify(process.execPath)} -e "const f=require('fs');const t=setInterval(()=>{if(f.existsSync('.agent-graph/release')){clearInterval(t);console.log('independent-check-evidence')}},10)"`] };
  const adapter: AgentAdapter = { async execute() {
    const result = done("blocked");
    Object.defineProperty(result.handoff, "status", { enumerable: true, get() {
      writeFileSync(join(root, ".agent-graph/release"), "continue"); return "blocked";
    } });
    return result;
  } };
  const state = await new GraphRunner(g, root, { codex: adapter }).run();
  assert.equal(state.status, "needs_attention");
  assert.equal(state.nodes.peer!.status, "accepted");
  const evidence = await readFile(join(root, ".agent-graph/runs/semantic-policy", state.nodes.peer!.evidenceFiles[0]!), "utf8");
  assert.match(evidence, /independent-check-evidence/);
}));

test("unknown semantic failure policies are rejected", () => {
  const g = graph();
  (g.run as unknown as Record<string, unknown>).semanticFailurePolicy = "ignore";
  assert.match(validateGraph(g).errors.join("\n"), /semanticFailurePolicy/);
});
