import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { OperatorControl } from "../src/operator-control.js";
import { gitChangedFiles } from "../src/repository.js";
import { RunStore } from "../src/store.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

async function fixture(): Promise<{ root: string; graph: GraphDefinition }> {
  const root = await mkdtemp(join(tmpdir(), "agr-operator-control-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "operator-control", objective: "control", repository: ".", maxConcurrency: 1 },
    nodes: [
      { id: "work", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      {
        id: "release",
        type: "human_gate",
        target: "deploy:production",
        needs: ["work"],
        owns: [],
        checks: [],
        maxAttempts: 1,
      },
    ],
  };
  return { root, graph };
}

test("operator control rejects an unknown retry before creating run artifacts", async () => {
  const { root, graph } = await fixture();
  try {
    await assert.rejects(new OperatorControl(graph, root).retry("missing"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "NODE_NOT_FOUND");
      return true;
    });
    await assert.rejects(access(join(root, ".agent-graph", "runs", graph.run.id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator control serializes exact approval, retry, and advisor acknowledgement", async () => {
  const { root, graph } = await fixture();
  try {
    const store = await RunStore.open(root, graph, await gitChangedFiles(root));
    store.state.nodes.work!.status = "accepted";
    store.state.advisor = {
      blocker: {
        id: "__advisor-wave-1",
        wave: 1,
        at: new Date().toISOString(),
        severity: "blocker",
        summary: "inspect evidence",
        evidenceFile: "evidence/advisor-wave-1.json",
      },
    };
    await store.save("fixture");

    const control = new OperatorControl(graph, root);
    await assert.rejects(control.approve("release", "deploy:staging"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_APPROVAL_TARGET");
      return true;
    });
    const approved = await control.approve("release", "deploy:production");
    assert.equal(approved.nodes.release!.approvedTarget, "deploy:production");

    const acknowledged = await control.acknowledgeAdvisor();
    assert.equal(acknowledged.advisor?.blocker, undefined);

    const retried = await control.retry("work");
    assert.equal(retried.nodes.work!.status, "pending");
    assert.equal(retried.nodes.release!.status, "pending");
    assert.equal(retried.nodes.release!.approvedTarget, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
