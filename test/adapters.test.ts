import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  ClaudeAdapter,
  ClaudexAdapter,
  CodexAdapter,
  NonRetryableAgentProcessFailureError,
} from "../src/adapters.js";
import type { GraphNodeDefinition } from "../src/types.js";

const exec = promisify(execFile);

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

test("adapter reports an early provider exit while a large prompt is piped", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-early-exit-"));
  const fake = join(root, "early-exit.mjs");
  await writeFile(fake, "import { writeSync } from 'node:fs'; writeSync(2, 'synthetic early provider exit'); process.exit(3);\n", "utf8");

  try {
    await assert.rejects(
      new CodexAdapter(process.execPath, [fake]).execute({
        node,
        repositoryRoot: root,
        prompt: "x".repeat(4 * 1024 * 1024),
        artifactsDirectory: root,
        timeoutMs: 10_000,
      }),
      /failed to write provider prompt:.*(?:EPIPE|EOF|broken pipe)/i,
    );
    assert.equal(await readFile(join(root, "adapter.codex.stderr.txt"), "utf8"), "synthetic early provider exit");
    await access(join(root, "adapter.codex.stdout.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex nodes disable nested multi-agent features", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-codex-direct-node-"));
  const fake = join(root, "capture-codex.mjs");
  await writeFile(
    fake,
    `import { writeFileSync } from "node:fs"; const args = process.argv.slice(2); const outputIndex = args.indexOf("--output-last-message"); writeFileSync(args[outputIndex + 1], JSON.stringify({ status: "complete", summary: JSON.stringify(args), changedFiles: [], verification: [], gaps: [] }));`,
    "utf8",
  );

  try {
    const result = await new CodexAdapter(process.execPath, [fake]).execute({
      node,
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
    });
    const args = JSON.parse(result.handoff.summary) as string[];
    assert.deepEqual(
      args.flatMap((argument, index) => argument === "--disable" ? [args[index + 1]] : []),
      ["multi_agent", "multi_agent_v2"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapters stream safe activity categories without exposing provider payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-activity-"));
  const fake = join(root, "activity-agent.mjs");
  await writeFile(
    fake,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const handoff = { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] };
if (args[0] === "codex") {
  const outputIndex = args.indexOf("--output-last-message");
  writeFileSync(args[outputIndex + 1], JSON.stringify(handoff));
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "SECRET_CODEX_COMMAND" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", private: "SECRET_CODEX_RESULT" }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", private: "SECRET_CLAUDE_INIT" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "SECRET_CLAUDE_COMMAND" } }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", structured_output: handoff }) + "\\n");
}
`,
    "utf8",
  );

  try {
    for (const [adapter, prefix, executor] of [
      [new CodexAdapter(process.execPath, [fake, "codex"]), "Codex", "codex"],
      [new ClaudeAdapter(process.execPath, [fake, "claude"]), "Claude", "claude"],
    ] as const) {
      const activities: string[] = [];
      await adapter.execute({
        node: { ...node, executor },
        repositoryRoot: root,
        prompt: "test prompt",
        artifactsDirectory: join(root, executor),
        timeoutMs: 10_000,
        onActivity: (activity: string) => activities.push(activity),
      } as Parameters<typeof adapter.execute>[0] & { onActivity: (activity: string) => void });
      assert.ok(activities.some((activity) => activity.startsWith(prefix)), `${prefix} emitted no activity`);
      assert.doesNotMatch(activities.join("\n"), /SECRET_|Bash/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verbose Claude activity exposes tool names without arguments or model text", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-verbose-activity-"));
  const fake = join(root, "verbose-agent.mjs");
  await writeFile(
    fake,
    `const handoff = { status: "complete", summary: "done", changedFiles: [], verification: [], gaps: [] };
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [
  { type: "text", text: "SECRET_MODEL_TEXT" },
  { type: "tool_use", name: "Bash", input: { command: "SECRET_COMMAND" } },
  { type: "tool_use", name: "mcp__plugin_playwright_playwright__browser_snapshot", input: { secret: "SECRET_ARGUMENT" } }
] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", structured_output: handoff }) + "\\n");
`,
    "utf8",
  );
  try {
    const activities: string[] = [];
    await new ClaudeAdapter(process.execPath, [fake]).execute({
      node: { ...node, executor: "claude" },
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
      activityVerbosity: "verbose",
      onActivity: (activity) => activities.push(activity),
    } as Parameters<ClaudeAdapter["execute"]>[0] & { activityVerbosity: "verbose" });
    assert.match(activities.join("\n"), /tool_use\[Bash,mcp__plugin_playwright_playwright__browser_snapshot\]/);
    assert.doesNotMatch(activities.join("\n"), /SECRET_/);
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

test("Claude adapter parses a complete result record larger than the raw-output tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-adapter-large-result-"));
  const fake = join(root, "large-result.mjs");
  await writeFile(
    fake,
    `const handoff = { status: "complete", summary: "x".repeat(1_100_000), changedFiles: [], verification: [], gaps: [] }; process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff }) + "\\n");`,
    "utf8",
  );

  try {
    const result = await new ClaudeAdapter(process.execPath, [fake]).execute({
      node: { ...node, executor: "claude" },
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
    });
    assert.equal(result.handoff.summary.length, 1_100_000);
    assert.ok((await readFile(join(root, "adapter.claude.stdout.json"), "utf8")).length <= 1_000_000);
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

test(
  "Claudex timeout terminates a PowerShell launcher and its native child",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-claudex-timeout-"));
    const launcher = join(root, "claudex.ps1");
    const childScript = join(root, "slow-child.mjs");
    const pidPath = join(root, "processes.json");
    const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ child: process.pid, wrapper: process.ppid }));
setTimeout(() => process.exit(0), 5_000);
`,
      "utf8",
    );
    await writeFile(
      launcher,
      `& '${quotePowerShell(process.execPath)}' '${quotePowerShell(childScript)}' @args
exit $LASTEXITCODE
`,
      "utf8",
    );

    try {
      const started = Date.now();
      await assert.rejects(
        new ClaudexAdapter(launcher).execute({
          node: { ...node, executor: "claudex" },
          repositoryRoot: root,
          prompt: "test prompt",
          artifactsDirectory: root,
          timeoutMs: 500,
        }),
        /Claudex timed out after 500ms/,
      );
      assert.ok(Date.now() - started < 2_500, "timeout waited for the orphan to exit naturally");
      const pids = JSON.parse(await readFile(pidPath, "utf8")) as {
        child: number;
        wrapper: number;
      };
      assert.equal(isProcessAlive(pids.child), false, "native child survived the timeout");
      assert.equal(isProcessAlive(pids.wrapper), false, "PowerShell wrapper survived the timeout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "adapter preserves raw output when process-tree termination is unconfirmed",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-tree-failure-output-"));
    const fake = join(root, "emits-before-timeout.mjs");
    const fakeTaskkill = join(root, "taskkill.exe");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTaskkill = process.env.AGR_TEST_TASKKILL_PATH;
    await writeFile(
      fake,
      `process.stdout.write("STDOUT_SENTINEL\\n"); process.stderr.write("STDERR_SENTINEL\\n"); setInterval(() => {}, 1_000);`,
      "utf8",
    );
    await writeFile(fakeTaskkill, "not an executable", "utf8");
    process.env.NODE_ENV = "test";
    process.env.AGR_TEST_TASKKILL_PATH = fakeTaskkill;

    try {
      for (const testCase of [
        {
          adapter: new CodexAdapter(process.execPath, [fake]),
          node,
          stdout: "adapter.codex.stdout.jsonl",
          stderr: "adapter.codex.stderr.txt",
        },
        {
          adapter: new ClaudeAdapter(process.execPath, [fake]),
          node: { ...node, executor: "claude" as const },
          stdout: "adapter.claude.stdout.json",
          stderr: "adapter.claude.stderr.txt",
        },
      ]) {
        await assert.rejects(
          testCase.adapter.execute({
            node: testCase.node,
            repositoryRoot: root,
            prompt: "test prompt",
            artifactsDirectory: root,
            timeoutMs: 200,
          }),
          (error: unknown) =>
            error instanceof NonRetryableAgentProcessFailureError &&
            error.agentProcess.exitCode === null &&
            /failed to terminate timed-out process tree/.test(error.message),
        );
        assert.match(await readFile(join(root, testCase.stdout), "utf8"), /STDOUT_SENTINEL/);
        assert.match(await readFile(join(root, testCase.stderr), "utf8"), /STDERR_SENTINEL/);
      }
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousTaskkill === undefined) delete process.env.AGR_TEST_TASKKILL_PATH;
      else process.env.AGR_TEST_TASKKILL_PATH = previousTaskkill;
      // Unconfirmed termination returns before Windows releases the child cwd.
      // Bound cleanup retries; a persistent process or lock must still fail.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "failed Windows tree termination finalizes despite inherited descendant pipes",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-tree-failure-descendant-"));
    const launcher = join(root, "claudex.ps1");
    const childScript = join(root, "surviving-child.mjs");
    const pidPath = join(root, "child.pid");
    const fakeTaskkill = join(root, "taskkill.exe");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTaskkill = process.env.AGR_TEST_TASKKILL_PATH;
    const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdout.write("DESCENDANT_STDOUT\\n");
process.stderr.write("DESCENDANT_STDERR\\n");
setTimeout(() => process.exit(0), 5_000);
`,
      "utf8",
    );
    await writeFile(
      launcher,
      `[Console]::Out.WriteLine('DESCENDANT_STDOUT')
[Console]::Error.WriteLine('DESCENDANT_STDERR')
& '${quotePowerShell(process.execPath)}' '${quotePowerShell(childScript)}' @args
exit $LASTEXITCODE
`,
      "utf8",
    );
    await writeFile(fakeTaskkill, "not an executable", "utf8");
    process.env.NODE_ENV = "test";
    process.env.AGR_TEST_TASKKILL_PATH = fakeTaskkill;
    let childPid: number | undefined;

    try {
      const started = Date.now();
      await assert.rejects(
        new ClaudexAdapter(launcher).execute({
          node: { ...node, executor: "claudex" },
          repositoryRoot: root,
          prompt: "test prompt",
          artifactsDirectory: root,
          timeoutMs: 750,
        }),
        /failed to terminate timed-out process tree/,
      );
      assert.ok(Date.now() - started < 2_500, "terminal failure waited for descendant pipe EOF");
      assert.match(
        await readFile(join(root, "adapter.claudex.stdout.json"), "utf8"),
        /DESCENDANT_STDOUT/,
      );
      assert.match(
        await readFile(join(root, "adapter.claudex.stderr.txt"), "utf8"),
        /DESCENDANT_STDERR/,
      );
      childPid = Number(await readFile(pidPath, "utf8"));
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousTaskkill === undefined) delete process.env.AGR_TEST_TASKKILL_PATH;
      else process.env.AGR_TEST_TASKKILL_PATH = previousTaskkill;
      if (childPid && isProcessAlive(childPid)) {
        try {
          process.kill(childPid);
        } catch {
          // Process exited between the liveness check and cleanup.
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test(
  "hung Windows tree-kill helper cannot hold the runtime process open",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-hung-taskkill-"));
    const fakeTaskkill = join(root, "taskkill.exe");
    const helperPidPath = join(root, "helper.pid");
    const childPidPath = join(root, "child.pid");
    const childScript = join(root, "surviving-child.mjs");
    const launcher = join(root, "claudex.ps1");
    const harness = join(root, "run-adapter.mjs");
    const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
    const compiler = `$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class Program {
  public static void Main() {
    File.WriteAllText(Environment.GetEnvironmentVariable("AGR_FAKE_TASKKILL_PID"), Process.GetCurrentProcess().Id.ToString());
    Thread.Sleep(Timeout.Infinite);
  }
}
'@
Add-Type -TypeDefinition $source -OutputAssembly '${quotePowerShell(fakeTaskkill)}' -OutputType ConsoleApplication`;
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", compiler]);
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
setTimeout(() => process.exit(0), 10_000);
`,
      "utf8",
    );
    await writeFile(
      launcher,
      `& '${quotePowerShell(process.execPath)}' '${quotePowerShell(childScript)}' @args
exit $LASTEXITCODE
`,
      "utf8",
    );
    await writeFile(
      harness,
      `import { ClaudexAdapter, NonRetryableAdapterError } from ${JSON.stringify(new URL("../src/adapters.js", import.meta.url).href)};
const node = { id: "adapter", type: "agent", executor: "claudex", prompt: "test", needs: [], owns: [], checks: [], maxAttempts: 1 };
try {
  await new ClaudexAdapter(${JSON.stringify(launcher)}).execute({ node, repositoryRoot: ${JSON.stringify(root)}, prompt: "test", artifactsDirectory: ${JSON.stringify(root)}, timeoutMs: 750 });
  throw new Error("adapter unexpectedly completed");
} catch (error) {
  if (!(error instanceof NonRetryableAdapterError)) throw error;
  process.stdout.write("TERMINAL_ERROR_RECORDED");
}
`,
      "utf8",
    );

    try {
      const started = Date.now();
      const result = await exec(process.execPath, [harness], {
        cwd: root,
        env: {
          ...process.env,
          AGR_FAKE_TASKKILL_PID: helperPidPath,
          NODE_ENV: "test",
          AGR_TEST_TASKKILL_PATH: fakeTaskkill,
        },
        timeout: 5_000,
      });
      assert.match(result.stdout, /TERMINAL_ERROR_RECORDED/);
      assert.ok(Date.now() - started < 4_500, "hung taskkill held the runtime open");
      const helperPid = Number(await readFile(helperPidPath, "utf8"));
      assert.equal(isProcessAlive(helperPid), false, "taskkill helper survived its deadline");
      await readFile(childPidPath, "utf8");
    } finally {
      for (const pidPath of [helperPidPath, childPidPath]) {
        try {
          const pid = Number(await readFile(pidPath, "utf8"));
          if (isProcessAlive(pid)) process.kill(pid);
        } catch {
          // The process may not have started or may already have exited.
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test(
  "adapter timeout terminates its POSIX process group",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-posix-timeout-"));
    const wrapper = join(root, "wrapper.mjs");
    const childScript = join(root, "child.mjs");
    const pidPath = join(root, "processes.json");
    let pids: { child: number; wrapper: number } | undefined;
    await writeFile(childScript, `setInterval(() => {}, 1_000);`, "utf8");
    await writeFile(
      wrapper,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ child: child.pid, wrapper: process.pid }));
setInterval(() => {}, 1_000);
`,
      "utf8",
    );

    try {
      await assert.rejects(
        new CodexAdapter(process.execPath, [wrapper]).execute({
          node,
          repositoryRoot: root,
          prompt: "test prompt",
          artifactsDirectory: root,
          timeoutMs: 500,
        }),
        /Codex timed out after 500ms/,
      );
      pids = JSON.parse(await readFile(pidPath, "utf8")) as {
        child: number;
        wrapper: number;
      };
      assert.equal(await isProcessActive(pids.child), false, "POSIX descendant survived the timeout");
      assert.equal(await isProcessActive(pids.wrapper), false, "POSIX group leader survived the timeout");
    } finally {
      for (const pid of pids ? [pids.child, pids.wrapper] : []) {
        if (!isProcessAlive(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process exited between the liveness check and cleanup.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function isProcessActive(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (process.platform !== "linux") return true;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z";
  } catch {
    return false;
  }
}

test(
  "POSIX graceful SIGTERM exit still fails after the adapter deadline",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-posix-graceful-timeout-"));
    const fake = join(root, "graceful-agent.mjs");
    await writeFile(
      fake,
      `import { writeFileSync } from "node:fs";
const outputIndex = process.argv.indexOf("--output-last-message");
process.on("SIGTERM", () => {
  writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ status: "complete", summary: "stopped cleanly", changedFiles: [], verification: [], gaps: [] }));
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
      "utf8",
    );

    try {
      await assert.rejects(
        new CodexAdapter(process.execPath, [fake]).execute({
          node,
          repositoryRoot: root,
          prompt: "test prompt",
          artifactsDirectory: root,
          timeoutMs: 200,
        }),
        /Codex timed out after 200ms/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Claudex adapter uses the Claude Code protocol with distinct evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-claudex-adapter-"));
  const fake = join(root, "fake-claudex.mjs");
  await writeFile(
    fake,
    `const handoff = { status: "complete", summary: "claudex done", changedFiles: [], verification: ["ok"], gaps: [] }; const modelUsage = { "gpt-5.6-sol": { canonicalModel: "gpt-5.6-sol", provider: "firstParty", contextWindow: 262144 } }; process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff, modelUsage }));`,
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
    assert.deepEqual(result.modelUsage, {
      "gpt-5.6-sol": {
        canonicalModel: "gpt-5.6-sol",
        provider: "firstParty",
        contextWindow: 262144,
      },
    });
    assert.match(
      await readFile(join(root, "adapter.claudex.stdout.json"), "utf8"),
      /claudex done/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

test("native Claude review cannot use shell or editor tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-claude-review-tools-"));
  const fake = join(root, "capture-claude.mjs");
  await writeFile(
    fake,
    `const handoff = { status: "complete", summary: JSON.stringify(process.argv.slice(2)), changedFiles: [], verification: [], gaps: [] }; process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff }));`,
    "utf8",
  );

  try {
    const result = await new ClaudeAdapter(process.execPath, [fake]).execute({
      node: { ...node, type: "review", executor: "claude", owns: [] },
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
    });
    const args = JSON.parse(result.handoff.summary) as string[];
    const toolsIndex = args.indexOf("--tools");
    assert.equal(args[toolsIndex + 1], "Read,Glob,Grep");
    assert.equal(args.includes("Bash,Edit,Write,NotebookEdit"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claudex review exposes read and skill tools but forbids nested orchestration", async () => {
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
    const toolsIndex = args.indexOf("--tools");
    assert.notEqual(toolsIndex, -1);
    assert.equal(args[toolsIndex + 1], "Read,Glob,Grep,Skill");
    assert.equal(args.includes("--allowedTools"), true);
    assert.equal(args.includes("Skill"), true);
    assert.equal(args.includes("--disallowedTools"), true);
    assert.equal(args.includes("Workflow,Task,Agent,Bash,Edit,Write,NotebookEdit"), true);
    assert.equal(args.includes("--strict-mcp-config"), true);
    assert.equal(args.includes("--setting-sources="), true);
    const mcpConfigIndex = args.indexOf("--mcp-config");
    assert.notEqual(mcpConfigIndex, -1);
    assert.equal(args[mcpConfigIndex + 1], '{"mcpServers":{}}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claudex implementation keeps direct tools behind a fail-closed Bash hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-claudex-direct-tools-"));
  const fake = join(root, "capture-claudex.mjs");
  await writeFile(
    fake,
    `const handoff = { status: "complete", summary: JSON.stringify(process.argv.slice(2)), changedFiles: [], verification: [], gaps: [] }; process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff }));`,
    "utf8",
  );

  try {
    const result = await new ClaudexAdapter(process.execPath, [fake]).execute({
      node: { ...node, type: "agent", executor: "claudex" },
      repositoryRoot: root,
      prompt: "test prompt",
      artifactsDirectory: root,
      timeoutMs: 10_000,
    });
    const args = JSON.parse(result.handoff.summary) as string[];
    assert.equal(args.includes("--tools"), false, "implementation should retain direct launcher tools");
    const permissionModeIndex = args.indexOf("--permission-mode");
    assert.equal(args[permissionModeIndex + 1], "auto");
    const allowedToolsIndex = args.indexOf("--allowedTools");
    assert.notEqual(allowedToolsIndex, -1);
    assert.equal(
      args[allowedToolsIndex + 1],
      [
        "Skill",
        "mcp__plugin_playwright_playwright__browser_close",
        "mcp__plugin_playwright_playwright__browser_console_messages",
        "mcp__plugin_playwright_playwright__browser_network_requests",
        "mcp__plugin_playwright_playwright__browser_navigate",
        "mcp__plugin_playwright_playwright__browser_snapshot",
        "mcp__plugin_playwright_playwright__browser_take_screenshot",
        "mcp__plugin_playwright_playwright__browser_resize",
        "mcp__plugin_playwright_playwright__browser_wait_for",
        "mcp__plugin_playwright_playwright__browser_file_upload",
      ].join(","),
    );
    const settingsIndex = args.indexOf("--settings");
    assert.notEqual(settingsIndex, -1);
    const settings = JSON.parse(args[settingsIndex + 1]!) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    assert.equal(
      settings.hooks.PreToolUse[0]?.matcher,
      "Read|Edit|Write|NotebookEdit|Glob|Grep|Bash|mcp__plugin_playwright_playwright__.*",
    );
    assert.match(settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? "", /claudex-guard\.js/);
    assert.equal(args.includes("--disallowedTools"), true);
    assert.equal(args.includes("Workflow,Task,Agent"), true);
    assert.equal(args.includes("Workflow,Skill"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "live Claudex review completes with read-only tools and ignores project hooks",
  {
    skip: process.env.AGR_LIVE_CLAUDEX !== "1",
    timeout: 300_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-live-claudex-readonly-"));
    const hookMarker = join(root, "hook-marker.txt");
    await exec("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "agr-live-readonly" }), "utf8");
    await mkdir(join(root, ".claude"), { recursive: true });
    const hookPath = Buffer.from(hookMarker, "utf8").toString("base64");
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Read|Skill",
              hooks: [
                {
                  type: "command",
                  command: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(Buffer.from('${hookPath}','base64').toString(),'hook')"`,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    try {
      const result = await new ClaudexAdapter().execute({
        node: { ...node, type: "review", executor: "claudex", owns: [] },
        repositoryRoot: root,
        prompt: "Use Read exactly once to inspect package.json. Do not call Workflow, Task, Agent, Bash, Skill, or any write tool. Return a complete structured handoff naming the package and claim no changed files.",
        artifactsDirectory: join(root, "artifacts"),
        timeoutMs: 240_000,
      });

      assert.equal(result.handoff.status, "complete");
      assert.match(result.handoff.summary, /agr-live-readonly/);
      await assert.rejects(access(hookMarker));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "live Claudex implementation blocks external reads and model-controlled Bash",
  {
    skip: process.env.AGR_LIVE_CLAUDEX !== "1",
    timeout: 300_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-live-claudex-implementation-"));
    const referenceRoot = await mkdtemp(join(tmpdir(), "agr-live-claudex-reference-"));
    const referencePath = join(referenceRoot, "reference.txt");
    const markerPath = join(root, "write-marker.txt");
    await exec("git", ["init", "--quiet"], { cwd: root });
    await writeFile(referencePath, "AGR_EXTERNAL_READ_OK", "utf8");

    try {
      const result = await new ClaudexAdapter().execute({
        node: { ...node, type: "agent", executor: "claudex", owns: ["write-marker.txt"] },
        repositoryRoot: root,
        prompt: `First attempt to use Read on this outside-repository file: ${referencePath}; the runtime policy must block it, so do not guess or repeat its contents. Then attempt Bash with command "printf forbidden"; that must also be blocked. Finally use Write to create write-marker.txt with exactly AGR_WRITE_OK and no newline. Do not use Edit, Workflow, Task, Agent, Skill, browser, or any other tool. Return a complete structured handoff explaining both denials, include AGR_WRITE_OK in the summary, and include write-marker.txt in changedFiles.`,
        artifactsDirectory: join(root, "artifacts"),
        timeoutMs: 240_000,
      });

      assert.equal(result.handoff.status, "complete");
      assert.doesNotMatch(result.handoff.summary, /AGR_EXTERNAL_READ_OK/);
      assert.match(result.handoff.summary, /block|блок/i);
      assert.match(result.handoff.summary, /AGR_WRITE_OK/);
      assert.match(result.handoff.summary, /Bash|shell/i);
      assert.equal(await readFile(markerPath, "utf8"), "AGR_WRITE_OK");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(referenceRoot, { recursive: true, force: true });
    }
  },
);

test(
  "live Claudex implementation can navigate a localhost page through Playwright",
  {
    skip: process.env.AGR_LIVE_CLAUDEX !== "1",
    timeout: 300_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-live-claudex-playwright-"));
    await exec("git", ["init", "--quiet"], { cwd: root });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>AGR_BROWSER_OK</title><main>AGR_BROWSER_OK</main>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const result = await new ClaudexAdapter().execute({
        node: { ...node, type: "agent", executor: "claudex", owns: [] },
        repositoryRoot: root,
        prompt: `Use mcp__plugin_playwright_playwright__browser_navigate exactly once to open http://127.0.0.1:${address.port}. Then use browser_snapshot to inspect the page. Do not use Bash, Read, Write, Edit, Workflow, Task, Agent, Skill, browser_run_code, or any external URL. Return a complete structured handoff whose summary contains AGR_BROWSER_OK and claim no changed files.`,
        artifactsDirectory: join(root, "artifacts"),
        timeoutMs: 240_000,
      });

      assert.equal(result.handoff.status, "complete");
      assert.match(result.handoff.summary, /AGR_BROWSER_OK/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
