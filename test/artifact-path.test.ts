import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { artifactIdPattern, isSafeArtifactId } from "../src/artifact-path.js";
import { graphSchema, runDirectory } from "../src/cli-tools.js";

test("artifact IDs keep ordinary names while rejecting unsafe path components", () => {
  for (const id of ["task-2026", "job search_日本", "CONIN", "CONOUT", "CLOCK"]) {
    assert.equal(isSafeArtifactId(id), true, id);
  }
  for (const id of [
    "../escape", "nested/run", "nested\\run", ".", "..", "  ", "bad\nname",
    "name:stream", "trailing.", "trailing ", "CON", "nul.txt", "COM1.log",
    "CONIN$", "CONIN$.txt", "CONOUT$", "CLOCK$.log",
  ]) {
    assert.equal(isSafeArtifactId(id), false, id);
  }
});

test("graph JSON Schema and runtime use the same ID rule", () => {
  assert.equal(graphSchema.properties.run.properties.id.pattern, artifactIdPattern);
  assert.equal(graphSchema.properties.nodes.items.properties.id.pattern, artifactIdPattern);
});

test("published schema disallows shell executors for agent and review nodes", () => {
  const clauses = graphSchema.properties.nodes.items.allOf as readonly {
    if?: {
      properties?: {
        type?: { enum?: readonly string[] };
        executor?: { const?: string };
      };
    };
    then?: unknown;
  }[];
  assert(clauses.some((clause) =>
    clause.if?.properties?.type?.enum?.join(",") === "agent,review" &&
    clause.if.properties.executor?.const === "shell" &&
    clause.then === false));
});

test("runDirectory resolves only a safe direct child of the runs root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-artifact-path-"));
  try {
    assert.equal(
      runDirectory(root, "review task_日本"),
      resolve(root, ".agent-graph", "runs", "review task_日本"),
    );
    assert.throws(() => runDirectory(root, "../outside"), { code: "INVALID_ARTIFACT_ID", exitCode: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
