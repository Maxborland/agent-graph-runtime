import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { runChecks } from "./checks.js";
import { matchesGlob } from "./repository.js";
import type { GraphNodeDefinition } from "./types.js";
import { verifyWorkerResult, type WorkerResultEnvelope } from "./worker-protocol.js";

const exec = promisify(execFile);

export async function verifyWorkerResultInIsolation(
  coordinatorWorktree: string,
  node: GraphNodeDefinition,
  result: WorkerResultEnvelope,
  expected: { attemptId: string; workerId: string; fencingToken: number },
): Promise<void> {
  verifyWorkerResult(result, expected);
  const temporaryParent = await mkdtemp(join(tmpdir(), "agr-worker-acceptance-"));
  const isolatedWorktree = join(temporaryParent, "worktree");
  let attached = false;
  try {
    await exec("git", ["worktree", "add", "--detach", isolatedWorktree, "HEAD"], { cwd: coordinatorWorktree, encoding: "utf8" });
    attached = true;
    await applyVerifiedWorkerResult(isolatedWorktree, node, result, expected);
  } finally {
    if (attached) await exec("git", ["worktree", "remove", "--force", isolatedWorktree], { cwd: coordinatorWorktree, encoding: "utf8" }).catch(() => undefined);
    await rm(temporaryParent, { recursive: true, force: true });
  }
}

export async function applyVerifiedWorkerResult(
  coordinatorWorktree: string,
  node: GraphNodeDefinition,
  result: WorkerResultEnvelope,
  expected: { attemptId: string; workerId: string; fencingToken: number },
): Promise<void> {
  verifyWorkerResult(result, expected);
  const ownership = [...node.owns, ...(node.implicitOutputs ?? [])];
  for (const file of result.patch.files) {
    if (!ownership.some((pattern) => matchesGlob(file.path, pattern))) throw new Error(`worker patch escapes node ownership: ${file.path}`);
  }
  const previous = new Map<string, Buffer | undefined>();
  try {
    for (const file of result.patch.files) {
      const path = await safeWritablePath(coordinatorWorktree, file.path);
      const current = await readFile(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      previous.set(path, current);
      await writeFile(path, Buffer.from(file.contentBase64, "base64"));
    }
    const checks = await runChecks(coordinatorWorktree, node.checks, node.timeoutMs ?? 20 * 60_000);
    const failed = checks.find((check) => check.exitCode !== 0 || check.timedOut || check.cancelled);
    if (failed) throw new Error(`coordinator check failed: ${failed.command}`);
  } catch (error) {
    for (const [path, bytes] of previous) {
      if (bytes === undefined) await rm(path, { force: true });
      else await writeFile(path, bytes);
    }
    throw error;
  }
}

async function safeWritablePath(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new Error(`worker patch path escapes coordinator root: ${relativePath}`);
  const canonicalRoot = await realpath(resolve(root));
  const path = resolve(canonicalRoot, relativePath);
  const rel = relative(canonicalRoot, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error(`worker patch path escapes coordinator root: ${relativePath}`);
  await mkdir(dirname(path), { recursive: true });
  const canonicalParent = await realpath(dirname(path));
  const parentRel = relative(canonicalRoot, canonicalParent);
  if (parentRel === ".." || parentRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(parentRel)) throw new Error(`worker patch parent escapes coordinator root: ${relativePath}`);
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isSymbolicLink()) throw new Error(`worker patch may not replace a symlink: ${relativePath}`);
  return path;
}
