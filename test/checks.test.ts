import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runChecks } from "../src/checks.js";

test("checks capture evidence and fail on nonzero exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-checks-"));
  try {
    const results = await runChecks(
      root,
      [
        `${JSON.stringify(process.execPath)} -e "console.log('pass')"`,
        `${JSON.stringify(process.execPath)} -e "console.error('fail'); process.exit(3)"`,
      ],
      10_000,
    );

    assert.deepEqual(results.map((result) => result.exitCode), [0, 3]);
    assert.match(results[0]!.stdout, /pass/);
    assert.match(results[1]!.stderr, /fail/);
    assert.equal(results.every((result) => result.exitCode === 0), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checks terminate on timeout and cooperative cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-check-cancel-"));
  try {
    const timed = await runChecks(
      root,
      [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`],
      100,
    );
    assert.equal(timed[0]!.timedOut, true);
    assert.equal(timed[0]!.exitCode, 124);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const cancelled = await runChecks(
      root,
      [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`],
      10_000,
      controller.signal,
    );
    assert.equal(cancelled[0]!.cancelled, true);
    assert.equal(cancelled[0]!.exitCode, 130);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test(
  "checks expose unconfirmed process-tree termination as terminal evidence",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-check-tree-failure-"));
    const fakeTaskkill = join(root, "taskkill.exe");
    const childScript = join(root, "child.mjs");
    const pidPath = join(root, "child.pid");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTaskkill = process.env.AGR_TEST_TASKKILL_PATH;
    await writeFile(fakeTaskkill, "not executable", "utf8");
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setTimeout(() => {}, 10000);`,
      "utf8",
    );
    process.env.NODE_ENV = "test";
    process.env.AGR_TEST_TASKKILL_PATH = fakeTaskkill;
    try {
      const results = await runChecks(
        root,
        [`${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)}`],
        100,
      );
      assert.equal(results[0]!.timedOut, true);
      assert.match(results[0]!.terminationError ?? "", /spawn|taskkill/i);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousTaskkill === undefined) delete process.env.AGR_TEST_TASKKILL_PATH;
      else process.env.AGR_TEST_TASKKILL_PATH = previousTaskkill;
      try {
        process.kill(Number(await import("node:fs/promises").then(({ readFile }) => readFile(pidPath, "utf8"))));
      } catch {
        // The child may have already exited.
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test(
  "checks mark a successful tree-kill helper without process close as unconfirmed",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-check-tree-no-close-"));
    const fakeTaskkill = join(root, "taskkill.cmd");
    const childScript = join(root, "child.mjs");
    const pidPath = join(root, "child.pid");
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTaskkill = process.env.AGR_TEST_TASKKILL_PATH;
    await writeFile(fakeTaskkill, "@exit /b 0\r\n", "utf8");
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setTimeout(() => {}, 10000);`,
      "utf8",
    );
    process.env.NODE_ENV = "test";
    process.env.AGR_TEST_TASKKILL_PATH = fakeTaskkill;
    try {
      const results = await runChecks(
        root,
        [`${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)}`],
        100,
      );
      assert.equal(results[0]!.timedOut, true);
      assert.match(results[0]!.terminationError ?? "", /not confirmed/i);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousTaskkill === undefined) delete process.env.AGR_TEST_TASKKILL_PATH;
      else process.env.AGR_TEST_TASKKILL_PATH = previousTaskkill;
      try {
        process.kill(Number(await import("node:fs/promises").then(({ readFile }) => readFile(pidPath, "utf8"))));
      } catch {
        // The child may have already exited.
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
