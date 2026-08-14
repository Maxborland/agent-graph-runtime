import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveSpawnCommand } from "../src/adapters.js";

test("Windows command resolution respects PATH order and wraps an npm cmd shim", async () => {
  const first = await mkdtemp(join(tmpdir(), "agr-path-first-"));
  const second = await mkdtemp(join(tmpdir(), "agr-path-second-"));
  await writeFile(join(first, "tool.cmd"), "@echo off\r\n");
  await writeFile(join(second, "tool.exe"), "fixture");

  try {
    const resolved = await resolveSpawnCommand(
      "tool",
      ["arg"],
      { PATH: `${first};${second}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "cmd.exe" },
      "win32",
    );
    assert.equal(resolved.command, "cmd.exe");
    assert.deepEqual(resolved.args, ["/d", "/s", "/c", join(first, "tool.cmd"), "arg"]);
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});

test("Windows command resolution invokes a PowerShell launcher non-interactively", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-path-ps1-"));
  const launcher = join(root, "claudex.ps1");
  await writeFile(launcher, "exit 0\r\n");

  try {
    const resolved = await resolveSpawnCommand(
      "claudex",
      ["-p", "--output-format", "json"],
      { PATH: root },
      "win32",
    );
    assert.equal(resolved.command, "pwsh.exe");
    assert.deepEqual(resolved.args, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      launcher,
      "-p",
      "--output-format",
      "json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
