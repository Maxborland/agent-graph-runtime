import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { NonRetryableAdapterError, type AgentAdapter } from "../src/adapters.js";
import { OperatorControl } from "../src/operator-control.js";
import { sendNodeProgress } from "../src/node-progress.js";
import { sha256 } from "../src/persistence.js";
import { GraphRunner } from "../src/runner.js";
import type { AdapterRequest, GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("runner executes dependencies through adapters and accepts verified nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });

  const calls: string[] = [];
  const adapter: AgentAdapter = {
    async execute(request: AdapterRequest) {
      calls.push(request.node.id);
      const relative = request.node.id === "contract" ? "docs/contract.md" : "src/api.ts";
      await mkdir(join(root, relative.split("/")[0]!), { recursive: true });
      await writeFile(join(root, relative), `${request.node.id}\n`);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: "complete",
          summary: `${request.node.id} done`,
          changedFiles: [relative],
          verification: [],
          gaps: [],
        },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "runner-fixture",
      objective: "Build a contract then an API",
      repository: ".",
      maxConcurrency: 1,
    },
    nodes: [
      {
        id: "contract",
        type: "agent",
        executor: "codex",
        prompt: "contract",
        needs: [],
        owns: ["docs/**"],
        checks: [],
        maxAttempts: 1,
      },
      {
        id: "api",
        type: "agent",
        executor: "claude",
        prompt: "api",
        needs: ["contract"],
        owns: ["src/**"],
        checks: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
        maxAttempts: 1,
      },
    ],
  };

  try {
    const runner = new GraphRunner(graph, root, { codex: adapter, claude: adapter });
    const state = await runner.run();

    assert.equal(state.status, "completed");
    assert.equal(state.nodes.contract!.status, "accepted");
    assert.equal(state.nodes.api!.status, "accepted");
    assert.deepEqual(calls, ["contract", "api"]);
    assert.equal(state.nodes.api!.evidenceFiles.length, 1);
    const report = await readFile(
      join(root, ".agent-graph", "runs", "runner-fixture", "report.md"),
      "utf8",
    );
    assert.match(report, /Run status: completed/);
    assert.match(report, /contract \| accepted/);
    assert.match(report, /api \| accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner dispatches a read-only advisor after each wave and injects its note", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-advisor-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-fixture",
      objective: "Implement with passive independent advice",
      repository: ".",
      maxConcurrency: 1,
      advisor: {
        executor: "codex",
        model: "gpt-5.6-sol",
        instructions: "Watch architecture and evidence quality.",
      },
    },
    nodes: [
      { id: "first", type: "agent", executor: "codex", prompt: "first", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "second", type: "agent", executor: "codex", prompt: "second", needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const calls: Array<{ id: string; type: string; model?: string; prompt: string }> = [];
  const adapter: AgentAdapter = {
    async execute(request) {
      calls.push({
        id: request.node.id,
        type: request.node.type,
        ...(request.node.model === undefined ? {} : { model: request.node.model }),
        prompt: request.prompt,
      });
      const advisor = request.node.id.startsWith("__advisor-wave-");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: "complete",
          summary: advisor ? `wave ${request.node.id.at(-1)} architecture note` : `${request.node.id} done`,
          changedFiles: [],
          verification: [],
          gaps: [],
        },
      };
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "completed");
    assert.deepEqual(calls.map((call) => call.id), ["first", "__advisor-wave-1", "second", "__advisor-wave-2"]);
    assert.equal(calls[1]?.type, "review");
    assert.equal(calls[1]?.model, "gpt-5.6-sol");
    assert.match(calls[1]?.prompt ?? "", /Watch architecture and evidence quality/);
    assert.match(calls[1]?.prompt ?? "", /"type": "node_accepted"/);
    assert.match(calls[2]?.prompt ?? "", /Non-authoritative advisor note.*wave 1 architecture note/s);
    const runRoot = join(root, ".agent-graph", "runs", graph.run.id);
    await readFile(join(runRoot, "evidence", "advisor-wave-1.json"), "utf8");
    await readFile(join(runRoot, "evidence", "advisor-wave-2.json"), "utf8");
    const events = await readFile(join(runRoot, "events.jsonl"), "utf8");
    assert.equal((events.match(/"type":"advisor_note"/g) ?? []).length, 2);
    const report = await readFile(join(runRoot, "report.md"), "utf8");
    assert.match(report, /Advisor: note/);
    assert.match(report, /wave 2 architecture note/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisor blocker stops before the next wave without consuming a node attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-advisor-blocker-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-blocker",
      objective: "Stop on independent hard blockers",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex" },
    },
    nodes: [
      { id: "first", type: "agent", executor: "codex", prompt: "first", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "second", type: "agent", executor: "codex", prompt: "second", needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    async execute(request) {
      calls.push(request.node.id);
      const advisor = request.node.id.startsWith("__advisor-wave-");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: advisor ? "blocked" : "complete",
          summary: advisor ? "Public contract regression must be resolved" : "done",
          changedFiles: [],
          verification: [],
          gaps: advisor ? ["contract mismatch"] : [],
        },
      };
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.deepEqual(calls, ["first", "__advisor-wave-1"]);
    assert.equal(state.nodes.first?.status, "accepted");
    assert.equal(state.nodes.first?.attempts, 1);
    assert.equal(state.nodes.second?.status, "pending");
    assert.equal(state.nodes.second?.attempts, 0);
    assert.equal(state.advisor?.blocker?.severity, "blocker");
    assert.match(state.advisor?.blocker?.summary ?? "", /Public contract regression/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisor write outside runtime artifacts fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-advisor-write-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-write",
      objective: "Keep passive advice read-only",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex", stopOnBlocker: false },
    },
    nodes: [
      { id: "first", type: "agent", executor: "codex", prompt: "first", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "second", type: "agent", executor: "codex", prompt: "second", needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    async execute(request) {
      calls.push(request.node.id);
      if (request.node.id.startsWith("__advisor-wave-")) await writeFile(join(root, "advisor-escape.txt"), "unsafe\n");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.deepEqual(calls, ["first", "__advisor-wave-1"]);
    assert.equal(state.nodes.second?.attempts, 0);
    assert.match(state.advisor?.blocker?.summary ?? "", /advisor-escape\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary advisor failure is recorded without stalling primary execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-advisor-failure-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-failure",
      objective: "Continue when optional advice is unavailable",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex" },
    },
    nodes: [
      { id: "first", type: "agent", executor: "codex", prompt: "first", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "second", type: "agent", executor: "codex", prompt: "second", needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    async execute(request) {
      calls.push(request.node.id);
      if (request.node.id.startsWith("__advisor-wave-")) throw new Error("advisor provider unavailable");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "completed");
    assert.deepEqual(calls, ["first", "__advisor-wave-1", "second", "__advisor-wave-2"]);
    assert.equal(state.advisor?.blocker, undefined);
    const events = await readFile(join(root, ".agent-graph", "runs", graph.run.id, "events.jsonl"), "utf8");
    assert.equal((events.match(/"type":"advisor_failed"/g) ?? []).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfirmed advisor termination blocks the next wave", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-advisor-termination-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-termination",
      objective: "Do not overlap an uncertain advisor process",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex", stopOnBlocker: false },
    },
    nodes: [
      { id: "first", type: "agent", executor: "codex", prompt: "first", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "second", type: "agent", executor: "codex", prompt: "second", needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    async execute(request) {
      calls.push(request.node.id);
      if (request.node.id.startsWith("__advisor-wave-")) {
        throw new NonRetryableAdapterError("failed to terminate advisor process tree");
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.deepEqual(calls, ["first", "__advisor-wave-1"]);
    assert.equal(state.nodes.second?.attempts, 0);
    assert.match(state.advisor?.blocker?.summary ?? "", /failed to terminate advisor process tree/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner executes independent ownership sets concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-parallel-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  let active = 0;
  let maxActive = 0;
  const adapter: AgentAdapter = {
    async execute(request) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      const relative = `${request.node.id}/result.txt`;
      await mkdir(join(root, request.node.id), { recursive: true });
      await writeFile(join(root, relative), "done\n");
      active -= 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: "complete",
          summary: "done",
          changedFiles: [relative],
          verification: [],
          gaps: [],
        },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "parallel-fixture", objective: "parallel", repository: ".", maxConcurrency: 2 },
    nodes: ["one", "two"].map((id) => ({
      id,
      type: "agent" as const,
      executor: "codex" as const,
      prompt: id,
      needs: [],
      owns: [`${id}/**`],
      checks: [],
      maxAttempts: 1,
    })),
  };
  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "completed");
    assert.equal(maxActive, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeats report only nodes that remain active", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-heartbeat-active-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "heartbeat-active", objective: "heartbeat", repository: ".", maxConcurrency: 2 },
    nodes: [
      { id: "fast", type: "verify", needs: [], owns: [], checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 100)"`], maxAttempts: 1 },
      { id: "slow", type: "verify", needs: [], owns: [], checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 400)"`], maxAttempts: 1 },
    ],
  };
  const heartbeats: string[][] = [];
  try {
    const state = await new GraphRunner(graph, root, {}, {
      heartbeatMs: 50,
      onProgress: (event) => {
        if (event.type === "heartbeat") heartbeats.push(event.activeNodeIds ?? []);
      },
    }).run();
    assert.equal(state.status, "completed");
    assert.ok(heartbeats.some((active) => active.length === 1 && active[0] === "slow"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runner forwards safe adapter activity with the owning node identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-activity-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "runner-activity", objective: "show activity", repository: ".", maxConcurrency: 1 },
    nodes: [{ id: "agent", type: "agent", executor: "claudex", prompt: "work directly", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  const events: Array<{ type: string; nodeId?: string; detail?: string }> = [];
  let dispatchedPrompt = "";
  const adapter: AgentAdapter = {
    async execute(request) {
      dispatchedPrompt = request.prompt;
      request.onActivity?.("Claudex assistant:tool_use");
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }, {
      onProgress: (event) => events.push(event),
    }).run();
    assert.equal(state.status, "completed");
    assert.ok(events.some((event) => event.type === "node_activity" && event.nodeId === "agent" && event.detail === "Claudex assistant:tool_use"));
    const persistedEvents = (await readFile(
      join(root, ".agent-graph", "runs", graph.run.id, "events.jsonl"),
      "utf8",
    )).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; detail?: string });
    assert.ok(persistedEvents.some((event) => event.type === "node_activity" && event.detail === "Claudex assistant:tool_use"));
    assert.ok(persistedEvents.some((event) => event.type === "run_completed"));
    assert.match(dispatchedPrompt, /Do not launch Workflow, Task, subagents/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable failure events do not expose provider errors or check commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-safe-failure-event-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "safe-failure-event", objective: "keep event stream safe", repository: ".", maxConcurrency: 1 },
    nodes: [{
      id: "agent",
      type: "agent",
      executor: "codex",
      prompt: "fail safely",
      needs: [],
      owns: [],
      checks: [],
      maxAttempts: 1,
    }],
  };
  const adapter: AgentAdapter = {
    async execute() {
      throw new Error("SENSITIVE_PROVIDER_RESULT should stay in evidence");
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "failed");
    const runRoot = join(root, ".agent-graph", "runs", graph.run.id);
    const events = await readFile(join(runRoot, "events.jsonl"), "utf8");
    assert.match(events, /"type":"node_failed"/);
    assert.doesNotMatch(events, /SENSITIVE_PROVIDER_RESULT/);
    assert.match(await readFile(join(runRoot, state.nodes.agent!.evidenceFiles.at(-1)!), "utf8"), /SENSITIVE_PROVIDER_RESULT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner streams, persists, and repeats an authenticated node milestone in heartbeats", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-runner-reported-progress-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "reported-progress", objective: "show real node progress", repository: ".", maxConcurrency: 1 },
    nodes: [{ id: "agent", type: "agent", executor: "claudex", prompt: "work directly", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  const events: Array<Record<string, unknown>> = [];
  const adapter: AgentAdapter = {
    async execute(request) {
      const environment = (request as AdapterRequest & { environment?: NodeJS.ProcessEnv }).environment;
      assert.ok(environment?.AGR_PROGRESS_ENDPOINT);
      assert.ok(environment.AGR_PROGRESS_TOKEN);
      await sendNodeProgress(environment.AGR_PROGRESS_ENDPOINT, {
        token: environment.AGR_PROGRESS_TOKEN,
        runId: environment.AGR_RUN_ID ?? "",
        nodeId: environment.AGR_NODE_ID ?? "",
        phase: "verify",
        message: "13 of 14 browser gates passed",
        percent: 93,
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }, {
      heartbeatMs: 40,
      onProgress: (event) => events.push(event as unknown as Record<string, unknown>),
    }).run();
    assert.equal(state.status, "completed");
    assert.ok(events.some((event) =>
      event.type === "node_progress" &&
      event.nodeId === "agent" &&
      event.phase === "verify" &&
      event.detail === "13 of 14 browser gates passed" &&
      event.percent === 93
    ));
    assert.ok(events.some((event) => {
      if (event.type !== "heartbeat") return false;
      const latest = event.latestNodeProgress as Record<string, Record<string, unknown>> | undefined;
      return latest?.agent?.phase === "verify" && latest.agent.percent === 93;
    }));
    const persisted = await readFile(join(root, ".agent-graph", "runs", graph.run.id, "events.jsonl"), "utf8");
    assert.match(persisted, /"type":"node_progress"/);
    assert.match(persisted, /13 of 14 browser gates passed/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runner accepts a verify-only node without an agent handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-verify-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "verify-fixture", objective: "verify", repository: ".", maxConcurrency: 1 },
    nodes: [
      {
        id: "checks",
        type: "verify",
        needs: [],
        owns: [],
        checks: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
        maxAttempts: 1,
      },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, {}).run();
    assert.equal(state.status, "completed");
    assert.equal(state.nodes.checks!.status, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner binds immutable hashed evidence to the unique current attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-attempt-evidence-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "attempt-evidence", objective: "bind evidence", repository: ".", maxConcurrency: 1 },
    nodes: [{
      id: "checks",
      type: "verify",
      needs: [],
      owns: [],
      checks: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`],
      maxAttempts: 1,
    }],
  };

  try {
    const state = await new GraphRunner(graph, root, {}).run();
    const attemptId = state.nodes.checks!.currentAttemptId!;
    const attempt = state.attempts[attemptId]!;
    assert.equal(attempt.status, "accepted");
    assert.equal(attempt.evidence.length, 1);
    const evidence = attempt.evidence[0]!;
    assert.equal(evidence.producerAttemptId, attemptId);
    assert.match(evidence.localPath, new RegExp(`${attemptId}\\.json$`));
    const raw = await readFile(join(root, ".agent-graph", "runs", graph.run.id, evidence.localPath));
    assert.equal(evidence.size, raw.byteLength);
    assert.equal(evidence.sha256, sha256(raw));
    const document = JSON.parse(raw.toString("utf8")) as {
      schemaVersion?: number;
      attemptId?: string;
      ordinal?: number;
    };
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.attemptId, attemptId);
    assert.equal(document.ordinal, 1);
    const report = await readFile(
      join(root, ".agent-graph", "runs", graph.run.id, "report.md"),
      "utf8",
    );
    assert.match(report, /Attempt history/);
    assert.match(report, new RegExp(attemptId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner never executes an external action when graph opt-in is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-external-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const marker = join(root, "external-action-ran.txt");
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "external-fixture", objective: "guard", repository: ".", maxConcurrency: 1 },
    nodes: [
      {
        id: "approval",
        type: "human_gate",
        target: "publish:fixture",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 1,
      },
      {
        id: "external",
        type: "external_action",
        executor: "shell",
        target: "publish:fixture",
        needs: ["approval"],
        owns: [],
        checks: [
          `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('external-action-ran.txt','yes')"`,
        ],
        maxAttempts: 1,
      },
    ],
  };

  try {
    const runner = new GraphRunner(graph, root, {});
    assert.equal((await runner.run()).status, "awaiting_approval");
    await new OperatorControl(graph, root).approve("approval", "publish:fixture");
    const state = await runner.run();
    assert.equal(state.status, "failed");
    await assert.rejects(access(marker));
    assert.match(state.nodes.external!.lastError ?? "", /external actions are disabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner rejects a Claudex node missing required model usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-model-usage-missing-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const adapter: AgentAdapter = {
    async execute() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: "complete",
          summary: "claimed Luna execution",
          changedFiles: [],
          verification: ["LUNA_OK"],
          gaps: [],
        },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "model-usage-missing", objective: "prove routing", repository: ".", maxConcurrency: 1 },
    nodes: [
      {
        id: "review",
        type: "review",
        executor: "claudex",
        prompt: "use Luna",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 1,
        requiredModelUsage: [
          { model: "gpt-5.6-luna", provider: "firstParty", contextWindow: 262144 },
        ],
      },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }).run();
    assert.equal(state.status, "failed");
    assert.equal(state.nodes.review!.status, "failed");
    assert.match(state.nodes.review!.lastError ?? "", /missing required model usage: gpt-5\.6-luna/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner accepts and persists matching required model usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-model-usage-match-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const adapter: AgentAdapter = {
    async execute() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        modelUsage: {
          "gpt-5.6-sol": {
            canonicalModel: "gpt-5.6-sol",
            provider: "firstParty",
            contextWindow: 262144,
          },
          "gpt-5.6-luna": {
            canonicalModel: "gpt-5.6-luna",
            provider: "firstParty",
            contextWindow: 262144,
          },
        },
        handoff: {
          status: "complete",
          summary: "routing observed",
          changedFiles: [],
          verification: [],
          gaps: [],
        },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "model-usage-match", objective: "prove routing", repository: ".", maxConcurrency: 1 },
    nodes: [
      {
        id: "review",
        type: "review",
        executor: "claudex",
        prompt: "use Luna",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 1,
        requiredModelUsage: [
          { model: "gpt-5.6-sol", provider: "firstParty", contextWindow: 262144 },
          { model: "gpt-5.6-luna", provider: "firstParty", contextWindow: 262144 },
        ],
      },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }).run();
    assert.equal(state.status, "completed");
    const evidence = JSON.parse(
      await readFile(
        join(root, ".agent-graph", "runs", "model-usage-match", state.nodes.review!.evidenceFiles.at(-1)!),
        "utf8",
      ),
    ) as { modelUsage: Record<string, { provider: string; contextWindow: number }> };
    assert.equal(evidence.modelUsage["gpt-5.6-luna"]!.provider, "firstParty");
    assert.equal(evidence.modelUsage["gpt-5.6-luna"]!.contextWindow, 262144);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner rejects mismatched required model provider and context", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-model-usage-mismatch-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const adapter: AgentAdapter = {
    async execute() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        modelUsage: {
          "gpt-5.6-luna": {
            canonicalModel: "gpt-5.6-sol",
            provider: "proxy",
            contextWindow: 200000,
          },
        },
        handoff: {
          status: "complete",
          summary: "wrong route",
          changedFiles: [],
          verification: [],
          gaps: [],
        },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "model-usage-mismatch", objective: "prove routing", repository: ".", maxConcurrency: 1 },
    nodes: [
      {
        id: "review",
        type: "review",
        executor: "claudex",
        prompt: "use Luna",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 1,
        requiredModelUsage: [
          { model: "gpt-5.6-luna", provider: "firstParty", contextWindow: 262144 },
        ],
      },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }).run();
    assert.equal(state.status, "failed");
    assert.match(state.nodes.review!.lastError ?? "", /canonical model gpt-5\.6-sol does not match gpt-5\.6-luna/);
    assert.match(state.nodes.review!.lastError ?? "", /provider proxy does not match firstParty/);
    assert.match(state.nodes.review!.lastError ?? "", /context window 200000 does not match 262144/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner does not retry when process-tree termination is unconfirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-non-retryable-adapter-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  let calls = 0;
  const adapter: AgentAdapter = {
    async execute() {
      calls += 1;
      throw new NonRetryableAdapterError("failed to terminate timed-out process tree for PID 123");
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "non-retryable-adapter", objective: "avoid overlapping agents", repository: ".", maxConcurrency: 1 },
    nodes: [
      {
        id: "agent",
        type: "agent",
        executor: "codex",
        prompt: "time out",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 2,
      },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.equal(state.nodes.agent!.attempts, 1);
    assert.equal(state.nodes.agent!.retryBlocked, true);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial and blocked handoffs stop for operator attention without automatic retry", async () => {
  for (const handoffStatus of ["partial", "blocked"] as const) {
    const root = await mkdtemp(join(tmpdir(), `agr-${handoffStatus}-attention-`));
    await exec("git", ["init", "--quiet"], { cwd: root });
    let calls = 0;
    const adapter: AgentAdapter = {
      async execute() {
        calls += 1;
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          handoff: {
            status: handoffStatus,
            summary: "operator decision required",
            changedFiles: [],
            verification: [],
            gaps: ["pending worker or environmental blocker"],
          },
        };
      },
    };
    const graph: GraphDefinition = {
      version: 1,
      run: { id: `${handoffStatus}-attention`, objective: "pause safely", repository: ".", maxConcurrency: 1 },
      nodes: [{
        id: "agent",
        type: "agent",
        executor: "claudex",
        prompt: "work directly",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 2,
      }],
    };

    try {
      const state = await new GraphRunner(graph, root, { claudex: adapter }).run();
      assert.equal(state.status, "needs_attention");
      assert.equal(state.nodes.agent!.status, "failed");
      assert.equal(state.nodes.agent!.attempts, 1);
      assert.equal(state.nodes.agent!.retryBlocked, true);
      assert.equal(calls, 1);
      const evidence = JSON.parse(
        await readFile(
          join(root, ".agent-graph", "runs", `${handoffStatus}-attention`, state.nodes.agent!.evidenceFiles.at(-1)!),
          "utf8",
        ),
      ) as { retryBlocked?: boolean };
      assert.equal(evidence.retryBlocked, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("semantic attention stops before an independent ready node starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-attention-stops-wave-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    async execute(request) {
      calls.push(request.node.id);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: request.node.id === "first" ? "partial" : "complete",
          summary: "done",
          changedFiles: [],
          verification: [],
          gaps: request.node.id === "first" ? ["operator inspection required"] : [],
        },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "attention-stops-wave", objective: "stop globally", repository: ".", maxConcurrency: 1 },
    nodes: [
      { id: "first", type: "agent", executor: "claudex", prompt: "first", needs: [], owns: [], checks: [], maxAttempts: 2 },
      { id: "independent", type: "agent", executor: "claudex", prompt: "second", needs: [], owns: [], checks: [], maxAttempts: 1 },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.deepEqual(calls, ["first"]);
    assert.equal(state.nodes.independent!.status, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic attention cancels still-running siblings in the same concurrent wave", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-attention-cancels-wave-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  let siblingCompleted = false;
  const adapter: AgentAdapter = {
    async execute(request) {
      if (request.node.id === "attention") {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          handoff: { status: "partial", summary: "inspect", changedFiles: [], verification: [], gaps: ["operator"] },
        };
      }
      if (request.signal?.aborted) {
        const error = new Error("cancelled by wave attention");
        error.name = "AbortError";
        throw error;
      }
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          siblingCompleted = true;
          resolveWait();
        }, 5_000);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("cancelled by wave attention");
          error.name = "AbortError";
          rejectWait(error);
        }, { once: true });
      });
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "late", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "attention-cancels-wave", objective: "cancel siblings", repository: ".", maxConcurrency: 2 },
    nodes: [
      { id: "attention", type: "agent", executor: "claudex", prompt: "attention", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "sibling", type: "agent", executor: "claudex", prompt: "sibling", needs: [], owns: [], checks: [], maxAttempts: 1 },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.equal(siblingCompleted, false);
    assert.equal(state.nodes.sibling!.status, "failed");
    assert.equal(state.nodes.sibling!.retryBlocked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic attention rejects a sibling that reports success after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-attention-late-success-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const adapter: AgentAdapter = {
    async execute(request) {
      if (request.node.id === "attention") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          handoff: { status: "blocked", summary: "inspect", changedFiles: [], verification: [], gaps: ["operator"] },
        };
      }
      await new Promise<void>((resolveWait) => {
        if (request.signal?.aborted) resolveWait();
        else request.signal?.addEventListener("abort", () => resolveWait(), { once: true });
      });
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "returned after cancellation", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "attention-late-success", objective: "reject late success", repository: ".", maxConcurrency: 2 },
    nodes: [
      { id: "attention", type: "agent", executor: "claudex", prompt: "attention", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "late", type: "agent", executor: "claudex", prompt: "late", needs: [], owns: [], checks: [], maxAttempts: 1 },
    ],
  };

  try {
    const state = await new GraphRunner(graph, root, { claudex: adapter }).run();
    assert.equal(state.status, "needs_attention");
    assert.equal(state.nodes.late!.status, "failed");
    assert.equal(state.nodes.late!.retryBlocked, true);
    assert.match(state.nodes.late!.lastError ?? "", /completed after another node required operator attention/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit retry clears semantic attention and allows a later complete handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-semantic-retry-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  let calls = 0;
  const adapter: AgentAdapter = {
    async execute() {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: calls === 1 ? "blocked" : "complete",
          summary: calls === 1 ? "environment unavailable" : "completed after reconciliation",
          changedFiles: [],
          verification: [],
          gaps: calls === 1 ? ["operator action required"] : [],
        },
      };
    },
  };
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "semantic-retry", objective: "resume deliberately", repository: ".", maxConcurrency: 1 },
    nodes: [{ id: "agent", type: "agent", executor: "claudex", prompt: "work directly", needs: [], owns: [], checks: [], maxAttempts: 2 }],
  };

  try {
    assert.equal((await new GraphRunner(graph, root, { claudex: adapter }).run()).status, "needs_attention");
    const reset = await new OperatorControl(graph, root).retry("agent");
    assert.equal(reset.status, "running");
    assert.equal(reset.nodes.agent!.retryBlocked, undefined);
    assert.equal(reset.nodes.agent!.attempts, 1);
    assert.equal(reset.nodes.agent!.generation, 1);
    assert.equal((await new GraphRunner(graph, root, { claudex: adapter }).run()).status, "completed");
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation blocks uncertain external actions until explicit retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cancel-external-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "cancel-external", objective: "external", repository: ".", maxConcurrency: 1, allowExternalActions: true },
    nodes: [
      { id: "gate", type: "human_gate", target: "publish", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "publish", type: "external_action", executor: "codex", target: "publish", prompt: "publish", needs: ["gate"], owns: [], checks: [], maxAttempts: 2 },
    ],
  };
  const controller = new AbortController();
  let calls = 0;
  const uncertain: AgentAdapter = {
    async execute() {
      calls += 1;
      controller.abort();
      throw new NonRetryableAdapterError("tree termination unconfirmed");
    },
  };
  try {
    await new GraphRunner(graph, root, { codex: uncertain }).run();
    await new OperatorControl(graph, root).approve("gate", "publish");
    const cancelled = await new GraphRunner(graph, root, { codex: uncertain }, { signal: controller.signal }).run();
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.nodes.publish?.status, "failed");
    assert.equal(cancelled.nodes.publish?.retryBlocked, true);
    const resumed = await new GraphRunner(graph, root, { codex: uncertain }).run();
    assert.equal(resumed.status, "needs_attention");
    assert.equal(calls, 1, "plain resume repeated an uncertain external action");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("cancellation persists deterministic check output for reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cancel-check-evidence-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const controller = new AbortController();
  const startedPath = join(root, "check.started");
  const checkScript = join(root, "check.mjs");
  await writeFile(
    checkScript,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(startedPath)}, "started"); console.log("CHECK_STARTED"); setTimeout(() => {}, 10000);`,
    "utf8",
  );
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "cancel-check-evidence", objective: "retain check evidence", repository: ".", maxConcurrency: 1 },
    nodes: [{
      id: "check",
      type: "verify",
      needs: [],
      owns: [],
      checks: [
        `${JSON.stringify(process.execPath)} ${JSON.stringify(checkScript)}`,
        `${JSON.stringify(process.execPath)} -e "console.log('SECOND_CHECK_MUST_NOT_RUN')"`,
      ],
      maxAttempts: 1,
    }],
  };
  const abortWhenStarted = (async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await access(startedPath);
        controller.abort();
        return;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
    }
    controller.abort();
  })();

  try {
    const state = await new GraphRunner(graph, root, {}, { signal: controller.signal }).run();
    await abortWhenStarted;
    assert.equal(state.status, "cancelled");
    assert.equal(state.nodes.check!.evidenceFiles.length, 1);
    const evidence = JSON.parse(
      await readFile(join(root, ".agent-graph", "runs", "cancel-check-evidence", state.nodes.check!.evidenceFiles[0]!), "utf8"),
    ) as { retryBlocked?: boolean; checks?: Array<{ cancelled?: boolean; stdout?: string }> };
    assert.equal(evidence.retryBlocked, true);
    assert.equal(evidence.checks?.[0]?.cancelled, true);
    assert.match(evidence.checks?.[0]?.stdout ?? "", /CHECK_STARTED/);
    assert.equal(evidence.checks?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("cancellation during post-executor ownership inspection requires explicit retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cancel-ownership-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  const controller = new AbortController();
  let calls = 0;
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "cancel-ownership", objective: "avoid duplicate effects", repository: ".", maxConcurrency: 1 },
    nodes: [
      {
        id: "effect",
        type: "agent",
        executor: "codex",
        prompt: "perform one effect",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 2,
      },
    ],
  };
  const adapter: AgentAdapter = {
    async execute() {
      calls += 1;
      setImmediate(() => controller.abort());
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: "complete",
          summary: "effect completed",
          changedFiles: [],
          verification: [],
          gaps: [],
        },
      };
    },
  };

  try {
    const cancelled = await new GraphRunner(graph, root, { codex: adapter }, { signal: controller.signal }).run();
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.nodes.effect!.retryBlocked, true);
    assert.equal(calls, 1);

    const resumed = await new GraphRunner(graph, root, { codex: adapter }).run();
    assert.equal(resumed.status, "needs_attention");
    assert.equal(calls, 1, "a plain resume must not repeat the completed effect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
