import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  findUnexpectedChanges,
  gitChangedFiles,
  gitChangeSnapshot,
} from "../src/repository.js";

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

test("ownership detects another write to an already dirty unowned path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-dirty-ownership-"));
  try {
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "dirty.txt"), "initial\n");
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });

    await writeFile(join(root, "dirty.txt"), "user change\n");
    const baseline = await gitChangeSnapshot(root);
    await writeFile(join(root, "dirty.txt"), "concurrent overwrite\n");

    assert.deepEqual(await findUnexpectedChanges(root, baseline, ["src/**"]), ["dirty.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "ownership detects an executable-mode change to an already dirty path",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agr-dirty-mode-"));
    try {
      await exec("git", ["init", "--quiet"], { cwd: root });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
      await exec("git", ["config", "user.name", "Test"], { cwd: root });
      const path = join(root, "dirty.sh");
      await writeFile(path, "#!/bin/sh\n");
      await exec("git", ["add", "."], { cwd: root });
      await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: root });
      await writeFile(path, "#!/bin/sh\necho user\n");
      const baseline = await gitChangeSnapshot(root);
      await chmod(path, 0o755);
      assert.deepEqual(await findUnexpectedChanges(root, baseline, []), ["dirty.sh"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("ownership detects another write inside an already dirty submodule", async () => {
  const source = await mkdtemp(join(tmpdir(), "agr-submodule-source-"));
  const root = await mkdtemp(join(tmpdir(), "agr-submodule-parent-"));
  try {
    for (const repository of [source, root]) {
      await exec("git", ["init", "--quiet"], { cwd: repository });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: repository });
      await exec("git", ["config", "user.name", "Test"], { cwd: repository });
    }
    await writeFile(join(source, "tracked.txt"), "initial\n");
    await exec("git", ["add", "."], { cwd: source });
    await exec("git", ["commit", "--quiet", "-m", "initial"], { cwd: source });
    await exec("git", ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, "sub"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-am", "add submodule"], { cwd: root });

    const nestedFile = join(root, "sub", "tracked.txt");
    await writeFile(nestedFile, "user change\n");
    const baseline = await gitChangeSnapshot(root);
    await writeFile(nestedFile, "concurrent overwrite\n");

    assert.deepEqual(await findUnexpectedChanges(root, baseline, []), ["sub"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
