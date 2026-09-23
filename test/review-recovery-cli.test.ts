import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createInitialState } from "../src/state.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);
const cli = resolve("dist/src/cli.js");

async function fixture(id: string) {
  const root = await mkdtemp(join(tmpdir(), "agr-review-cli-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id, objective: "synthetic recovery journey", repository: ".", maxConcurrency: 1 },
    nodes: [{ id: "verify", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  const graphPath = join(root, "graph.json");
  const saveGraph = () => writeFile(graphPath, JSON.stringify(graph));
  await saveGraph();
  return { root, graph, graphPath, saveGraph, runRoot: join(root, ".agent-graph", "runs", id) };
}

async function invoke(root: string, args: string[], expectedCode = 0) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(expectedCode, 0, "command should have failed");
    return result;
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, expectedCode, failure.stderr);
    return { stdout: failure.stdout, stderr: failure.stderr };
  }
}

test("CLI rejects unsafe IDs and shell agent nodes before executing commands", async () => {
  const f = await fixture("invalid-input");
  try {
    for (const id of ["../escape", "nested/run", "nested\\run"]) {
      f.graph.run.id = id;
      await f.saveGraph();
      const result = await invoke(f.root, ["run", f.graphPath, "--json"], 3);
      assert.match(result.stdout, /id/i);
    }
    f.graph.run.id = "invalid-input";
    Object.assign(f.graph.nodes[0]!, { type: "agent", executor: "shell", prompt: "invalid", checks: ["echo SHOULD_NOT_EXECUTE"] });
    await f.saveGraph();
    const result = await invoke(f.root, ["run", f.graphPath, "--json"], 3);
    assert.match(result.stdout, /executor|shell/i);
    await assert.rejects(readFile(join(f.runRoot, "state.json")), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI resumes a legacy run and follows its original cursor without rewriting history", async () => {
  const f = await fixture("legacy-resume");
  try {
    await mkdir(f.runRoot, { recursive: true });
    const initial = createInitialState(f.graph, []);
    const original = JSON.stringify({ at: initial.createdAt, type: "state_saved", detail: "legacy fixture" }) + "\n";
    await writeFile(join(f.runRoot, "state.json"), JSON.stringify(initial));
    await writeFile(join(f.runRoot, "events.jsonl"), original);
    await invoke(f.root, ["run", f.graphPath]);
    const result = await invoke(f.root, ["follow", f.graphPath, "--after", "1", "--format", "jsonl"]);
    const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { seq: number; type: string });
    assert(events.every((event) => event.seq > 1));
    assert.equal(events.at(-1)?.type, "run_completed");
    assert((await readFile(join(f.runRoot, "events.jsonl"), "utf8")).startsWith(original));
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI why gives an actionable explicit retry after exhausting attempts", async () => {
  const f = await fixture("retry-advice");
  try {
    const checkPath = join(f.root, "check.cjs");
    await writeFile(checkPath, "process.exit(1);\n");
    f.graph.nodes[0]!.checks = [`${JSON.stringify(process.execPath)} ${JSON.stringify(checkPath)}`];
    await f.saveGraph();
    await invoke(f.root, ["run", f.graphPath], 1);
    const explanation = JSON.parse((await invoke(f.root, ["why", f.graphPath, "--json"])).stdout) as {
      issues: Array<{ nextAction: string }>;
    };
    assert(explanation.issues.some((issue) => /agr retry.*verify/.test(issue.nextAction)));
    await writeFile(checkPath, "process.exit(0);\n");
    await invoke(f.root, ["retry", "verify", f.graphPath]);
    const state = JSON.parse((await invoke(f.root, ["run", f.graphPath, "--json"])).stdout) as {
      status: string; nodes: Record<string, { attempts: number; status: string }>;
    };
    assert.equal(state.status, "completed");
    assert.equal(state.nodes.verify?.status, "accepted");
    assert.equal(state.nodes.verify?.attempts, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI follow exits on a missing owner and run recovers an abandoned local guard", async () => {
  const f = await fixture("owner-recovery");
  try {
    await mkdir(f.runRoot, { recursive: true });
    const initial = createInitialState(f.graph, []);
    initial.status = "running";
    await writeFile(join(f.runRoot, "state.json"), JSON.stringify(initial));
    await writeFile(join(f.runRoot, "events.jsonl"), "");
    const follow = await invoke(f.root, ["follow", f.graphPath, "--interval-ms", "10"], 1);
    assert.match(follow.stderr, /no live owner|owner.*missing/i);
    // The subprocess has exited, so this is a demonstrably dead local PID.
    const pid = Number((await exec(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" })).stdout.trim());
    await writeFile(join(f.runRoot, ".run.lock.recovery"), JSON.stringify({
      token: "synthetic-dead-guard", pid, host: hostname(), startedAt: new Date().toISOString(),
    }));
    const resumed = JSON.parse((await invoke(f.root, ["run", f.graphPath, "--json"])).stdout) as { status: string };
    assert.equal(resumed.status, "completed");
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI inspect distinguishes completed execution from pending wave acceptance", async () => {
  const f = await fixture("pending-acceptance");
  const release = join(f.root, ".agent-graph", "release-fixture");
  const script = join(f.root, "slow.cjs");
  await mkdir(join(f.root, ".agent-graph"), { recursive: true });
  await writeFile(script, `const fs=require('node:fs');const deadline=Date.now()+10000;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})||Date.now()>deadline)clearInterval(timer);},20);`);
  f.graph.run.maxConcurrency = 2;
  f.graph.nodes.push({
    id: "slow", type: "verify", needs: [], owns: [],
    checks: [`${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`], maxAttempts: 1,
  });
  await f.saveGraph();
  const child = spawn(process.execPath, [cli, "run", f.graphPath, "--json"], { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (value: string) => { output += value; });
  child.stderr.resume();
  const finished = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
  try {
    const deadline = Date.now() + 5_000;
    let observed = false;
    while (!observed && Date.now() < deadline) {
      const events = await readFile(join(f.runRoot, "events.jsonl"), "utf8").catch(() => "");
      observed = events.split(/\r?\n/).slice(0, -1).filter(Boolean).some((line) => {
        const event = JSON.parse(line) as { type: string; nodeId?: string };
        return event.type === "node_execution_finished" && event.nodeId === "verify";
      });
      if (!observed) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert(observed, "fast executor must publish completion before slow peer ends");
    const inspection = JSON.parse((await invoke(f.root, ["inspect", f.graphPath, "--json"])).stdout) as {
      activeNodes: Array<{ id: string }>; pendingAcceptanceNodes: Array<{ id: string }>;
    };
    assert.deepEqual(inspection.activeNodes.map((node) => node.id), ["slow"]);
    assert.deepEqual(inspection.pendingAcceptanceNodes.map((node) => node.id), ["verify"]);
    const human = await invoke(f.root, ["inspect", f.graphPath]);
    assert.match(human.stdout, /verify: execution finished.*awaiting acceptance/);
    await writeFile(release, "release");
    assert.equal(await finished, 0);
    assert.equal((JSON.parse(output) as { status: string }).status, "completed");
  } finally {
    await writeFile(release, "release");
    await finished;
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
