import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { AgentAdapter } from "../src/adapters.js";
import { approveGate } from "../src/approval.js";
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
    await approveGate(graph, root, "approval", "publish:fixture");
    const state = await runner.run();
    assert.equal(state.status, "failed");
    await assert.rejects(access(marker));
    assert.match(state.nodes.external!.lastError ?? "", /external actions are disabled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
