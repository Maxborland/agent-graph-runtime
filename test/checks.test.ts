import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

