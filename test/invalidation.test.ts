import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { retryNode } from "../src/invalidation.js";
import { gitChangedFiles } from "../src/repository.js";
import { RunStore } from "../src/store.js";
import type { GraphDefinition } from "../src/types.js";

const exec = promisify(execFile);

test("retry invalidates the selected node and every accepted descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-invalidate-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  const graph: GraphDefinition = {
    version: 1,
    run: { id: "invalidate-fixture", objective: "invalidate", repository: ".", maxConcurrency: 1 },
    nodes: [
      { id: "a", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "b", type: "verify", needs: ["a"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };

  try {
    const store = await RunStore.open(root, graph, await gitChangedFiles(root));
    store.state.nodes.a!.status = "accepted";
    store.state.nodes.a!.evidenceFiles = ["evidence/a.json"];
    store.state.nodes.b!.status = "accepted";
    store.state.nodes.b!.evidenceFiles = ["evidence/b.json"];
    await store.save("accepted-fixture");

    const state = await retryNode(graph, root, "a");
    assert.equal(state.nodes.a!.status, "pending");
    assert.equal(state.nodes.b!.status, "pending");
    assert.deepEqual(state.nodes.a!.evidenceFiles, []);
    assert.deepEqual(state.nodes.b!.evidenceFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

