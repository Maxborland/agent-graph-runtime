import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactCatalog } from "../src/artifact-lineage.js";

test("typed artifacts are content addressed and verified before consumption", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-artifacts-repo-"));
  const runDirectory = await mkdtemp(join(tmpdir(), "agr-artifacts-run-"));
  await writeFile(join(repository, "plan.json"), "{\"ok\":true}\n");
  const catalog = new ArtifactCatalog(runDirectory, repository);
  const record = await catalog.record({ name: "plan", type: "application/json", path: "plan.json" }, {
    producerNodeId: "prepare", producerAttemptId: "attempt-1", planRevisionId: "plan-1", lineage: [],
  });
  assert.match(record.contentPath, /^artifacts\/sha256\//);
  await catalog.verifyConsumption({ name: "plan", type: "application/json", from: "prepare" }, record);
  await writeFile(join(repository, "plan.json"), "tampered\n");
  await assert.rejects(() => catalog.verifyConsumption({ name: "plan", type: "application/json", from: "prepare" }, record), /drift/);
  await rm(join(repository, "plan.json"));
  await assert.rejects(() => catalog.verifyConsumption({ name: "plan", type: "application/json", from: "prepare" }, record), /missing/);
});

test("artifact type and producer identity are authoritative", async () => {
  const repository = await mkdtemp(join(tmpdir(), "agr-artifacts-repo-"));
  const runDirectory = await mkdtemp(join(tmpdir(), "agr-artifacts-run-"));
  await writeFile(join(repository, "report.txt"), "verified\n");
  const catalog = new ArtifactCatalog(runDirectory, repository);
  const record = await catalog.record({ name: "report", type: "text/plain", path: "report.txt" }, {
    producerNodeId: "verify", producerAttemptId: "attempt-2", planRevisionId: "plan-2", lineage: ["sha-parent"],
  });
  await assert.rejects(() => catalog.verifyConsumption({ name: "report", type: "application/json", from: "verify" }, record), /type/);
  await assert.rejects(() => catalog.verifyConsumption({ name: "report", type: "text/plain", from: "other" }, record), /producer/);
});
