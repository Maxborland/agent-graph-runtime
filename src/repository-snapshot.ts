import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./persistence.js";
import { gitChangeSnapshot } from "./repository.js";

const exec = promisify(execFile);

export async function repositorySnapshotHash(worktree: string): Promise<string> {
  const head = await repositoryHead(worktree);
  const snapshot = Object.fromEntries(Object.entries(await gitChangeSnapshot(worktree))
    .filter(([path]) => path !== ".agent-graph" && !path.startsWith(".agent-graph/"))
    .sort(([left], [right]) => left.localeCompare(right)));
  return sha256(JSON.stringify({ head, snapshot }));
}

export async function repositoryHead(worktree: string): Promise<string> {
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" })).stdout.trim();
}

export async function repositorySnapshotTransfer(worktree: string, workerHead: string): Promise<{ commit: string; bundleBase64?: string }> {
  const commit = await repositoryHead(worktree);
  if (commit === workerHead) return { commit };
  await exec("git", ["merge-base", "--is-ancestor", workerHead, commit], { cwd: worktree, encoding: "utf8" }).catch(() => {
    throw new Error("worker repository HEAD is not an ancestor of the coordinator snapshot");
  });
  const temporary = await mkdtemp(join(tmpdir(), "agr-snapshot-transfer-"));
  const bundlePath = join(temporary, "snapshot.bundle");
  try {
    await exec("git", ["bundle", "create", bundlePath, "HEAD", `^${workerHead}`], { cwd: worktree, encoding: "utf8" });
    return { commit, bundleBase64: (await readFile(bundlePath)).toString("base64") };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
