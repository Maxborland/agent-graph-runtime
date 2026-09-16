import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentAdapter } from "../src/adapters.js";
import { buildDependencyContext } from "../src/dependency-context.js";
import { readRunLogs } from "../src/cli-tools.js";
import { GraphRunner } from "../src/runner.js";
import { OperatorControl } from "../src/operator-control.js";
import { RunStore, writeImmutableArtifact } from "../src/store.js";
import type { GraphDefinition, RunState } from "../src/types.js";

const exec = promisify(execFile);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "agr-retry-history-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function graph(): GraphDefinition {
  return { version: 1, run: { id: "history", objective: "Preserve historical evidence", repository: ".", maxConcurrency: 1 }, nodes: [
    { id: "source", type: "review", executor: "codex", prompt: "Source", needs: [], owns: [], checks: [], maxAttempts: 1 },
    { id: "consumer", type: "review", executor: "codex", prompt: "Consume only current evidence", needs: ["source"], owns: [], checks: [], maxAttempts: 1 },
    { id: "checks", type: "verify", needs: ["consumer"], owns: [], checks: [`${JSON.stringify(process.execPath)} -e "console.log('check-evidence')"`], maxAttempts: 1 },
    { id: "independent", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
  ] };
}
async function artifacts(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.set(full, await readFile(full));
    }
  }
  for (const kind of ["prompts", "outputs", "evidence"]) await walk(join(root, ".agent-graph/runs/history", kind));
  return files;
}
async function unchanged(snapshot: Map<string, Buffer>) {
  for (const [path, bytes] of snapshot) assert.deepEqual(await readFile(path), bytes, path);
}

for (const first of ["complete", "blocked", "failed", "cancelled"] as const) {
  test(`repeated manual retries preserve ${first} artifacts and current descendant context`, async () => fixture(async (root) => {
    const g = graph();
    let generation = 1;
    const controller = new AbortController();
    const adapter: AgentAdapter = { async execute(request) {
      const value = `generation-${generation}`;
      await writeFile(join(request.artifactsDirectory, `${request.node.id}.codex.stdout.jsonl`), `${value}: stdout\n`);
      await writeFile(join(request.artifactsDirectory, `${request.node.id}.codex.stderr.txt`), `${value}: stderr\n`);
      if (request.node.id === "consumer") {
        assert.match(request.prompt, new RegExp(value));
        for (let prior = 1; prior < generation; prior++) assert.equal(request.prompt.includes(`generation-${prior}`), false);
      }
      if (generation === 1 && first === "failed") throw new Error("known failed execution");
      if (generation === 1 && first === "cancelled") controller.abort();
      const handoff = { status: generation === 1 && first === "blocked" ? "blocked" as const : "complete" as const,
        summary: value, changedFiles: [], verification: [value], gaps: [] };
      await writeFile(join(request.artifactsDirectory, `${request.node.id}.codex.json`), JSON.stringify(handoff));
      return { exitCode: 0, stdout: value, stderr: "", handoff };
    } };
    const initial = await new GraphRunner(g, root, { codex: adapter }, { signal: controller.signal }).run();
    assert.equal(initial.status, first === "complete" ? "completed" : first === "blocked" ? "needs_attention" : first);
    const original = await artifacts(root);
    assert.ok(original.size >= 4);
    for (generation = 2; generation <= 3; generation++) {
      const reset = await new OperatorControl(g, root).retry("source");
      assert.equal(reset.nodes.source!.attempts, generation - 1);
      assert.equal(reset.nodes.source!.generationAttempts, 0);
      assert.equal(reset.nodes.source!.acceptedAttempt, undefined);
      const state = await new GraphRunner(g, root, { codex: adapter }).run();
      assert.equal(state.status, "completed");
      assert.equal(state.nodes.source!.attempts, generation);
      assert.equal(state.nodes.source!.generationAttempts, 1);
      assert.equal(state.nodes.source!.evidenceFiles.length, generation);
      assert.equal(state.nodes.consumer!.acceptedAttempt, first === "complete" ? generation : generation - 1);
      assert.equal(state.nodes.independent!.attempts, 1);
      await unchanged(original);
      for (const [path, bytes] of await artifacts(root)) original.set(path, bytes);
    }
    const logs = await readRunLogs(root, "history", "source");
    for (const generation of [1, 2, 3]) assert.ok(logs.some(log => log.content.includes(`generation-${generation}: stdout`)));
  }));
}

test("manual retry renews a bounded automatic budget while lifetime identities increase", async () => fixture(async (root) => {
  const g = graph();
  g.nodes = [{ id: "checks", type: "verify", needs: [], owns: [], maxAttempts: 2,
    checks: [`${JSON.stringify(process.execPath)} -e "console.log('failure-evidence');process.exit(1)"`] }];
  let state = await new GraphRunner(g, root, {}).run();
  assert.equal(state.status, "failed");
  assert.equal(state.nodes.checks!.attempts, 2);
  const original = await artifacts(root);
  await new OperatorControl(g, root).retry("checks");
  state = await new GraphRunner(g, root, {}).run();
  assert.equal(state.status, "failed");
  assert.equal(state.nodes.checks!.attempts, 4);
  assert.equal(state.nodes.checks!.generationAttempts, 2);
  assert.equal((await new GraphRunner(g, root, {}).run()).nodes.checks!.attempts, 4);
  await unchanged(original);
}));

test("legacy orphan high water preserves accepted dependency identity then allocates above history", async () => fixture(async (root) => {
  const g = graph();
  g.nodes = [g.nodes[0]!, g.nodes[1]!];
  const adapter: AgentAdapter = { async execute(request) {
    return { exitCode: 0, stdout: "", stderr: "", handoff: { status: "complete" as const,
      summary: `accepted-${request.node.id}`, changedFiles: [], verification: [], gaps: [] } };
  } };
  await new GraphRunner(g, root, { codex: adapter }).run();
  const runRoot = join(root, ".agent-graph/runs/history");
  await mkdir(join(runRoot, "outputs/source-attempt-7"));
  await writeFile(join(runRoot, "outputs/source-attempt-7/orphan.stdout.txt"), "historical raw output");
  await writeFile(join(runRoot, "prompts/source-attempt-8.md"), "historical prompt");
  await writeFile(join(runRoot, "evidence/source-attempt-9.json"), "historical failed evidence");
  const store = await RunStore.open(root, g, []);
  await store.appendEvent({ at: new Date().toISOString(), type: "node_started", nodeId: "source", detail: "attempt 10" });
  const legacy = JSON.parse(await readFile(store.statePath, "utf8")) as RunState;
  legacy.nodes.source!.attempts = 1;
  delete legacy.nodes.source!.generationAttempts;
  delete legacy.nodes.source!.attemptHighWater;
  delete legacy.nodes.source!.acceptedAttempt;
  await writeFile(store.statePath, JSON.stringify(legacy));
  const recovered = await RunStore.open(root, g, []);
  assert.equal(recovered.state.nodes.source!.attempts, 10);
  assert.equal(recovered.state.nodes.source!.acceptedAttempt, 1);
  assert.equal(recovered.state.nodes.source!.generationAttempts, 1);
  assert.match(await buildDependencyContext(g.nodes[1]!, recovered), /accepted attempt 1/);
  const original = await artifacts(root);
  await new OperatorControl(g, root).retry("source");
  const state = await new GraphRunner(g, root, { codex: adapter }).run();
  assert.equal(state.status, "completed");
  assert.equal(state.nodes.source!.attempts, 11);
  assert.equal(state.nodes.source!.acceptedAttempt, 11);
  await unchanged(original);
}));

test("legacy reset counter zero cannot overwrite old artifacts", async () => fixture(async (root) => {
  const g = graph();
  g.nodes = [{ id: "source", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }];
  const store = await RunStore.open(root, g, []);
  const legacy = store.state;
  delete legacy.nodes.source!.generationAttempts;
  delete legacy.nodes.source!.attemptHighWater;
  await writeFile(store.statePath, JSON.stringify(legacy));
  await writeFile(join(store.promptsDirectory, "source-attempt-7.md"), "old prompt");
  await mkdir(join(store.outputsDirectory, "source-attempt-7"));
  await writeFile(join(store.outputsDirectory, "source-attempt-7/raw.stdout.txt"), "old raw output");
  await writeFile(join(store.evidenceDirectory, "source-attempt-7.json"), "old evidence");
  const original = await artifacts(root);
  const state = await new GraphRunner(g, root, {}).run();
  assert.equal(state.status, "completed");
  assert.equal(state.nodes.source!.attempts, 8);
  assert.equal(state.nodes.source!.generationAttempts, 1);
  await unchanged(original);
}));

test("conflicting immutable evidence is refused without changing bytes", async () => fixture(async (root) => {
  const path = join(root, "evidence.json");
  await writeImmutableArtifact(path, "first");
  await writeImmutableArtifact(path, "first");
  await assert.rejects(writeImmutableArtifact(path, "second"), /immutable run artifact/);
  assert.equal(await readFile(path, "utf8"), "first");
}));

test("dependency prompt is published once with its final content", async (t) => fixture(async (root) => {
  const fsPromises = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const promptPath = join(root, ".agent-graph/runs/history/prompts/consumer-attempt-1.md");
  const publications: string[] = [];
  const originalWrite = fsPromises.writeFile;
  t.mock.method(fsPromises, "writeFile", async (...args: Parameters<typeof originalWrite>) => {
    if (String(args[0]) === promptPath) publications.push(String(args[1]));
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  let dispatchedPrompt = "";
  const adapter: AgentAdapter = { async execute(request) {
    if (request.node.id === "consumer") dispatchedPrompt = request.prompt;
    return { exitCode: 0, stdout: "", stderr: "", handoff: {
      status: "complete", summary: "accepted source context", changedFiles: [], verification: [], gaps: [],
    } };
  } };
  try {
    assert.equal((await new GraphRunner(graph(), root, { codex: adapter }).run()).status, "completed");
    assert.equal(publications.length, 1, "a published prompt must never be replaced");
    assert.match(publications[0]!, /Dependency source \(accepted attempt 1\)/);
    assert.equal(publications[0], dispatchedPrompt);
    assert.equal(await readFile(promptPath, "utf8"), dispatchedPrompt);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}));
