import assert from "node:assert/strict";
import { open, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireRunLock, recoverRunLock } from "../src/run-lock.js";

test("stale lock takeover produces exactly one owner under contention", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-lock-race-"));
  const runRoot = join(root, ".agent-graph", "runs", "race");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runRoot, { recursive: true }));
    await writeFile(
      join(runRoot, ".run.lock"),
      JSON.stringify({ token: "stale", pid: 2147483647, host: hostname(), startedAt: "2000-01-01T00:00:00.000Z" }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => acquireRunLock(root, "race")),
    );
    const owners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireRunLock>>> => result.status === "fulfilled");
    assert.equal(owners.length, 1);
    await owners[0]!.value.release();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("an initializing lock is never deleted by a contender", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-lock-partial-"));
  const runRoot = join(root, ".agent-graph", "runs", "partial");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runRoot, { recursive: true }));
    const handle = await open(join(runRoot, ".run.lock"), "wx");
    try {
      await assert.rejects(acquireRunLock(root, "partial"), /initializing/);
      await handle.writeFile(JSON.stringify({ token: "winner", pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    } finally {
      await handle.close();
    }
    await assert.rejects(acquireRunLock(root, "partial"), /already owned/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("an abandoned initializing lock requires explicit force recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-lock-abandoned-partial-"));
  const runRoot = join(root, ".agent-graph", "runs", "abandoned-partial");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runRoot, { recursive: true }));
    await writeFile(join(runRoot, ".run.lock"), "");
    await assert.rejects(recoverRunLock(root, "abandoned-partial", false), /--force/);
    assert.equal(await recoverRunLock(root, "abandoned-partial", true), undefined);
    const lock = await acquireRunLock(root, "abandoned-partial");
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("an abandoned partial recovery guard can be force-recovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-lock-abandoned-guard-"));
  const runRoot = join(root, ".agent-graph", "runs", "abandoned-guard");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runRoot, { recursive: true }));
    await writeFile(join(runRoot, ".run.lock"), "");
    await writeFile(join(runRoot, ".run.lock.recovery"), "");
    await assert.rejects(recoverRunLock(root, "abandoned-guard", false), /--force/);
    assert.equal(await recoverRunLock(root, "abandoned-guard", true), undefined);
    const lock = await acquireRunLock(root, "abandoned-guard");
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("foreign stale locks require explicit force recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-lock-foreign-"));
  const runRoot = join(root, ".agent-graph", "runs", "foreign");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runRoot, { recursive: true }));
    await writeFile(join(runRoot, ".run.lock"), JSON.stringify({ token: "foreign", pid: 1, host: "another-host", startedAt: "2000-01-01T00:00:00.000Z" }));
    await assert.rejects(recoverRunLock(root, "foreign", false), /--force/);
    const recovered = await recoverRunLock(root, "foreign", true);
    assert.equal(recovered?.token, "foreign");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a confirmed PID-reuse lock can be recovered only with force", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-lock-pid-reuse-"));
  const runRoot = join(root, ".agent-graph", "runs", "pid-reuse");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(runRoot, { recursive: true }));
    await writeFile(
      join(runRoot, ".run.lock"),
      JSON.stringify({ token: "old-owner", pid: process.pid, host: hostname(), startedAt: "2000-01-01T00:00:00.000Z" }),
    );
    await assert.rejects(recoverRunLock(root, "pid-reuse", false), /live PID/);
    const recovered = await recoverRunLock(root, "pid-reuse", true);
    assert.equal(recovered?.token, "old-owner");
    const lock = await acquireRunLock(root, "pid-reuse");
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
