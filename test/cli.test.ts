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
