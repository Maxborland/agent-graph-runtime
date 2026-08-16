import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { PassiveAdvisor } from "../src/advisor.js";
import type { AgentAdapter } from "../src/adapters.js";
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
