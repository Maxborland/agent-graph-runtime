import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeAdapter, CodexAdapter } from "../src/adapters.js";
import type { GraphNodeDefinition } from "../src/types.js";

const node: GraphNodeDefinition = {
  id: "adapter",
  type: "agent",
  executor: "codex",
  prompt: "Return a structured handoff",
  needs: [],
  owns: ["src/**"],
  checks: [],
  maxAttempts: 1,
};

test("Codex and Claude adapters return validated structured handoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-"));
  const fake = join(root, "fake-agent.mjs");
  await writeFile(
    fake,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const handoff = { status: "complete", summary: "done", changedFiles: [], verification: ["ok"], gaps: [] };
if (args[0] === "codex") {
  const outputIndex = args.indexOf("--output-last-message");
  writeFileSync(args[outputIndex + 1], JSON.stringify(handoff));
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff }));
}
`,
    "utf8",
  );

  try {
    const codex = new CodexAdapter(process.execPath, [fake, "codex"]);
    const claude = new ClaudeAdapter(process.execPath, [fake, "claude"]);
    const request = {
      node,
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
    };

    assert.equal((await codex.execute(request)).handoff.summary, "done");
    assert.equal((await claude.execute(request)).handoff.status, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude adapter retains raw output when structured output is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-invalid-"));
  const fake = join(root, "invalid-agent.mjs");
  await writeFile(fake, `process.stdout.write(JSON.stringify({ result: "not-json" }));`, "utf8");

  try {
    const claude = new ClaudeAdapter(process.execPath, [fake]);
    await assert.rejects(
      claude.execute({
        node: { ...node, executor: "claude" },
        repositoryRoot: root,
        prompt: "test prompt",
        artifactsDirectory: root,
        timeoutMs: 10_000,
      }),
      /agent output is not an object/,
    );
    assert.match(await readFile(join(root, "adapter.claude.stdout.json"), "utf8"), /not-json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
