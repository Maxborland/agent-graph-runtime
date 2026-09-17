import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { CodexAdapter } from "../src/adapters.js";
import { GraphRunner } from "../src/runner.js";
import type { GraphDefinition, GraphNodeDefinition } from "../src/types.js";

const exec = promisify(execFile);

const baseNode: GraphNodeDefinition = {
  id: "agent",
  type: "agent",
  executor: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  prompt: "Run the synthetic failure fixture.",
  needs: [],
  owns: [],
  checks: [],
  maxAttempts: 1,
};

async function createFixture(root: string, mode: "timeout" | "nonzero" | "cancel" | "missing"): Promise<{ fake: string; started: string }> {
  const fake = join(root, `fake-codex-${mode}.mjs`);
  const started = join(root, "started");
  await writeFile(
    fake,
    `import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (mode !== "missing") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-" + mode }));
  console.log(JSON.stringify({ type: "turn_context", thread_id: "fixture-" + mode, payload: { cwd: process.cwd(), model: "gpt-5.6-luna", effort: "max" } }));
}
writeFileSync(${JSON.stringify(started)}, "started");
if (mode === "timeout" || mode === "cancel") setTimeout(() => {}, 60_000);
else process.exitCode = 7;
`,
    "utf8",
  );
  return { fake, started };
}

async function createGraph(root: string, id: string, timeoutMs: number): Promise<GraphDefinition> {
  await exec("git", ["init", "--quiet"], { cwd: root });
  return {
    version: 1,
    run: { id, objective: "retain failed executor evidence", repository: ".", maxConcurrency: 1 },
    nodes: [{ ...baseNode, owns: ["started"], timeoutMs }],
  };
}

async function readEvidence(root: string, state: { nodes: Record<string, { evidenceFiles: string[] }> }, id: string) {
  const path = join(root, ".agent-graph", "runs", id, state.nodes.agent!.evidenceFiles[0]!);
  return JSON.parse(await readFile(path, "utf8")) as {
    agentProcess: { exitCode: number | null; timedOut: boolean; aborted: boolean; timeoutMs: number; terminationError?: string } | null;
    configuredExecution: { model?: string; reasoningEffort?: string } | null;
    observedExecution: { threadId?: string; model?: string; reasoningEffort?: string } | null;
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  throw new Error(`fixture did not start: ${path}`);
}

for (const mode of ["timeout", "nonzero"] as const) {
  test(`runner retains observed execution and process metadata for Codex ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `agr-process-evidence-${mode}-`));
    try {
      const fixture = await createFixture(root, mode);
      const graph = await createGraph(root, `process-evidence-${mode}`, mode === "timeout" ? 500 : 5_000);
      const state = await new GraphRunner(graph, root, {
        codex: new CodexAdapter(process.execPath, [fixture.fake]),
      }).run();
      assert.equal(state.status, "failed");
      const evidence = await readEvidence(root, state, graph.run.id);
      assert.equal(evidence.observedExecution?.threadId, `fixture-${mode}`);
      assert.equal(evidence.observedExecution?.model, "gpt-5.6-luna");
      assert.equal(evidence.observedExecution?.reasoningEffort, "max");
      assert.equal(evidence.agentProcess?.timedOut, mode === "timeout");
      assert.equal(evidence.agentProcess?.aborted, false);
      assert.equal(evidence.agentProcess?.timeoutMs, mode === "timeout" ? 500 : 5_000);
      if (mode === "nonzero") assert.equal(evidence.agentProcess?.exitCode, 7);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test("runner retains observed execution and process metadata for Codex cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-process-evidence-cancel-"));
  try {
    const fixture = await createFixture(root, "cancel");
    const graph = await createGraph(root, "process-evidence-cancel", 5_000);
    const controller = new AbortController();
    const run = new GraphRunner(graph, root, {
      codex: new CodexAdapter(process.execPath, [fixture.fake]),
    }, { signal: controller.signal }).run();
    await waitForFile(fixture.started);
    controller.abort();
    const state = await run;
    assert.equal(state.status, "cancelled");
    const evidence = await readEvidence(root, state, graph.run.id);
    assert.equal(evidence.observedExecution?.threadId, "fixture-cancel");
    assert.equal(evidence.observedExecution?.model, "gpt-5.6-luna");
    assert.equal(evidence.agentProcess?.aborted, true);
    assert.equal(evidence.agentProcess?.timedOut, false);
    assert.equal(state.nodes.agent!.retryBlocked, true);
    assert.notEqual(state.nodes.agent!.status, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("runner keeps missing observed execution metadata unknown on Codex failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-process-evidence-missing-"));
  try {
    const fixture = await createFixture(root, "missing");
    const graph = await createGraph(root, "process-evidence-missing", 5_000);
    const state = await new GraphRunner(graph, root, {
      codex: new CodexAdapter(process.execPath, [fixture.fake]),
    }).run();
    assert.equal(state.status, "failed");
    const evidence = await readEvidence(root, state, graph.run.id);
    assert.equal(evidence.observedExecution, null);
    assert.equal(evidence.configuredExecution?.model, "gpt-5.6-luna");
    assert.equal(evidence.agentProcess?.exitCode, 7);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
