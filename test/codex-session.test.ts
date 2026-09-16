import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexSessionExecution } from "../src/codex-session.js";

const id = "11111111-2222-3333-4444-555555555555";
const timestamp = "2026-09-16T10:00:00.000Z";
const start = Date.parse(timestamp);
async function fixture(run: (home: string, records: Record<string, unknown>[]) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "agr-codex-session-"));
  await mkdir(join(home, "sessions/2026/09/16"), { recursive: true });
  const records = [
    { type: "session_meta", timestamp, payload: { id, cwd: home, timestamp } },
    { type: "turn_context", timestamp, payload: { cwd: home, model: "gpt-5.6-luna", effort: "max" } },
  ];
  try { await run(home, records); } finally { await rm(home, { recursive: true, force: true }); }
}
async function write(home: string, records: Record<string, unknown>[]) {
  await writeFile(join(home, `sessions/2026/09/16/rollout-test-${id}.jsonl`), records.map(x => JSON.stringify(x)).join("\n") + "\n");
}

test("exact invocation session proves effective values without copying prompt or reasoning", async () => fixture(async (home, records) => {
  records.push({ type: "response_item", payload: { content: "PRIVATE PROMPT" } });
  await write(home, records);
  assert.deepEqual(await readCodexSessionExecution(id, home, start, start + 1000, { CODEX_HOME: home }), {
    threadId: id, model: "gpt-5.6-luna", reasoningEffort: "max",
  });
}));
for (const invalid of ["id", "cwd", "time", "missing-context", "missing-meta"] as const) {
  test(`session lookup rejects ${invalid}`, async () => fixture(async (home, records) => {
    if (invalid === "id") (records[0]!.payload as Record<string, unknown>).id = "different";
    if (invalid === "cwd") (records[1]!.payload as Record<string, unknown>).cwd = join(home, "other");
    if (invalid === "time") records[1]!.timestamp = "2026-09-15T00:00:00Z";
    if (invalid === "missing-context") records.pop();
    if (invalid === "missing-meta") records.shift();
    await write(home, records);
    assert.equal(await readCodexSessionExecution(id, home, start, start + 1000, { CODEX_HOME: home }), undefined);
  }));
}
test("session lookup refuses ambiguous duplicate rollouts and path traversal", async () => fixture(async (home, records) => {
  await write(home, records);
  await writeFile(join(home, `sessions/2026/09/16/rollout-duplicate-${id}.jsonl`), records.map(x => JSON.stringify(x)).join("\n"));
  assert.equal(await readCodexSessionExecution(id, home, start, start + 1000, { CODEX_HOME: home }), undefined);
  assert.equal(await readCodexSessionExecution("../../secret", home, start, start + 1000, { CODEX_HOME: home }), undefined);
}));
test("changing effective execution is never reduced to a matching last turn", async () => fixture(async (home, records) => {
  records.push({ type: "turn_context", timestamp, payload: { cwd: home, model: "gpt-5.6-luna", effort: "high" } });
  await write(home, records);
  await assert.rejects(readCodexSessionExecution(id, home, start, start + 1000, { CODEX_HOME: home }), /changing effective/);
}));
