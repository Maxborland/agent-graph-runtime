import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./persistence.js";
import { runtimeGitName } from "./run-id.js";
import { matchesGlob } from "./repository.js";
import type { CheckpointRecord, GraphDefinition, RunResult, RunState } from "./types.js";

const exec = promisify(execFile);

export class GitRunTransaction {
  private constructor(
    readonly repositoryRoot: string,
    readonly worktreePath: string,
    readonly runBranch: string,
    readonly baseCommit: string,
  ) {}

  static required(graph: GraphDefinition): boolean {
    return Boolean(graph.run.automaticPolicy?.allowReversiblePatches) ||
      graph.nodes.some((node) => node.owns.length > 0 || (node.implicitOutputs?.length ?? 0) > 0);
  }

  static async prepare(
    repositoryRoot: string,
    graph: GraphDefinition,
    persistedBaseCommit?: string,
  ): Promise<GitRunTransaction | undefined> {
    if (!GitRunTransaction.required(graph)) return undefined;
    if (graph.run.baseCommit && persistedBaseCommit && graph.run.baseCommit !== persistedBaseCommit) {
      throw new Error("graph baseCommit does not match the persisted run base commit");
    }
    const baseCommit = graph.run.baseCommit ?? persistedBaseCommit ?? await git(repositoryRoot, ["rev-parse", "HEAD"]);
    await git(repositoryRoot, ["cat-file", "-e", `${baseCommit}^{commit}`]);
    if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
      throw new Error("writing runs require a repository with an existing base commit");
    }
    const safeRunId = runtimeGitName(graph.run.id);
    const worktreePath = join(repositoryRoot, ".worktrees", safeRunId);
    const runBranch = `agr/run/${safeRunId}`;
    await ensureWorktreeExclude(repositoryRoot);

    if (await isGitWorktree(worktreePath)) {
      const existingBranch = await git(worktreePath, ["branch", "--show-current"]);
      if (existingBranch !== runBranch) {
        throw new Error(`run worktree ${worktreePath} is attached to unexpected branch ${existingBranch || "detached"}`);
      }
    } else if (await branchExists(repositoryRoot, runBranch)) {
      await exec("git", ["worktree", "add", worktreePath, runBranch], { cwd: repositoryRoot, encoding: "utf8" });
    } else {
      await exec("git", ["worktree", "add", "-b", runBranch, worktreePath, baseCommit], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
    }
    const branchBase = await git(repositoryRoot, ["merge-base", baseCommit, runBranch]);
    if (branchBase !== baseCommit) {
      throw new Error(`run branch ${runBranch} no longer descends from base commit ${baseCommit}`);
    }
    return new GitRunTransaction(repositoryRoot, worktreePath, runBranch, baseCommit);
  }

  async checkpoint(
    planRevisionId: string,
    acceptedAttemptIds: string[],
    evidenceDigest: string,
    ownershipPatterns: string[],
  ): Promise<CheckpointRecord> {
    const changed = (await changedPaths(this.worktreePath)).filter((path) =>
      ownershipPatterns.some((pattern) => matchesGlob(path, pattern))
    );
    if (changed.length > 0) {
      await exec("git", ["add", "-A", "--", ...changed.map((path) => `:(literal)${path}`)], {
        cwd: this.worktreePath,
        encoding: "utf8",
      });
      const message = [
        `AGR checkpoint ${acceptedAttemptIds.join(", ") || "wave"}`,
        "",
        `AGR-Plan-Revision: ${planRevisionId}`,
        `AGR-Attempts: ${acceptedAttemptIds.join(",")}`,
        `AGR-Evidence-Digest: ${evidenceDigest}`,
      ].join("\n");
      await exec("git", ["commit", "-m", message], { cwd: this.worktreePath, encoding: "utf8" });
    }
    const commit = await git(this.worktreePath, ["rev-parse", "HEAD"]);
    return {
      schemaVersion: 1,
      checkpointId: `checkpoint-${sha256(`${commit}\0${acceptedAttemptIds.join(",")}`).slice(0, 24)}`,
      commit,
      planRevisionId,
      acceptedAttemptIds: [...acceptedAttemptIds],
      evidenceDigest,
      createdAt: new Date().toISOString(),
    };
  }

  async finalize(runDirectory: string, state: RunState): Promise<RunResult> {
    const existingPath = join(runDirectory, "result.json");
    try {
      const existing = JSON.parse(await readFile(existingPath, "utf8")) as RunResult;
      if (existing.runId !== state.runId || existing.baseCommit !== this.baseCommit) {
        throw new Error("immutable run result does not match current run identity");
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((await changedPaths(this.worktreePath)).length > 0) {
      throw new Error("cannot finalize run result while the run worktree has uncommitted changes");
    }
    const resultCommit = await git(this.worktreePath, ["rev-parse", "HEAD"]);
    const evidenceDigest = digestAcceptedEvidence(state);
    const content = {
      schemaVersion: 1 as const,
      runId: state.runId,
      repositoryId: state.repository.repositoryId,
      baseCommit: this.baseCommit,
      resultCommit,
      planRevisionId: state.activePlanRevisionId,
      checkpoints: [...(state.git?.checkpoints ?? [])],
      evidenceDigest,
      completedAt: new Date().toISOString(),
    };
    const result: RunResult = {
      ...content,
      resultId: `result-${sha256(JSON.stringify(content)).slice(0, 24)}`,
    };
    await writeFile(existingPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return result;
  }
}

export function digestAcceptedEvidence(state: RunState): string {
  const evidence = Object.values(state.attempts)
    .filter((attempt) => attempt.status === "accepted")
    .flatMap((attempt) => attempt.evidence.map((item) => `${attempt.attemptId}:${item.sha256}`))
    .sort();
  return sha256(JSON.stringify(evidence));
}

async function ensureWorktreeExclude(repositoryRoot: string): Promise<void> {
  const commonRaw = await git(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  const commonDirectory = isAbsolute(commonRaw) ? commonRaw : resolve(repositoryRoot, commonRaw);
  const excludePath = join(commonDirectory, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.split(/\r?\n/).includes(".worktrees/")) return;
  await writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.worktrees/\n`, "utf8");
}

async function changedPaths(worktreePath: string): Promise<string[]> {
  const output = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: worktreePath,
    encoding: "utf8",
  })).stdout;
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path !== ".agent-graph" && !path.startsWith(".agent-graph/")) paths.push(path);
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
      paths.push(entries[index + 1]!);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

async function branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  try {
    await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repositoryRoot });
    return true;
  } catch {
    return false;
  }
}

async function isGitWorktree(path: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
