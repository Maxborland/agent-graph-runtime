import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { PassiveAdvisor } from "../src/advisor.js";
import type { AgentAdapter } from "../src/adapters.js";
import { GraphRunner } from "../src/runner.js";
import { RunStore } from "../src/store.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("passive advisor owns wave dispatch, safe context, evidence, and observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-advisor-module-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-module",
      objective: "Keep advice behind one interface",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex", instructions: "Watch lifecycle contracts." },
    },
    nodes: [{ id: "first", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  let prompt = "";
  const adapter: AgentAdapter = {
    async execute(request) {
      prompt = request.prompt;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: { status: "complete", summary: "Lifecycle remains coherent", changedFiles: [], verification: [], gaps: [] },
      };
    },
  };

  try {
    const store = await RunStore.open(root, graph, []);
    store.state.nodes.first!.status = "accepted";
    store.state.nodes.first!.attempts = 1;
    await store.appendEvent({ at: "2026-08-16T00:00:00.000Z", type: "node_accepted", nodeId: "first" });
    await store.save("wave-finished");

    await new PassiveAdvisor(graph, root, { codex: adapter }).reviewWave(store);

    assert.equal(store.state.advisor?.latest?.severity, "note");
    assert.equal(store.state.advisor?.latest?.summary, "Lifecycle remains coherent");
    assert.match(prompt, /"type": "node_accepted"/);
    assert.match(
      await readFile(join(store.evidenceDirectory, "advisor-wave-1.json"), "utf8"),
      /Lifecycle remains coherent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisor invocation identities remain unique after reopening a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-advisor-resume-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-resume",
      objective: "Preserve historical advisor evidence",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex" },
    },
    nodes: [{ id: "first", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
  };
  let calls = 0;
  const adapter: AgentAdapter = {
    async execute() {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        handoff: {
          status: "complete",
          summary: `advice-${calls}`,
          changedFiles: [],
          verification: [],
          gaps: [],
        },
      };
    },
  };

  try {
    const firstStore = await RunStore.open(root, graph, []);
    await new PassiveAdvisor(graph, root, { codex: adapter }).reviewWave(firstStore);
    const firstObservation = firstStore.state.advisor!.latest!;
    const firstEvidence = await readFile(join(firstStore.runDirectory, firstObservation.evidenceFile), "utf8");

    const resumedStore = await RunStore.open(root, graph, []);
    await new PassiveAdvisor(graph, root, { codex: adapter }).reviewWave(resumedStore);
    const secondObservation = resumedStore.state.advisor!.latest!;

    assert.notEqual(secondObservation.id, firstObservation.id);
    assert.notEqual(secondObservation.evidenceFile, firstObservation.evidenceFile);
    assert.match(firstEvidence, /advice-1/);
    assert.match(await readFile(join(resumedStore.runDirectory, firstObservation.evidenceFile), "utf8"), /advice-1/);
    assert.match(await readFile(join(resumedStore.runDirectory, secondObservation.evidenceFile), "utf8"), /advice-2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisor ownership escape after an ordinary error blocks the dependent wave", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-advisor-error-ownership-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "advisor-error-ownership",
      objective: "Fail closed when an advisor changes files and then errors",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex", stopOnBlocker: false },
    },
    nodes: [
      { id: "first", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "next", type: "verify", needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  const adapter: AgentAdapter = {
    async execute() {
      await writeFile(join(root, "outside-owner.txt"), "partial advisor write\n", "utf8");
      throw new Error("provider disconnected after writing");
    },
  };

  try {
    const state = await new GraphRunner(graph, root, { codex: adapter }).run();

    assert.equal(state.status, "needs_attention");
    assert.equal(state.nodes.next!.attempts, 0, "the dependent wave must not start after an ownership blocker");
    const blocker = state.advisor?.blocker;
    assert.equal(blocker?.severity, "blocker");
    assert.match(blocker?.summary ?? "", /advisor changed paths outside \.agent-graph/);
    const evidence = JSON.parse(
      await readFile(join(root, ".agent-graph", "runs", graph.run.id, "evidence", "advisor-wave-1.json"), "utf8"),
    ) as { blocker?: boolean; ownership?: { escapedPaths?: string[] }; failures?: string[] };
    assert.equal(evidence.blocker, true);
    assert.deepEqual(evidence.ownership?.escapedPaths, ["outside-owner.txt"]);
    assert.match(evidence.failures?.join("; ") ?? "", /provider disconnected after writing/);
    assert.match(evidence.failures?.join("; ") ?? "", /outside-owner\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
