import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyVerifiedWorkerResult } from "../src/worker-acceptance.js";
import { sha256 } from "../src/persistence.js";
import type { GraphNodeDefinition } from "../src/types.js";
import type { WorkerResultEnvelope } from "../src/worker-protocol.js";

const node: GraphNodeDefinition = {
  id: "worker", type: "agent", executor: "codex", prompt: "work", needs: [], owns: ["owned.txt"], checks: [], maxAttempts: 1,
};

function result(path: string, content: string): WorkerResultEnvelope {
  const bytes = Buffer.from(content);
  const unsigned = {
    schemaVersion: 1 as const, resultId: "result", attemptId: "attempt", workerId: "worker-1", fencingToken: 3,
    status: "complete" as const, summary: "done",
    patch: { files: [{ path, sha256: sha256(bytes), size: bytes.byteLength, contentBase64: bytes.toString("base64") }] },
    artifacts: [], completedAt: Date.now(),
  };
  return { ...unsigned, resultHash: sha256(JSON.stringify(unsigned, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)) };
}

test("coordinator applies only ownership-safe verified worker patches", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-accept-"));
  await applyVerifiedWorkerResult(root, node, result("owned.txt", "accepted\n"), { attemptId: "attempt", workerId: "worker-1", fencingToken: 3 });
  assert.equal(await readFile(join(root, "owned.txt"), "utf8"), "accepted\n");
  await assert.rejects(() => applyVerifiedWorkerResult(root, node, result("escaped.txt", "bad\n"), { attemptId: "attempt", workerId: "worker-1", fencingToken: 3 }), /ownership/);
});

test("failed coordinator checks restore the pre-acceptance bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-accept-"));
  await writeFile(join(root, "owned.txt"), "before\n");
  const checked = { ...node, checks: [process.platform === "win32" ? "cmd /d /s /c exit 1" : "false"] };
  await assert.rejects(() => applyVerifiedWorkerResult(root, checked, result("owned.txt", "after\n"), { attemptId: "attempt", workerId: "worker-1", fencingToken: 3 }), /check failed/);
  assert.equal(await readFile(join(root, "owned.txt"), "utf8"), "before\n");
});
