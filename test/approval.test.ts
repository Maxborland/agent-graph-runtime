import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { approveGate } from "../src/approval.js";
import { GraphRunner } from "../src/runner.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("human gate stops the run until its exact target is approved", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-approval-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: "approval-fixture",
      objective: "Require a human decision",
      repository: ".",
      maxConcurrency: 1,
    },
    nodes: [
      {
        id: "release-approval",
        type: "human_gate",
        target: "deploy:production",
        prompt: "Approve production deployment",
        needs: [],
        owns: [],
        checks: [],
        maxAttempts: 1,
      },
    ],
  };

  try {
    const runner = new GraphRunner(graph, root, {});
    assert.equal((await runner.run()).status, "awaiting_approval");
    await assert.rejects(
      approveGate(graph, root, "release-approval", "deploy:staging"),
      /does not match/,
    );
    await approveGate(graph, root, "release-approval", "deploy:production");
    const completed = await runner.run();
    assert.equal(completed.status, "completed");
    assert.equal(completed.nodes["release-approval"]!.status, "accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

