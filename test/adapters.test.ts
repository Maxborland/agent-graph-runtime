import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeAdapter, ClaudexAdapter, CodexAdapter } from "../src/adapters.js";
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

test("Claude adapter surfaces a concise provider result on a nonzero exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-auth-"));
  const fake = join(root, "auth-error.mjs");
  await writeFile(
    fake,
    `process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate: OAuth expired" })); process.exit(1);`,
    "utf8",
  );

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
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Claude exited 1: Failed to authenticate: OAuth expired",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex adapter reports an agent-process timeout explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-timeout-"));
  const fake = join(root, "slow-agent.mjs");
  await writeFile(fake, `setTimeout(() => {}, 60_000);`, "utf8");

  try {
    const codex = new CodexAdapter(process.execPath, [fake]);
    await assert.rejects(
      codex.execute({
        node,
        repositoryRoot: root,
        prompt: "test prompt",
        artifactsDirectory: root,
        timeoutMs: 50,
      }),
      /Codex timed out after 50ms/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claudex adapter uses the Claude Code protocol with distinct evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-claudex-adapter-"));
  const fake = join(root, "fake-claudex.mjs");
  await writeFile(
    fake,
    `const handoff = { status: "complete", summary: "claudex done", changedFiles: [], verification: ["ok"], gaps: [] }; process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff }));`,
    "utf8",
  );

  try {
    const claudex = new ClaudexAdapter(process.execPath, [fake]);
    const result = await claudex.execute({
      node: { ...node, executor: "claudex" },
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
    });

    assert.equal(result.handoff.summary, "claudex done");
    assert.match(
      await readFile(join(root, "adapter.claudex.stdout.json"), "utf8"),
      /claudex done/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claudex adapter independently protects launcher-owned model routing", async () => {
  const claudex = new ClaudexAdapter(process.execPath, []);
  await assert.rejects(
    claudex.execute({
      node: { ...node, executor: "claudex", model: "another-model" },
      repositoryRoot: process.cwd(),
      prompt: "test prompt",
      artifactsDirectory: process.cwd(),
      timeoutMs: 10_000,
    }),
    /Claudex nodes cannot override the launcher model/,
  );
});

test("Claudex preserves launcher tool discovery while denying review write tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-claudex-tools-"));
  const fake = join(root, "capture-claudex.mjs");
  await writeFile(
    fake,
    `const handoff = { status: "complete", summary: JSON.stringify(process.argv.slice(2)), changedFiles: [], verification: [], gaps: [] }; process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff }));`,
    "utf8",
  );

  try {
    const result = await new ClaudexAdapter(process.execPath, [fake]).execute({
      node: { ...node, type: "review", executor: "claudex", owns: [] },
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
    });
    const args = JSON.parse(result.handoff.summary) as string[];
    assert.equal(args.includes("--tools"), false);
    assert.equal(args.includes("--allowedTools"), true);
    assert.equal(args.includes("Workflow,Skill"), true);
    assert.equal(args.includes("--disallowedTools"), true);
    assert.equal(args.includes("Edit,Write,NotebookEdit"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
