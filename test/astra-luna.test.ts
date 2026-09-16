import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { initializeGraph } from "../src/cli-tools.js";
import { CodexAdapter } from "../src/adapters.js";
import { validateGraph } from "../src/graph.js";
import { buildExecutionPlan } from "../src/planner.js";
import { GraphRunner } from "../src/runner.js";
import { OperatorControl } from "../src/operator-control.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("CLI initializes the Astra/Luna workflow without overwriting an existing graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-astra-init-"));
  const cli = resolve("dist/src/cli.js");
  try {
    await exec(process.execPath, [cli, "init", "--template", "astra-luna"], { cwd: root });
    const path = join(root, ".agent-graph", "graph.json");
    const original = await readFile(path, "utf8");
    const graph = JSON.parse(original) as GraphDefinition;
    assert.deepEqual(validateGraph(graph).errors, []);
    assert.equal(graph.run.repository, ".");
    assert.deepEqual(buildExecutionPlan(graph).waves.map((wave) => wave.nodes.map((node) => node.id)), [
      ["orchestrator"], ["explorer", "researcher"], ["worker"], ["tester"],
      ["test-checks"], ["reviewer"], ["integrate"], ["final-checks"],
    ]);
    assert.deepEqual(graph.nodes.filter((node) => node.model === "gpt-6-astra").map((node) => node.id),
      ["orchestrator", "reviewer", "integrate"]);
    assert.deepEqual(graph.nodes.filter((node) => node.model === "gpt-5.6-luna").map((node) => node.id),
      ["explorer", "researcher", "worker", "tester"]);
    await assert.rejects(exec(process.execPath, [cli, "init", "--template", "astra-luna"], { cwd: root }));
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ["success", "test-failure", "review-blocker", "final-failure"] as const) {
  test(`Astra/Luna workflow propagates evidence and gates downstream work: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-astra-run-"));
    await exec("git", ["init", "--quiet"], { cwd: root });
    const graph = await initializeGraph(join(root, ".agent-graph", "graph.json"), "astra-luna", root);
    graph.run.objective = "Exercise the bounded workflow";
    for (const node of graph.nodes.filter((node) => node.type === "verify")) {
      const fails = (scenario === "test-failure" && node.id === "test-checks") ||
        (scenario === "final-failure" && node.id === "final-checks");
      node.checks = [`"${process.execPath}" -e "process.exit(${fails ? 1 : 0})"`];
    }
    const calls: string[] = [];
    const runner = new GraphRunner(graph, root, { codex: {
      async execute(request) {
        calls.push(request.node.id);
        for (const dependency of request.node.needs) {
          assert.match(request.prompt, new RegExp(`Dependency ${dependency} \\(accepted attempt 1\\)`));
          if (dependency !== "test-checks") assert.ok(request.prompt.includes(`result-from-${dependency}`));
        }
        if (request.node.id === "reviewer") assert.match(request.prompt, /"exitCode":0/);
        return {
          exitCode: 0, stdout: "PRIVATE RAW OUTPUT", stderr: "",
          handoff: {
            status: scenario === "review-blocker" && request.node.id === "reviewer" ? "blocked" as const : "complete" as const,
            summary: `result-from-${request.node.id}`, changedFiles: [], verification: [], gaps: [],
          },
        };
      },
    } });
    try {
      const state = await runner.run();
      assert.equal(state.status, scenario === "success" ? "completed" : scenario === "review-blocker" ? "needs_attention" : "failed");
      assert.ok(calls.indexOf("worker") > calls.indexOf("researcher"));
      assert.ok(calls.indexOf("worker") > calls.indexOf("explorer"));
      assert.equal(calls.includes("integrate"), scenario === "success" || scenario === "final-failure");
      if (scenario === "test-failure") {
        assert.equal(state.nodes["test-checks"]!.status, "failed");
        assert.ok(!calls.includes("reviewer"));
      }
      if (scenario === "review-blocker") assert.equal(state.nodes.reviewer!.status, "failed");
      if (scenario === "final-failure") assert.equal(state.nodes["final-checks"]!.status, "failed");
      const prompt = await readFile(join(root, ".agent-graph", "runs", graph.run.id, "prompts", "worker-attempt-1.md"), "utf8");
      assert.ok(!prompt.includes("PRIVATE RAW OUTPUT"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Astra/Luna routes CLI sessions, writes source and tests, and reruns downstream work after retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-astra-cli-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph = await initializeGraph(join(root, ".agent-graph", "graph.json"), "astra-luna", root);
  graph.run.objective = "Provide integer addition with independent tests";
  for (const node of graph.nodes.filter((node) => node.type === "verify")) {
    node.checks = [`"${process.execPath}" test/add.test.cjs`];
  }
  const fixture = join(root, ".agent-graph", "fixture.cjs");
  await writeFile(fixture, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = /^# Agent Graph node (.+)$/m.exec(prompt)[1];
  const astra = ['orchestrator', 'reviewer', 'integrate'].includes(id);
  assert.equal(option('--model'), astra ? 'gpt-6-astra' : 'gpt-5.6-luna');
  assert.equal(option('--sandbox'), ['worker', 'tester'].includes(id) ? 'workspace-write' : 'read-only');
  assert.ok(args.includes('multi_agent') && args.includes('multi_agent_v2'));
  let changedFiles = [];
  if (id === 'worker') {
    assert.ok(prompt.includes('handoff-explorer') && prompt.includes('handoff-researcher'));
    fs.mkdirSync('src', { recursive: true });
    fs.writeFileSync('src/add.cjs', 'module.exports = (a, b) => a + b;');
    changedFiles = ['src/add.cjs'];
  }
  if (id === 'tester') {
    assert.ok(prompt.includes('handoff-worker'));
    fs.mkdirSync('test', { recursive: true });
    fs.writeFileSync('test/add.test.cjs', "const assert = require('node:assert/strict'); const add = require('../src/add.cjs'); assert.equal(add(2, 3), 5); assert.equal(add(-2, 2), 0);");
    changedFiles = ['test/add.test.cjs'];
  }
  if (['reviewer', 'integrate'].includes(id)) {
    const expectedAttempt = require('node:path').basename(require('node:path').dirname(option('--output-last-message'))).split('-attempt-').pop();
    assert.ok(prompt.includes('Dependency test-checks (accepted attempt ' + expectedAttempt + ')'));
    assert.ok(prompt.includes('"exitCode":0'));
    assert.ok(fs.readFileSync('test/add.test.cjs', 'utf8').includes('add(-2, 2)'));
  }
  fs.writeFileSync(option('--output-last-message'), JSON.stringify({
    status: 'complete', summary: 'handoff-' + id, changedFiles, verification: [], gaps: []
  }));
});
`);
  const calls: string[] = [];
  const adapter = new CodexAdapter(process.execPath, [fixture]);
  const createRunner = () => new GraphRunner(graph, root, { codex: {
    execute(request) { calls.push(request.node.id); return adapter.execute(request); },
  } });
  try {
    assert.equal((await createRunner().run()).status, "completed");
    const runRoot = join(root, ".agent-graph", "runs", graph.run.id);
    const evidence = JSON.parse(await readFile(join(runRoot, "evidence", "final-checks-attempt-1.json"), "utf8"));
    assert.equal(evidence.checks[0].exitCode, 0);
    assert.match(await readFile(join(root, "src", "add.cjs"), "utf8"), /a \+ b/);
    const before = [...calls];
    assert.equal((await createRunner().run()).status, "completed");
    assert.deepEqual(calls, before, "resume must not rerun accepted work");
    await new OperatorControl(graph, root).retry("worker");
    const final = await createRunner().run();
    assert.equal(final.status, "completed");
    assert.deepEqual(calls.slice(before.length), ["worker", "tester", "reviewer", "integrate"]);
    assert.equal(final.nodes["final-checks"]!.status, "accepted");
    assert.equal(final.nodes["final-checks"]!.attempts, 2);
    assert.deepEqual(JSON.parse(await readFile(join(runRoot, "evidence", "final-checks-attempt-1.json"), "utf8")), evidence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("damaged dependency evidence stops before dispatch without spending automatic retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-astra-damaged-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1, run: { id: "damaged", objective: "test resume", repository: ".", maxConcurrency: 1 },
    nodes: ["source", "consumer"].map((id) => ({
      id, type: "review", executor: "codex", prompt: id, needs: id === "consumer" ? ["source"] : [],
      owns: [], checks: [], maxAttempts: 3,
    })),
  };
  const calls: string[] = [];
  const createRunner = () => new GraphRunner(graph, root, { codex: {
    async execute(request) {
      calls.push(request.node.id);
      return { exitCode: 0, stdout: "", stderr: "", handoff: { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] } };
    },
  } });
  try {
    assert.equal((await createRunner().run()).status, "completed");
    await new OperatorControl(graph, root).retry("consumer");
    const path = join(root, ".agent-graph", "runs", graph.run.id, "evidence", "source-attempt-1.json");
    await writeFile(path, '{"truncated":');
    const state = await createRunner().run();
    assert.equal(state.status, "needs_attention");
    assert.equal(state.nodes.consumer!.attempts, 2);
    assert.equal(state.nodes.consumer!.generationAttempts, 1);
    assert.equal(state.nodes.consumer!.retryBlocked, true);
    assert.deepEqual(calls, ["source", "consumer"]);
    assert.equal((await createRunner().run()).status, "needs_attention");
    assert.deepEqual(calls, ["source", "consumer"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
