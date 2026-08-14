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
