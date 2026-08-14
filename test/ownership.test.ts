import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { findUnexpectedChanges, gitChangedFiles } from "../src/repository.js";

const exec = promisify(execFile);

test("ownership reports only new changed paths outside declared patterns", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-ownership-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "baseline.txt"), "initial\n");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });

    await writeFile(join(root, "baseline.txt"), "user change\n");
    const baseline = await gitChangedFiles(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "owned.ts"), "export {};\n");
    await writeFile(join(root, "unexpected.txt"), "escape\n");

    assert.deepEqual(
      await findUnexpectedChanges(root, baseline, ["src/**"]),
      ["unexpected.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ownership detects a rename from an owned path to an unowned path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-rename-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "owned.ts"), "export {};\n");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });

    await exec("git", ["mv", "src/owned.ts", "escaped.ts"], { cwd: root });

    assert.deepEqual(await findUnexpectedChanges(root, [], ["src/**"]), ["escaped.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
