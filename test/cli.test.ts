import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

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

