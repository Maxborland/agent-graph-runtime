import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAdapter,
  ExecutionEvidenceMismatchError,
} from "../src/adapters.js";
import { PassiveAdvisor } from "../src/advisor.js";
import { graphSchema } from "../src/cli-tools.js";
import { validateGraph } from "../src/graph.js";
import { buildExecutionPlan } from "../src/planner.js";
import { RunStore } from "../src/store.js";
import type { GraphDefinition, GraphNodeDefinition } from "../src/types.js";
import type { AgentAdapter } from "../src/adapters.js";

const node: GraphNodeDefinition = {
  id: "reasoning",
  type: "agent",
  executor: "codex",
  prompt: "Return a structured handoff",
  needs: [],
  owns: [],
  checks: [],
  maxAttempts: 1,
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
};

function graph(): GraphDefinition {
  return {
    version: 1,
    run: {
      id: "reasoning-effort",
      objective: "Pin execution settings",
      repository: ".",
      maxConcurrency: 1,
      semanticFailurePolicy: "finish-independent-read-only",
      advisor: { executor: "codex", model: "gpt-5.6-luna", reasoningEffort: "max" },
    },
    nodes: [{ ...node }],
  };
}

async function writeCodexFixture(root: string, body: string): Promise<string> {
  const path = join(root, "fake-codex.mjs");
  await writeFile(path, body, "utf8");
  return path;
}

function request(root: string, fake: string, candidate: GraphNodeDefinition = node) {
  return {
    node: candidate,
    repositoryRoot: root,
    prompt: "test prompt",
    artifactsDirectory: join(root, "artifacts"),
    timeoutMs: 10_000,
  };
}

test("Codex adapter pins effort immediately after exec and records live effective execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-reasoning-effort-"));
  const fake = await writeCodexFixture(root, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
writeFileSync(output, JSON.stringify({ status: "complete", summary: JSON.stringify(args), changedFiles: [], verification: [], gaps: [] }));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "11111111-2222-3333-4444-555555555555" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna", effort: "max" } }) + "\\n");
`);
  try {
    const result = await new CodexAdapter(process.execPath, [fake, "-c", 'model_reasoning_effort="low"']).execute(
      request(root, fake),
    );
    const args = JSON.parse(result.handoff.summary) as string[];
    const execIndex = args.indexOf("exec");
    assert.ok(execIndex >= 0);
    assert.deepEqual(args.slice(execIndex + 1, execIndex + 3), ["-c", 'model_reasoning_effort="max"']);
    assert.deepEqual(result.configuredExecution, { model: "gpt-5.6-luna", reasoningEffort: "max" });
    assert.deepEqual(result.observedExecution, {
      threadId: "11111111-2222-3333-4444-555555555555",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "artifacts", "reasoning.execution.json"), "utf8")),
      {
        configuredExecution: { model: "gpt-5.6-luna", reasoningEffort: "max" },
        observedExecution: {
          threadId: "11111111-2222-3333-4444-555555555555",
          model: "gpt-5.6-luna",
          reasoningEffort: "max",
        },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex adapter fails closed and preserves mismatch evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-reasoning-mismatch-"));
  const fake = await writeCodexFixture(root, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] }));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-luna", effort: "high" } }) + "\\n");
`);
  try {
    await assert.rejects(
      new CodexAdapter(process.execPath, [fake]).execute(request(root, fake)),
      (error: unknown) => {
        assert.ok(error instanceof ExecutionEvidenceMismatchError);
        assert.deepEqual(error.configuredExecution, { model: "gpt-5.6-luna", reasoningEffort: "max" });
        assert.equal(error.observedExecution.reasoningEffort, "high");
        return true;
      },
    );
    const evidence = JSON.parse(await readFile(join(root, "artifacts", "reasoning.execution.json"), "utf8")) as {
      configuredExecution: { reasoningEffort: string };
      observedExecution: { reasoningEffort: string };
    };
    assert.equal(evidence.configuredExecution.reasoningEffort, "max");
    assert.equal(evidence.observedExecution.reasoningEffort, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex adapter preserves exact thread identity when effective metadata is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-reasoning-unknown-"));
  const fake = await writeCodexFixture(root, `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] }));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "99999999-8888-7777-6666-555555555555" }) + "\\n");
`);
  try {
    const result = await new CodexAdapter(process.execPath, [fake]).execute(request(root, fake));
    assert.deepEqual(result.observedExecution, { threadId: "99999999-8888-7777-6666-555555555555" });
    assert.equal(result.configuredExecution?.reasoningEffort, "max");
    assert.equal("model" in (result.observedExecution ?? {}), false);
    assert.equal("reasoningEffort" in (result.observedExecution ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph validation and plan expose Codex effort and semantic failure policy", () => {
  const candidate = graph();
  assert.deepEqual(validateGraph(candidate).errors, []);
  const plan = buildExecutionPlan(candidate, "C:/repo");
  assert.equal(plan.semanticFailurePolicy, "finish-independent-read-only");
  assert.equal(plan.advisor?.reasoningEffort, "max");
  assert.equal(plan.waves[0]?.nodes[0]?.reasoningEffort, "max");
  assert.deepEqual(
    (graphSchema.properties.nodes.items.properties.reasoningEffort as { enum: readonly string[] }).enum,
    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );

  const invalidEffort = graph();
  (invalidEffort.nodes[0] as unknown as Record<string, unknown>).reasoningEffort = "extreme";
  const invalidProvider = graph();
  invalidProvider.nodes[0]!.executor = "claude";
  const invalidPolicy = graph();
  (invalidPolicy.run as unknown as Record<string, unknown>).semanticFailurePolicy = "continue";
  const errors = [
    ...validateGraph(invalidEffort).errors,
    ...validateGraph(invalidProvider).errors,
    ...validateGraph(invalidPolicy).errors,
  ].join("\n");
  assert.match(errors, /node "reasoning" reasoningEffort must be one of/);
  assert.match(errors, /node "reasoning" reasoningEffort is supported only for the Codex executor/);
  assert.match(errors, /run\.semanticFailurePolicy must be "stop" or "finish-independent-read-only"/);
});

test("passive advisor forwards Codex effort and records configured and observed execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-advisor-reasoning-"));
  const graphWithAdvisor = graph();
  let dispatchedNode: GraphNodeDefinition | undefined;
  const adapter: AgentAdapter = {
    async execute(request) {
      dispatchedNode = request.node;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        configuredExecution: { model: "gpt-5.6-luna", reasoningEffort: "max" },
        observedExecution: { threadId: "advisor-thread", model: "gpt-5.6-luna", reasoningEffort: "max" },
        handoff: { status: "complete", summary: "reviewed", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  try {
    (await import("node:child_process")).execFileSync("git", ["init", "--quiet"], { cwd: root });
    const store = await RunStore.open(root, graphWithAdvisor, []);
    store.state.nodes.reasoning!.status = "accepted";
    store.state.nodes.reasoning!.attempts = 1;
    await store.save("wave-finished");
    await new PassiveAdvisor(graphWithAdvisor, root, { codex: adapter }).reviewWave(store);
    assert.equal(dispatchedNode?.reasoningEffort, "max");
    const evidence = JSON.parse(await readFile(join(store.evidenceDirectory, "advisor-wave-1.json"), "utf8")) as {
      configuredExecution: { reasoningEffort: string };
      observedExecution: { reasoningEffort: string };
    };
    assert.equal(evidence.configuredExecution.reasoningEffort, "max");
    assert.equal(evidence.observedExecution.reasoningEffort, "max");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live thread identity survives stdout truncation and omitted effort leaves argv unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-effort-tail-"));
  const fake = await writeCodexFixture(root, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({status:'complete',summary:JSON.stringify(args),changedFiles:[],verification:[],gaps:[]}));
console.log(JSON.stringify({type:'thread.started',thread_id:'99999999-8888-7777-6666-555555555555'}));
console.log('x'.repeat(1200000));
`);
  try {
    const candidate = { ...node };
    delete candidate.reasoningEffort;
    const result = await new CodexAdapter(process.execPath, [fake]).execute(request(root, fake, candidate));
    assert.equal(result.stdout.includes("thread.started"), false);
    assert.deepEqual(result.observedExecution, { threadId: "99999999-8888-7777-6666-555555555555" });
    const args = JSON.parse(result.handoff.summary) as string[];
    assert.equal(args.some(arg => arg.includes("model_reasoning_effort")), false);
    assert.ok(args.includes('approval_policy="never"'));
    assert.deepEqual(result.configuredExecution, { model: "gpt-5.6-luna" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("effort is rejected on non-dispatched nodes and non-Codex advisors", () => {
  for (const type of ["verify", "human_gate"] as const) {
    const candidate = graph();
    candidate.nodes[0]!.type = type;
    assert.match(validateGraph(candidate).errors.join("\n"), /requires a dispatched Codex node/);
  }
  for (const executor of ["claude", "claudex"] as const) {
    const candidate = graph();
    candidate.run.advisor!.executor = executor;
    assert.match(validateGraph(candidate).errors.join("\n"), /reasoningEffort is supported only for the Codex executor/);
  }
});

test("runner preserves mismatch metadata and does not automatically retry a wrong effective model", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-effort-runner-mismatch-"));
  (await import("node:child_process")).execFileSync("git", ["init", "--quiet"], { cwd: root });
  const candidate = graph();
  delete candidate.run.advisor;
  candidate.nodes[0]!.maxAttempts = 3;
  let calls = 0;
  const adapter: AgentAdapter = { async execute() {
    calls++;
    throw new ExecutionEvidenceMismatchError("effective model mismatch", { model: "gpt-5.6-luna", reasoningEffort: "max" },
      { threadId: "fixture", model: "different-model", reasoningEffort: "max" });
  } };
  try {
    const { GraphRunner } = await import("../src/runner.js");
    const state = await new GraphRunner(candidate, root, { codex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.equal(calls, 1);
    const evidence = JSON.parse(await readFile(join(root, ".agent-graph/runs/reasoning-effort", state.nodes.reasoning!.evidenceFiles[0]!), "utf8"));
    assert.equal(evidence.observedExecution.model, "different-model");
    assert.equal(evidence.configuredExecution.model, "gpt-5.6-luna");
    assert.equal(evidence.retryBlocked, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("session mismatch blocks retry even when the final handoff file is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-session-missing-handoff-"));
  const fake = await writeCodexFixture(root, `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const id = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";
const timestamp = new Date().toISOString();
const directory = join(process.env.CODEX_HOME, "sessions", ...timestamp.slice(0, 10).split("-"));
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, "rollout-test-" + id + ".jsonl"), [
  { type: "session_meta", timestamp, payload: { id, cwd: process.cwd(), timestamp } },
  { type: "turn_context", timestamp, payload: { cwd: process.cwd(), model: "gpt-5.6-luna", effort: "high" } }
].map(value => JSON.stringify(value)).join("\\n") + "\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
`);
  try {
    await assert.rejects(new CodexAdapter(process.execPath, [fake]).execute({
      ...request(root, fake), environment: { CODEX_HOME: join(root, "codex-home") },
    }), (error: unknown) => {
      assert.ok(error instanceof ExecutionEvidenceMismatchError);
      assert.equal(error.observedExecution.reasoningEffort, "high");
      return true;
    });
    const evidence = JSON.parse(await readFile(join(root, "artifacts/reasoning.execution.json"), "utf8"));
    assert.equal(evidence.observedExecution.reasoningEffort, "high");
  } finally { await rm(root, { recursive: true, force: true }); }
});
