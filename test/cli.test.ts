import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { graphHash } from "../src/graph-hash.js";

const exec = promisify(execFile);

test("CLI follow resumes durable events after a cursor as JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-follow-"));
  const graphPath = join(root, "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "follow-run", objective: "follow events", repository: ".", maxConcurrency: 1 },
      nodes: [{ id: "verify", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
    }),
    "utf8",
  );
  const cli = resolve("dist/src/cli.js");
  try {
    await exec(process.execPath, [cli, "run", graphPath], { cwd: root, encoding: "utf8" });
    const { stdout } = await exec(
      process.execPath,
      [cli, "follow", graphPath, "--after", "2", "--format", "jsonl"],
      { cwd: root, encoding: "utf8" },
    );
    const events = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { seq: number; type: string });
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.seq > 2));
    assert.equal(events.at(-1)?.type, "run_completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI follow stays attached to a running graph and emits observer heartbeats", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-follow-live-"));
  const graphPath = join(root, "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "follow-live-run", objective: "follow live", repository: ".", maxConcurrency: 1 },
      nodes: [{
        id: "slow",
        type: "verify",
        needs: [],
        owns: [],
        checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 450)"`],
        maxAttempts: 1,
      }],
    }),
    "utf8",
  );
  const cli = resolve("dist/src/cli.js");
  const running = spawn(process.execPath, [cli, "run", graphPath], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let progress = "";
  running.stderr.setEncoding("utf8");
  running.stderr.on("data", (chunk: string) => { progress += chunk; });
  try {
    const deadline = Date.now() + 2_000;
    while (!/slow started/i.test(progress) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.match(progress, /slow started/i);
    const { stdout } = await exec(
      process.execPath,
      [cli, "follow", graphPath, "--format", "jsonl", "--interval-ms", "50"],
      { cwd: root, encoding: "utf8", timeout: 3_000 },
    );
    const runExit = running.exitCode ?? await new Promise<number | null>((resolveExit) => running.once("close", resolveExit));
    assert.equal(runExit, 0);
    const output = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string });
    assert.ok(output.some((event) => event.type === "observer_heartbeat"));
    assert.equal(output.at(-1)?.type, "run_completed");
  } finally {
    if (running.exitCode === null) running.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI wait reports an observation timeout as polling data", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-wait-"));
  const graphPath = join(root, "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "wait-run", objective: "wait safely", repository: ".", maxConcurrency: 1 },
      nodes: [{
        id: "slow",
        type: "verify",
        needs: [],
        owns: [],
        checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 500)"`],
        maxAttempts: 1,
      }],
    }),
    "utf8",
  );
  const cli = resolve("dist/src/cli.js");
  const running = spawn(process.execPath, [cli, "run", graphPath], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let progress = "";
  running.stderr.setEncoding("utf8");
  running.stderr.on("data", (chunk: string) => { progress += chunk; });
  try {
    const deadline = Date.now() + 2_000;
    while (!/slow started/i.test(progress) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.match(progress, /slow started/i);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const eventsPath = join(root, ".agent-graph", "runs", "wait-run", "events.jsonl");
    const cursor = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/).length;
    const { stdout } = await exec(
      process.execPath,
      [cli, "wait", graphPath, "--after", String(cursor), "--timeout-ms", "50", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    const observation = JSON.parse(stdout) as {
      status: string;
      terminal: boolean;
      timedOut: boolean;
      cursor: number;
      events: unknown[];
      activeNodes: Array<{ id: string }>;
    };
    assert.equal(observation.status, "running");
    assert.equal(observation.terminal, false);
    assert.equal(observation.timedOut, true);
    assert.equal(observation.cursor, cursor);
    assert.deepEqual(observation.events, []);
    assert.deepEqual(observation.activeNodes, [{ id: "slow", attempts: 1 }]);
    const runExit = running.exitCode ?? await new Promise<number | null>((resolveExit) => running.once("close", resolveExit));
    assert.equal(runExit, 0);
  } finally {
    if (running.exitCode === null) running.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI inspect returns a compact active-node snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-inspect-"));
  const graphPath = join(root, "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "inspect-run", objective: "inspect live", repository: ".", maxConcurrency: 1 },
      nodes: [{
        id: "slow",
        type: "verify",
        needs: [],
        owns: [],
        checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 400)"`],
        maxAttempts: 1,
      }],
    }),
    "utf8",
  );
  const cli = resolve("dist/src/cli.js");
  const running = spawn(process.execPath, [cli, "run", graphPath], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let progress = "";
  running.stderr.setEncoding("utf8");
  running.stderr.on("data", (chunk: string) => { progress += chunk; });
  try {
    const deadline = Date.now() + 2_000;
    while (!/slow started/i.test(progress) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.match(progress, /slow started/i);
    const { stdout } = await exec(process.execPath, [cli, "inspect", graphPath, "--json"], { cwd: root, encoding: "utf8" });
    const snapshot = JSON.parse(stdout) as {
      runId: string;
      status: string;
      cursor: number;
      activeNodes: Array<{ id: string; attempts: number; elapsedMs: number; silentForMs: number }>;
    };
    assert.equal(snapshot.runId, "inspect-run");
    assert.equal(snapshot.status, "running");
    assert.ok(snapshot.cursor >= 1);
    assert.equal(snapshot.activeNodes[0]?.id, "slow");
    assert.equal(snapshot.activeNodes[0]?.attempts, 1);
    assert.ok((snapshot.activeNodes[0]?.elapsedMs ?? -1) >= 0);
    assert.ok((snapshot.activeNodes[0]?.silentForMs ?? -1) >= 0);
    const runExit = running.exitCode ?? await new Promise<number | null>((resolveExit) => running.once("close", resolveExit));
    assert.equal(runExit, 0);
  } finally {
    if (running.exitCode === null) running.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI why explains an ownership stop with a safe next action", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-why-"));
  const graphPath = join(root, "graph.json");
  const runRoot = join(root, ".agent-graph", "runs", "why-run");
  await mkdir(runRoot, { recursive: true });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "why-run", objective: "explain stop", repository: ".", maxConcurrency: 1 },
      nodes: [{ id: "implementation", type: "agent", executor: "codex", prompt: "work", needs: [], owns: ["src/**"], checks: [], maxAttempts: 2 }],
    }),
    "utf8",
  );
  await writeFile(
    join(runRoot, "state.json"),
    JSON.stringify({
      runId: "why-run",
      graphHash: "fixture",
      status: "needs_attention",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:01:00.000Z",
      baselineChangedFiles: [],
      nodes: {
        implementation: {
          status: "failed",
          attempts: 1,
          retryBlocked: true,
          lastError: "unexpected changed paths: apps/landing/a.ts, output/playwright/a.png",
          evidenceFiles: ["evidence/implementation-attempt-1.json"],
        },
      },
    }),
    "utf8",
  );
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: "2026-08-16T00:01:00.000Z", type: "run_needs_attention" })}\n`, "utf8");
  const cli = resolve("dist/src/cli.js");
  try {
    const { stdout } = await exec(process.execPath, [cli, "why", graphPath, "--json"], { cwd: root, encoding: "utf8" });
    const result = JSON.parse(stdout) as {
      status: string;
      issues: Array<{ code: string; nodeId: string; retrySafety: string; paths: string[]; nextAction: string }>;
    };
    assert.equal(result.status, "needs_attention");
    assert.deepEqual(result.issues[0], {
      code: "OWNERSHIP_ESCAPE",
      nodeId: "implementation",
      retrySafety: "inspect_required",
      paths: ["apps/landing/a.ts", "output/playwright/a.png"],
      nextAction: "Stop or isolate every external writer, inspect the paths and evidence, then run agr retry implementation explicitly.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI advisor acknowledge clears only the run-level advisor blocker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-advisor-ack-"));
  const graphPath = join(root, "graph.json");
  const runRoot = join(root, ".agent-graph", "runs", "advisor-ack-run");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await mkdir(runRoot, { recursive: true });
  const graph = {
    version: 1 as const,
    run: {
      id: "advisor-ack-run",
      objective: "resume after explicit advisor reconciliation",
      repository: ".",
      maxConcurrency: 1,
      advisor: { executor: "codex" as const },
    },
    nodes: [
      { id: "first", type: "verify" as const, needs: [], owns: [], checks: [], maxAttempts: 1 },
      { id: "second", type: "verify" as const, needs: ["first"], owns: [], checks: [], maxAttempts: 1 },
    ],
  };
  await writeFile(graphPath, JSON.stringify(graph), "utf8");
  const blocker = {
    id: "__advisor-wave-1",
    wave: 1,
    at: "2026-08-16T00:01:00.000Z",
    severity: "blocker",
    summary: "Contract regression",
    evidenceFile: "evidence/advisor-wave-1.json",
  };
  await writeFile(
    join(runRoot, "state.json"),
    JSON.stringify({
      runId: graph.run.id,
      graphHash: graphHash(graph),
      status: "needs_attention",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:01:00.000Z",
      baselineChangedFiles: [],
      nodes: {
        first: { status: "accepted", attempts: 1, evidenceFiles: [] },
        second: { status: "pending", attempts: 0, evidenceFiles: [] },
      },
      advisor: { latest: blocker, blocker },
    }),
    "utf8",
  );
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ seq: 1, at: blocker.at, type: "advisor_note", severity: "blocker" })}\n`, "utf8");
  const cli = resolve("dist/src/cli.js");
  try {
    const advisorStatus = JSON.parse((await exec(
      process.execPath,
      [cli, "advisor", "status", graphPath, "--json"],
      { cwd: root, encoding: "utf8" },
    )).stdout) as { enabled: boolean; executor: string; blocker?: { summary: string } };
    assert.equal(advisorStatus.enabled, true);
    assert.equal(advisorStatus.executor, "codex");
    assert.equal(advisorStatus.blocker?.summary, "Contract regression");
    const before = JSON.parse((await exec(
      process.execPath,
      [cli, "why", graphPath, "--json"],
      { cwd: root, encoding: "utf8" },
    )).stdout) as { issues: Array<{ code: string; nextAction: string }> };
    assert.equal(before.issues[0]?.code, "ADVISOR_BLOCKER");
    assert.match(before.issues[0]?.nextAction ?? "", /agr advisor acknowledge/);
    const { stdout } = await exec(
      process.execPath,
      [cli, "advisor", "acknowledge", graphPath, "--json"],
      { cwd: root, encoding: "utf8" },
    );
    const state = JSON.parse(stdout) as { status: string; advisor?: { blocker?: unknown }; nodes: Record<string, { attempts: number; status: string }> };
    assert.equal(state.status, "running");
    assert.equal(state.advisor?.blocker, undefined);
    assert.deepEqual(state.nodes.first, { status: "accepted", attempts: 1, evidenceFiles: [], generationAttempts: 1, attemptHighWater: 1, acceptedAttempt: 1 });
    assert.deepEqual(state.nodes.second, { status: "pending", attempts: 0, evidenceFiles: [], generationAttempts: 0, attemptHighWater: 0 });
    assert.match(await readFile(join(runRoot, "events.jsonl"), "utf8"), /"type":"advisor_acknowledged"/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI progress rejects calls outside an active graph node", async () => {
  const cli = resolve("dist/src/cli.js");
  let failure: { code: number; stdout: string } | undefined;
  try {
    await exec(
      process.execPath,
      [cli, "progress", "--phase", "inspect", "--message", "mapped target", "--json"],
      { encoding: "utf8" },
    );
  } catch (error) {
    failure = error as { code: number; stdout: string };
  }
  assert.equal(failure?.code, 3);
  assert.deepEqual(JSON.parse(failure?.stdout ?? ""), {
    error: {
      code: "PROGRESS_CHANNEL_MISSING",
      message: "agr progress is available only inside an active agent node",
    },
  });
});

test("CLI progress delivers a bounded authenticated node milestone", async () => {
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\agr-progress-test-${randomUUID()}`
    : join(tmpdir(), `agr-progress-test-${randomUUID()}.sock`);
  let resolveReceived!: (value: Record<string, unknown>) => void;
  let rejectReceived!: (error: unknown) => void;
  const received = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveReceived = resolve;
    rejectReceived = reject;
  });
  const server = createServer((socket) => {
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        raw += chunk;
        if (!raw.includes("\n")) return;
        try {
          resolveReceived(JSON.parse(raw.trim()) as Record<string, unknown>);
          socket.end("ok");
        } catch (error) {
          rejectReceived(error);
        }
      });
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(endpoint, resolveListening);
  });
  const cli = resolve("dist/src/cli.js");
  try {
    const { stdout } = await exec(
      process.execPath,
      [cli, "progress", "--phase", "verify", "--message", "13 of 14 browser gates passed", "--percent", "93", "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AGR_PROGRESS_ENDPOINT: endpoint,
          AGR_PROGRESS_TOKEN: "test-token",
          AGR_RUN_ID: "run-v6",
          AGR_NODE_ID: "a4-runtime-close",
        },
      },
    );
    assert.deepEqual(JSON.parse(stdout), { reported: true });
    assert.deepEqual(await received, {
      token: "test-token",
      runId: "run-v6",
      nodeId: "a4-runtime-close",
      phase: "verify",
      message: "13 of 14 browser gates passed",
      percent: 93,
    });
  } finally {
    server.close();
    if (process.platform !== "win32") await rm(endpoint, { force: true });
  }
});

test("CLI run streams node progress and heartbeats before completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-progress-"));
  const graphPath = join(root, "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "cli-progress", objective: "show progress", repository: ".", maxConcurrency: 1 },
      nodes: [
        {
          id: "slow-check",
          type: "verify",
          needs: [],
          owns: [],
          checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 350)"`],
          maxAttempts: 1,
        },
      ],
    }),
    "utf8",
  );

  try {
    const cli = resolve("dist/src/cli.js");
    const started = Date.now();
    const observations: Array<{ at: number; text: string }> = [];
    const child = spawn(
      process.execPath,
      [cli, "run", graphPath, "--heartbeat-ms", "50"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => observations.push({ at: Date.now(), text }));
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", resolveExit);
    });
    assert.equal(exitCode, 0);
    const output = observations.map((entry) => entry.text).join("");
    assert.match(output, /run cli-progress started/i);
    assert.match(output, /slow-check.*started/i);
    assert.match(output, /heartbeat.*slow-check/i);
    assert.ok(
      observations.some((entry) => entry.at - started < 250),
      "run produced no prompt progress before the slow node completed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI refuses a second live owner for the same run", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-lock-"));
  const graphPath = join(root, "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "locked-run", objective: "single owner", repository: ".", maxConcurrency: 1 },
      nodes: [{
        id: "slow",
        type: "verify",
        needs: [],
        owns: [],
        checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 900)"`],
        maxAttempts: 1,
      }],
    }),
    "utf8",
  );
  const cli = resolve("dist/src/cli.js");
  const first = spawn(process.execPath, [cli, "run", graphPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let firstStderr = "";
  first.stderr.setEncoding("utf8");
  first.stderr.on("data", (text: string) => {
    firstStderr += text;
  });

  try {
    const deadline = Date.now() + 2_000;
    while (!/slow started/i.test(firstStderr) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.match(firstStderr, /slow started/i);
    await assert.rejects(
      exec(process.execPath, [cli, "run", graphPath], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        const candidate = error as { code?: number; stderr?: string };
        assert.equal(candidate.code, 4);
        assert.match(candidate.stderr ?? "", /already owned by PID/i);
        return true;
      },
    );
    assert.equal(
      await new Promise<number | null>((resolveExit, rejectExit) => {
        first.once("error", rejectExit);
        first.once("close", resolveExit);
      }),
      0,
    );
  } finally {
    if (first.exitCode === null) first.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI cancel stops an active run and persists cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-cancel-"));
  const graphPath = join(root, "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "cancelled-run", objective: "cancel", repository: ".", maxConcurrency: 1 },
      nodes: [{
        id: "slow",
        type: "verify",
        needs: [],
        owns: [],
        checks: [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`],
        maxAttempts: 1,
      }],
    }),
    "utf8",
  );
  const cli = resolve("dist/src/cli.js");
  const running = spawn(process.execPath, [cli, "run", graphPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let progress = "";
  running.stderr.setEncoding("utf8");
  running.stderr.on("data", (text: string) => {
    progress += text;
  });

  try {
    const deadline = Date.now() + 2_000;
    while (!/slow started/i.test(progress) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.match(progress, /slow started/i);
    const { stdout } = await exec(process.execPath, [cli, "cancel", graphPath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(stdout, /Cancellation requested/i);
    assert.equal(
      await new Promise<number | null>((resolveExit, rejectExit) => {
        running.once("error", rejectExit);
        running.once("close", resolveExit);
      }),
      130,
    );
    const state = JSON.parse(
      await readFile(join(root, ".agent-graph", "runs", "cancelled-run", "state.json"), "utf8"),
    ) as { status: string; nodes: Record<string, { status: string; retryBlocked?: boolean }> };
    assert.equal(state.status, "cancelled");
    assert.equal(state.nodes.slow?.status, "failed");
    assert.equal(state.nodes.slow?.retryBlocked, true);
    const events = await readFile(
      join(root, ".agent-graph", "runs", "cancelled-run", "events.jsonl"),
      "utf8",
    );
    assert.match(events, /"type":"run_cancelled"/);
    await assert.rejects(readFile(join(root, ".agent-graph", "runs", "cancelled-run", "cancel.requested")));
  } finally {
    if (running.exitCode === null) running.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI validate reports a valid graph through the packaged entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-"));
  const graphPath = join(root, "graph.json");
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "cli-fixture", objective: "validate", repository: ".", maxConcurrency: 1 },
      nodes: [
        { id: "check", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 },
      ],
    }),
  );
  try {
    const cli = resolve("dist/src/cli.js");
    const { stdout } = await exec(process.execPath, [cli, "validate", graphPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.match(stdout, /Graph valid: 1 node/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI init creates a runnable default graph and exposes operator artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-init-"));
  const graphPath = join(root, ".agent-graph", "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const cli = resolve("dist/src/cli.js");
  try {
    const initialized = await exec(process.execPath, [cli, "init", graphPath, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    const created = JSON.parse(initialized.stdout) as { graph: { run: { repository: string } } };
    assert.equal(created.graph.run.repository, ".");
    const validated = await exec(process.execPath, [cli, "validate", "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal((JSON.parse(validated.stdout) as { valid: boolean }).valid, true);
    const doctor = JSON.parse((await exec(process.execPath, [cli, "doctor", "--json"], { cwd: root, encoding: "utf8" })).stdout) as { ok: boolean };
    assert.equal(doctor.ok, true);
    await exec(process.execPath, [cli, "run", "--json"], { cwd: root, encoding: "utf8" });

    const runs = JSON.parse((await exec(process.execPath, [cli, "runs", "--json"], { cwd: root, encoding: "utf8" })).stdout) as Array<{ status: string }>;
    assert.equal(runs[0]!.status, "completed");
    await mkdir(join(root, ".agent-graph", "runs", "lock-only"), { recursive: true });
    const runsWithOrphan = JSON.parse((await exec(process.execPath, [cli, "runs", "--json"], { cwd: root, encoding: "utf8" })).stdout) as Array<{ status: string }>;
    assert.equal(runsWithOrphan.length, 1);
    const events = JSON.parse((await exec(process.execPath, [cli, "events", "--json"], { cwd: root, encoding: "utf8" })).stdout) as unknown[];
    assert.ok(events.length > 0);
    const report = JSON.parse((await exec(process.execPath, [cli, "report", "--json"], { cwd: root, encoding: "utf8" })).stdout) as { content: string };
    assert.match(report.content, /Run status: completed/);
    assert.match((await exec(process.execPath, [cli, "graph"], { cwd: root, encoding: "utf8" })).stdout, /flowchart TD/);
    const graphOutput = JSON.parse((await exec(process.execPath, [cli, "graph", "--json"], { cwd: root, encoding: "utf8" })).stdout) as { format: string; content: string };
    assert.equal(graphOutput.format, "mermaid");
    assert.match(graphOutput.content, /flowchart TD/);
    assert.equal((JSON.parse((await exec(process.execPath, [cli, "schema"], { cwd: root, encoding: "utf8" })).stdout) as { title: string }).title, "Agent Graph Runtime graph");
    assert.equal((JSON.parse((await exec(process.execPath, [cli, "node", "explain", "verify", "--json"], { cwd: root, encoding: "utf8" })).stdout) as { id: string }).id, "verify");
    const completion = (await exec(process.execPath, [cli, "completion", "powershell"], { cwd: root, encoding: "utf8" })).stdout;
    assert.match(completion, /Register-ArgumentCompleter/);
    assert.match(completion, /\bunlock\b/);
    assert.match(completion, /\bprogress\b/);
    assert.match(completion, /\bfollow\b/);
    assert.match(completion, /\bwait\b/);
    assert.match(completion, /\binspect\b/);
    assert.match(completion, /\bwhy\b/);
    assert.match(completion, /\badvisor\b/);
    await assert.rejects(
      exec(process.execPath, [cli, "init", graphPath], { cwd: root, encoding: "utf8" }),
      (error: unknown) => (error as { code?: number }).code === 3,
    );
    await assert.rejects(
      exec(process.execPath, [cli, "status", "--unknown"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => (error as { code?: number; stderr?: string }).code === 3 && /agr help/.test((error as { stderr?: string }).stderr ?? ""),
    );
    await assert.rejects(
      exec(process.execPath, [cli, "run", "--dry-run"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => (error as { code?: number }).code === 3,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI init makes custom graph paths portable and run IDs unique", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-custom-init-"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  const cli = resolve("dist/src/cli.js");
  const firstPath = join(root, "config", "first.json");
  const secondPath = join(root, "config", "nested", "second.json");
  try {
    const first = JSON.parse((await exec(process.execPath, [cli, "init", firstPath, "--json"], { cwd: root, encoding: "utf8" })).stdout) as { graph: { run: { id: string; repository: string } } };
    const second = JSON.parse((await exec(process.execPath, [cli, "init", secondPath, "--json"], { cwd: root, encoding: "utf8" })).stdout) as { graph: { run: { id: string; repository: string } } };
    assert.notEqual(first.graph.run.id, second.graph.run.id);
    assert.equal(first.graph.run.repository, "..");
    assert.equal(second.graph.run.repository, "../..");
    await exec(process.execPath, [cli, "run", secondPath, "--json"], { cwd: root, encoding: "utf8" });
    await readFile(join(root, ".agent-graph", "runs", second.graph.run.id, "state.json"), "utf8");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI rejects cancellation of a stale owner and watch exits on orphaned state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-stale-owner-"));
  const graphPath = join(root, ".agent-graph", "graph.json");
  await exec("git", ["init", "--quiet"], { cwd: root });
  const cli = resolve("dist/src/cli.js");
  try {
    const created = JSON.parse((await exec(process.execPath, [cli, "init", graphPath, "--json"], { cwd: root, encoding: "utf8" })).stdout) as { graph: { run: { id: string } } };
    await exec(process.execPath, [cli, "run"], { cwd: root, encoding: "utf8" });
    const runRoot = join(root, ".agent-graph", "runs", created.graph.run.id);
    await writeFile(join(runRoot, ".run.lock"), JSON.stringify({ token: "stale", pid: 2147483647, host: hostname(), startedAt: "2000-01-01T00:00:00.000Z" }));
    await assert.rejects(
      exec(process.execPath, [cli, "cancel", "--json"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        const candidate = error as { code?: number; stdout?: string };
        assert.equal(candidate.code, 3);
        assert.equal((JSON.parse(candidate.stdout ?? "{}") as { error?: { code?: string } }).error?.code, "RUN_NOT_ACTIVE");
        return true;
      },
    );
    await rm(join(runRoot, ".run.lock"), { force: true });
    const statePath = join(runRoot, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { status: string };
    state.status = "running";
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(
      exec(process.execPath, [cli, "status", "--watch", "--interval-ms", "25", "--json"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => (error as { code?: number }).code === 1,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("CLI plan emits machine-readable execution waves without running nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-plan-"));
  const graphPath = join(root, "graph.json");
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: {
        id: "planned",
        objective: "plan",
        repository: ".",
        maxConcurrency: 2,
        advisor: { executor: "codex", model: "gpt-5.6-sol", stopOnBlocker: true },
      },
      nodes: [
        { id: "research", type: "review", executor: "codex", prompt: "Review", needs: [], owns: [], checks: [], maxAttempts: 1 },
        { id: "contract", type: "agent", executor: "claude", prompt: "Implement", needs: [], owns: ["docs/**"], checks: [], maxAttempts: 1 },
        { id: "gate", type: "human_gate", target: "release", needs: ["research", "contract"], owns: [], checks: [], maxAttempts: 1 },
        { id: "release", type: "external_action", executor: "shell", target: "release", needs: ["gate"], owns: [], checks: ["echo release"], maxAttempts: 1 },
      ],
    }),
    "utf8",
  );
  try {
    const cli = resolve("dist/src/cli.js");
    const { stdout } = await exec(process.execPath, [cli, "plan", graphPath, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    const plan = JSON.parse(stdout) as {
      runId: string;
      advisor?: { executor: string; model?: string; stopOnBlocker?: boolean };
      waves: Array<{ nodes: Array<{ id: string; gate: boolean }> }>;
    };
    assert.equal(plan.runId, "planned");
    assert.deepEqual(plan.advisor, { executor: "codex", model: "gpt-5.6-sol", stopOnBlocker: true });
    assert.deepEqual(plan.waves.map((wave) => wave.nodes.map((node) => node.id)), [
      ["research", "contract"],
      ["gate"],
      ["release"],
    ]);
    assert.equal(plan.waves[1]!.nodes[0]!.gate, true);
    const human = await exec(process.execPath, [cli, "plan", graphPath], { cwd: root, encoding: "utf8" });
    assert.match(human.stdout, /Repository:/);
    assert.match(human.stdout, /Advisor: codex\/gpt-5\.6-sol \(stops on blocker\)/);
    assert.match(human.stdout, /owns: docs\/\*\*/);
    assert.match(human.stdout, /target: release/);
    await assert.rejects(readFile(join(root, ".agent-graph", "runs", "planned", "state.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI resolves a relative repository from the graph file directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-cli-graph-root-"));
  const config = join(root, "config");
  const repository = join(root, "repository");
  const caller = join(root, "other", "caller");
  await Promise.all([
    mkdir(config, { recursive: true }),
    mkdir(repository, { recursive: true }),
    mkdir(caller, { recursive: true }),
  ]);
  await exec("git", ["init", "--quiet"], { cwd: repository });
  const graphPath = join(config, "graph.json");
  await writeFile(
    graphPath,
    JSON.stringify({
      version: 1,
      run: { id: "portable-graph", objective: "portable", repository: "../repository", maxConcurrency: 1 },
      nodes: [{ id: "check", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }],
    }),
    "utf8",
  );

  try {
    const cli = resolve("dist/src/cli.js");
    const { stdout } = await exec(process.execPath, [cli, "run", graphPath], {
      cwd: caller,
      encoding: "utf8",
    });
    assert.match(stdout, /Run portable-graph: completed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "CLI run dispatches a Claudex node through a PATH-resolved PowerShell launcher",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-cli-claudex-"));
    const graphPath = join(root, "graph.json");
    const launcherPath = join(root, "claudex.ps1");
    const fakeClaudePath = join(root, "fake-claude.mjs");
    await exec("git", ["init", "--quiet"], { cwd: root });
    await writeFile(
      launcherPath,
      `& $env:AGR_TEST_NODE $env:AGR_TEST_SCRIPT @args
exit $LASTEXITCODE
`,
      "utf8",
    );
    await writeFile(
      fakeClaudePath,
      `const args = process.argv.slice(2);
const schemaIndex = args.indexOf("--json-schema");
JSON.parse(args[schemaIndex + 1]);
const handoff = { status: "complete", summary: "claudex cli done", changedFiles: [], verification: ["ok"], gaps: [] };
process.stdout.write(JSON.stringify({ type: "result", structured_output: handoff }));
`,
      "utf8",
    );
    await writeFile(
      graphPath,
      JSON.stringify({
        version: 1,
        run: { id: "cli-claudex", objective: "dispatch", repository: ".", maxConcurrency: 1 },
        nodes: [
          {
            id: "review",
            type: "review",
            executor: "claudex",
            prompt: "read only",
            needs: [],
            owns: [],
            checks: [],
            maxAttempts: 1,
          },
        ],
      }),
      "utf8",
    );

    try {
      const cli = resolve("dist/src/cli.js");
      const { stdout } = await exec(process.execPath, [cli, "run", graphPath], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root};${process.env.PATH ?? ""}`,
          AGR_TEST_NODE: process.execPath,
          AGR_TEST_SCRIPT: fakeClaudePath,
        },
      });
      assert.match(stdout, /Run cli-claudex: completed/);
      assert.match(stdout, /review: accepted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "CLI exits 5 when a semantic handoff needs operator attention",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-cli-attention-"));
    const graphPath = join(root, "graph.json");
    const launcherPath = join(root, "claudex.ps1");
    const fakeClaudePath = join(root, "fake-claude.mjs");
    await exec("git", ["init", "--quiet"], { cwd: root });
    await writeFile(launcherPath, `& $env:AGR_TEST_NODE $env:AGR_TEST_SCRIPT @args\nexit $LASTEXITCODE\n`, "utf8");
    await writeFile(
      fakeClaudePath,
      `const handoff = { status: "partial", summary: "worker still active", changedFiles: [], verification: [], gaps: ["join pending work"] };
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "SECRET_ACTIVITY_PAYLOAD" } }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", structured_output: handoff }) + "\\n");
`,
      "utf8",
    );
    await writeFile(
      graphPath,
      JSON.stringify({
        version: 1,
        run: { id: "cli-attention", objective: "stop safely", repository: ".", maxConcurrency: 1 },
        nodes: [{ id: "agent", type: "agent", executor: "claudex", prompt: "work directly", needs: [], owns: [], checks: [], maxAttempts: 2 }],
      }),
      "utf8",
    );

    try {
      const cli = resolve("dist/src/cli.js");
      await assert.rejects(
        exec(process.execPath, [cli, "run", graphPath, "--json"], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: `${root};${process.env.PATH ?? ""}`, AGR_TEST_NODE: process.execPath, AGR_TEST_SCRIPT: fakeClaudePath },
        }),
        (error: unknown) => {
          const result = error as { code?: number; stdout?: string; stderr?: string };
          assert.equal(result.code, 5);
          const state = JSON.parse(result.stdout ?? "{}") as { status?: string; nodes?: Record<string, { attempts?: number; retryBlocked?: boolean }> };
          assert.equal(state.status, "needs_attention");
          assert.equal(state.nodes?.agent?.attempts, 1);
          assert.equal(state.nodes?.agent?.retryBlocked, true);
          assert.match(result.stderr ?? "", /Claudex assistant:tool_use/);
          assert.doesNotMatch(result.stderr ?? "", /SECRET_ACTIVITY_PAYLOAD|Bash/);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
