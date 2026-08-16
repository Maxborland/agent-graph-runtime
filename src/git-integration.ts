import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { digestAcceptedEvidence } from "./git-transaction.js";
import { verifyRunEvidenceArtifacts } from "./evidence.js";
import { readRunStateArtifact } from "./observation.js";
import { sha256 } from "./persistence.js";
import { assertSafeRunId, runtimeGitName } from "./run-id.js";
import { acquireRunLock } from "./run-lock.js";
import type { RunResult } from "./types.js";

const exec = promisify(execFile);

export interface IntegrationRecord {
  schemaVersion: 1;
  integrationId: string;
  runId: string;
  resultId: string;
  targetBranch: string;
  targetBefore: string;
  targetAfter: string;
  mode: "fast-forward" | "cherry-pick" | "conflict";
  integratedCommits: string[];
  createdAt: string;
}

export interface RollbackRecord {
  schemaVersion: 1;
  rollbackId: string;
  runId: string;
  integrationId: string;
  targetBranch: string;
  targetBefore: string;
  targetAfter: string;
  revertedCommits: string[];
  createdAt: string;
}

export type IntegrationOutcome = IntegrationRecord & { mutated: boolean };
export type RollbackOutcome = RollbackRecord & { mutated: boolean; conflict: boolean };

interface GitOperationIntent {
  schemaVersion: 1;
  operationId: string;
  kind: "integration" | "rollback";
  runId: string;
  targetBranch: string;
  targetBefore: string;
  commits: string[];
  expectedTree: string;
  resultId?: string;
  mode?: "fast-forward" | "cherry-pick";
  integrationId?: string;
  createdAt: string;
}

interface GitOperationResolution {
  schemaVersion: 1;
  operationId: string;
  outcome: "recorded" | "not_applied";
  resolvedAt: string;
}

export function currentBranch(repositoryRoot: string): Promise<string> {
  return git(repositoryRoot, ["branch", "--show-current"]);
}

export async function integrateRun(
  repositoryRoot: string,
  runId: string,
  targetBranch: string,
  dryRun: boolean,
): Promise<IntegrationOutcome> {
  assertSafeRunId(runId);
  const repositoryLock = await acquireRunLock(
    join(repositoryRoot, ".agent-graph", "coordination"),
    "git-operations",
  );
  const lock = await acquireRunLock(repositoryRoot, runId).catch(async (error) => {
    await repositoryLock.release();
    throw error;
  });
  try {
    return await integrateRunLocked(repositoryRoot, runId, targetBranch, dryRun);
  } finally {
    await lock.release();
    await repositoryLock.release();
  }
}

async function integrateRunLocked(
  repositoryRoot: string,
  runId: string,
  targetBranch: string,
  dryRun: boolean,
): Promise<IntegrationOutcome> {
  const runDirectory = join(repositoryRoot, ".agent-graph", "runs", runId);
  await reconcilePendingGitOperations(repositoryRoot, runDirectory);
  const result = await readAndVerifyResult(repositoryRoot, runDirectory, runId);
  if (await activeIntegrationForResult(runDirectory, result.resultId)) {
    throw new Error(`run ${runId} result ${result.resultId} is already integrated and not rolled back`);
  }
  const targetBefore = await git(repositoryRoot, ["rev-parse", `refs/heads/${targetBranch}`]);
  let mode: IntegrationRecord["mode"] = await isAncestor(repositoryRoot, targetBefore, result.resultCommit)
    ? "fast-forward"
    : "cherry-pick";
  if (!(await isAncestor(repositoryRoot, result.baseCommit, targetBefore))) {
    throw new Error(`target branch ${targetBranch} does not descend from run base ${result.baseCommit}`);
  }
  const integratedCommits = await commitsBetween(repositoryRoot, result.baseCommit, result.resultCommit);
  let expectedTree = await git(repositoryRoot, ["rev-parse", `${result.resultCommit}^{tree}`]);
  if (mode === "cherry-pick") {
    const cherryPreview = await previewCherryPick(repositoryRoot, runId, targetBefore, integratedCommits);
    expectedTree = cherryPreview.expectedTree ?? expectedTree;
    if (cherryPreview.conflict) mode = "conflict";
  }
  const preview: IntegrationRecord = {
    schemaVersion: 1,
    integrationId: `preview-${result.resultId}`,
    runId,
    resultId: result.resultId,
    targetBranch,
    targetBefore,
    targetAfter: mode === "fast-forward" ? result.resultCommit : targetBefore,
    mode,
    integratedCommits,
    createdAt: new Date().toISOString(),
  };
  if (dryRun) return { ...preview, mutated: false };
  if (mode === "conflict") {
    throw new Error(`run ${runId} conflicts with target branch ${targetBranch}; resolve target changes before integration`);
  }

  await requireCheckedOutTarget(repositoryRoot, targetBranch);
  await requireCleanProductCheckout(repositoryRoot);
  await requireUnchangedHead(repositoryRoot, targetBefore);
  const operationId = randomUUID();
  const intent: GitOperationIntent = {
    schemaVersion: 1,
    operationId,
    kind: "integration",
    runId,
    targetBranch,
    targetBefore,
    commits: integratedCommits,
    expectedTree,
    resultId: result.resultId,
    mode,
    createdAt: new Date().toISOString(),
  };
  await writeImmutableRecord(join(runDirectory, "operations", "intents"), operationId, intent);
  try {
    if (mode === "fast-forward") {
      await exec("git", ["merge", "--ff-only", result.resultCommit], { cwd: repositoryRoot, encoding: "utf8" });
    } else if (integratedCommits.length > 0) {
      await exec("git", ["cherry-pick", ...integratedCommits], { cwd: repositoryRoot, encoding: "utf8" });
    }
  } catch (error) {
    if (mode === "cherry-pick") {
      await exec("git", ["cherry-pick", "--abort"], { cwd: repositoryRoot, encoding: "utf8" }).catch(() => undefined);
    }
    await resolveIfTargetUnchanged(repositoryRoot, runDirectory, intent);
    throw error;
  }
  const targetAfter = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  const record: IntegrationRecord = {
    ...preview,
    integrationId: operationId,
    targetAfter,
    createdAt: new Date().toISOString(),
  };
  await writeImmutableRecord(join(runDirectory, "integrations"), record.integrationId, record);
  await writeOperationResolution(runDirectory, operationId, "recorded");
  return { ...record, mutated: true };
}

export async function rollbackRun(
  repositoryRoot: string,
  runId: string,
  dryRun: boolean,
): Promise<RollbackOutcome> {
  assertSafeRunId(runId);
  const repositoryLock = await acquireRunLock(
    join(repositoryRoot, ".agent-graph", "coordination"),
    "git-operations",
  );
  const lock = await acquireRunLock(repositoryRoot, runId).catch(async (error) => {
    await repositoryLock.release();
    throw error;
  });
  try {
    return await rollbackRunLocked(repositoryRoot, runId, dryRun);
  } finally {
    await lock.release();
    await repositoryLock.release();
  }
}

async function rollbackRunLocked(
  repositoryRoot: string,
  runId: string,
  dryRun: boolean,
): Promise<RollbackOutcome> {
  const runDirectory = join(repositoryRoot, ".agent-graph", "runs", runId);
  await reconcilePendingGitOperations(repositoryRoot, runDirectory);
  const integration = await latestActiveIntegration(runDirectory);
  if (!integration) throw new Error(`run ${runId} has no integration record to roll back`);
  if (await hasRollback(runDirectory, integration.integrationId)) {
    throw new Error(`integration ${integration.integrationId} is already rolled back`);
  }
  const targetBefore = await git(repositoryRoot, ["rev-parse", `refs/heads/${integration.targetBranch}`]);
  const revertedCommits = [...integration.integratedCommits].reverse();
  const revertPreview = await previewRevert(repositoryRoot, runId, targetBefore, revertedCommits);
  const conflict = revertPreview.conflict;
  const preview: RollbackRecord = {
    schemaVersion: 1,
    rollbackId: `preview-${integration.integrationId}`,
    runId,
    integrationId: integration.integrationId,
    targetBranch: integration.targetBranch,
    targetBefore,
    targetAfter: targetBefore,
    revertedCommits,
    createdAt: new Date().toISOString(),
  };
  if (dryRun) return { ...preview, mutated: false, conflict };
  if (conflict) {
    throw new Error(`rollback for run ${runId} conflicts with the current ${integration.targetBranch} branch`);
  }

  await requireCheckedOutTarget(repositoryRoot, integration.targetBranch);
  await requireCleanProductCheckout(repositoryRoot);
  await requireUnchangedHead(repositoryRoot, targetBefore);
  const operationId = randomUUID();
  const intent: GitOperationIntent = {
    schemaVersion: 1,
    operationId,
    kind: "rollback",
    runId,
    targetBranch: integration.targetBranch,
    targetBefore,
    commits: preview.revertedCommits,
    expectedTree: revertPreview.expectedTree ?? await git(repositoryRoot, ["rev-parse", `${targetBefore}^{tree}`]),
    integrationId: integration.integrationId,
    createdAt: new Date().toISOString(),
  };
  await writeImmutableRecord(join(runDirectory, "operations", "intents"), operationId, intent);
  try {
    if (preview.revertedCommits.length > 0) {
      await exec("git", ["revert", "--no-commit", ...preview.revertedCommits], { cwd: repositoryRoot, encoding: "utf8" });
      await exec("git", ["commit", "-m", `AGR rollback ${runId}\n\nAGR-Integration: ${integration.integrationId}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
    }
  } catch (error) {
    if (preview.revertedCommits.length > 0) {
      await exec("git", ["revert", "--abort"], { cwd: repositoryRoot, encoding: "utf8" }).catch(() => undefined);
    }
    await resolveIfTargetUnchanged(repositoryRoot, runDirectory, intent);
    throw error;
  }
  const record: RollbackRecord = {
    ...preview,
    rollbackId: operationId,
    targetAfter: await git(repositoryRoot, ["rev-parse", "HEAD"]),
    createdAt: new Date().toISOString(),
  };
  await writeImmutableRecord(join(runDirectory, "rollbacks"), record.rollbackId, record);
  await writeOperationResolution(runDirectory, operationId, "recorded");
  return { ...record, mutated: true, conflict: false };
}

async function readAndVerifyResult(
  repositoryRoot: string,
  runDirectory: string,
  runId: string,
): Promise<RunResult> {
  const result = JSON.parse(await readFile(join(runDirectory, "result.json"), "utf8")) as RunResult;
  if (result.schemaVersion !== 1 || result.runId !== runId) throw new Error("invalid immutable run result");
  const { resultId: _resultId, ...content } = result;
  const expectedId = `result-${sha256(JSON.stringify(content)).slice(0, 24)}`;
  if (result.resultId !== expectedId) throw new Error("immutable run result digest mismatch");
  await git(repositoryRoot, ["cat-file", "-e", `${result.resultCommit}^{commit}`]);
  const state = await readRunStateArtifact(repositoryRoot, runId);
  const repositoryIdentity = await canonicalPath(repositoryRoot);
  if (
    await canonicalPath(result.repositoryId) !== repositoryIdentity ||
    await canonicalPath(state.repository.root) !== repositoryIdentity ||
    await canonicalPath(state.repository.repositoryId) !== repositoryIdentity ||
    state.git?.resultId !== result.resultId
  ) {
    throw new Error("run result repository identity does not match the current repository");
  }
  if (result.evidenceDigest !== digestAcceptedEvidence(state)) {
    throw new Error("run result evidence digest no longer matches authoritative state");
  }
  await verifyRunEvidenceArtifacts(runDirectory, state);
  return result;
}

async function requireCheckedOutTarget(repositoryRoot: string, targetBranch: string): Promise<void> {
  const current = await git(repositoryRoot, ["branch", "--show-current"]);
  if (current !== targetBranch) {
    throw new Error(`target branch ${targetBranch} must be checked out explicitly before integration or rollback`);
  }
}

async function requireCleanProductCheckout(repositoryRoot: string): Promise<void> {
  const raw = (await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })).stdout;
  const productPaths = raw.split("\0").filter(Boolean).map((entry) => entry.slice(3)).filter(
    (path) => path !== ".agent-graph" && !path.startsWith(".agent-graph/") && path !== ".worktrees" && !path.startsWith(".worktrees/"),
  );
  if (productPaths.length > 0) {
    throw new Error(`target checkout has uncommitted product changes: ${productPaths.join(", ")}`);
  }
}

async function requireUnchangedHead(repositoryRoot: string, expected: string): Promise<void> {
  const current = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (current !== expected) throw new Error("target branch changed after integration preview; retry from a fresh preview");
}

async function commitsBetween(repositoryRoot: string, base: string, head: string): Promise<string[]> {
  const output = await git(repositoryRoot, ["rev-list", "--reverse", `${base}..${head}`]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

async function previewCherryPick(
  repositoryRoot: string,
  runId: string,
  targetCommit: string,
  commits: string[],
): Promise<{ conflict: boolean; expectedTree?: string }> {
  const safeRunId = runtimeGitName(runId);
  const previewPath = join(repositoryRoot, ".worktrees", `preview-${safeRunId}-${randomUUID()}`);
  await exec("git", ["worktree", "add", "--detach", previewPath, targetCommit], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  let conflict = false;
  let expectedTree: string | undefined;
  try {
    for (const commit of commits) {
      try {
        await exec("git", ["cherry-pick", commit], { cwd: previewPath, encoding: "utf8" });
      } catch {
        conflict = true;
        await exec("git", ["cherry-pick", "--abort"], { cwd: previewPath, encoding: "utf8" }).catch(() => undefined);
        break;
      }
    }
    if (!conflict) expectedTree = await git(previewPath, ["rev-parse", "HEAD^{tree}"]);
  } finally {
    await exec("git", ["worktree", "remove", "--force", previewPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
  return { conflict, ...(expectedTree ? { expectedTree } : {}) };
}

async function previewRevert(
  repositoryRoot: string,
  runId: string,
  targetCommit: string,
  commits: string[],
): Promise<{ conflict: boolean; expectedTree?: string }> {
  if (commits.length === 0) {
    return { conflict: false, expectedTree: await git(repositoryRoot, ["rev-parse", `${targetCommit}^{tree}`]) };
  }
  const safeRunId = runtimeGitName(runId);
  const previewPath = join(repositoryRoot, ".worktrees", `rollback-preview-${safeRunId}-${randomUUID()}`);
  await exec("git", ["worktree", "add", "--detach", previewPath, targetCommit], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  let conflict = false;
  let expectedTree: string | undefined;
  try {
    try {
      await exec("git", ["revert", "--no-commit", ...commits], { cwd: previewPath, encoding: "utf8" });
      expectedTree = await git(previewPath, ["write-tree"]);
    } catch {
      conflict = true;
      await exec("git", ["revert", "--abort"], { cwd: previewPath, encoding: "utf8" }).catch(() => undefined);
    }
  } finally {
    await exec("git", ["worktree", "remove", "--force", previewPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
  return { conflict, ...(expectedTree ? { expectedTree } : {}) };
}

async function isAncestor(repositoryRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await exec("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repositoryRoot });
    return true;
  } catch {
    return false;
  }
}

async function latestActiveIntegration(runDirectory: string): Promise<IntegrationRecord | undefined> {
  const [integrations, rollbacks] = await Promise.all([
    readRecords<IntegrationRecord>(join(runDirectory, "integrations")),
    readRecords<RollbackRecord>(join(runDirectory, "rollbacks")),
  ]);
  const rolledBack = new Set(rollbacks.map((record) => record.integrationId));
  return integrations
    .filter((record) => !rolledBack.has(record.integrationId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
}

async function hasRollback(runDirectory: string, integrationId: string): Promise<boolean> {
  return (await readRecords<RollbackRecord>(join(runDirectory, "rollbacks")))
    .some((record) => record.integrationId === integrationId);
}

async function activeIntegrationForResult(runDirectory: string, resultId: string): Promise<boolean> {
  const [integrations, rollbacks] = await Promise.all([
    readRecords<IntegrationRecord>(join(runDirectory, "integrations")),
    readRecords<RollbackRecord>(join(runDirectory, "rollbacks")),
  ]);
  const rolledBack = new Set(rollbacks.map((record) => record.integrationId));
  return integrations.some((record) => record.resultId === resultId && !rolledBack.has(record.integrationId));
}

async function reconcilePendingGitOperations(repositoryRoot: string, runDirectory: string): Promise<void> {
  const [intents, resolutions, integrations, rollbacks] = await Promise.all([
    readRecords<GitOperationIntent>(join(runDirectory, "operations", "intents")),
    readRecords<GitOperationResolution>(join(runDirectory, "operations", "resolutions")),
    readRecords<IntegrationRecord>(join(runDirectory, "integrations")),
    readRecords<RollbackRecord>(join(runDirectory, "rollbacks")),
  ]);
  const resolved = new Set(resolutions.map((record) => record.operationId));
  const recorded = new Set([
    ...integrations.map((record) => record.integrationId),
    ...rollbacks.map((record) => record.rollbackId),
  ]);
  for (const intent of intents.filter((record) => !resolved.has(record.operationId))) {
    if (recorded.has(intent.operationId)) {
      await writeOperationResolution(runDirectory, intent.operationId, "recorded");
      continue;
    }
    const current = await git(repositoryRoot, ["rev-parse", `refs/heads/${intent.targetBranch}`]);
    if (current === intent.targetBefore) {
      await writeOperationResolution(runDirectory, intent.operationId, "not_applied");
      continue;
    }
    const currentTree = await git(repositoryRoot, ["rev-parse", `${current}^{tree}`]);
    if (currentTree === intent.expectedTree && await isAncestor(repositoryRoot, intent.targetBefore, current)) {
      if (intent.kind === "integration" && intent.resultId && intent.mode) {
        const record: IntegrationRecord = {
          schemaVersion: 1,
          integrationId: intent.operationId,
          runId: intent.runId,
          resultId: intent.resultId,
          targetBranch: intent.targetBranch,
          targetBefore: intent.targetBefore,
          targetAfter: current,
          mode: intent.mode,
          integratedCommits: intent.commits,
          createdAt: intent.createdAt,
        };
        await writeImmutableRecord(join(runDirectory, "integrations"), record.integrationId, record);
      } else if (intent.kind === "rollback" && intent.integrationId) {
        const record: RollbackRecord = {
          schemaVersion: 1,
          rollbackId: intent.operationId,
          runId: intent.runId,
          integrationId: intent.integrationId,
          targetBranch: intent.targetBranch,
          targetBefore: intent.targetBefore,
          targetAfter: current,
          revertedCommits: intent.commits,
          createdAt: intent.createdAt,
        };
        await writeImmutableRecord(join(runDirectory, "rollbacks"), record.rollbackId, record);
      } else {
        throw new Error(`pending ${intent.kind} ${intent.operationId} is missing recovery metadata`);
      }
      await writeOperationResolution(runDirectory, intent.operationId, "recorded");
      continue;
    }
    throw new Error(
      `pending ${intent.kind} ${intent.operationId} changed ${intent.targetBranch} from ${intent.targetBefore}; inspect the branch and reconcile it before replay`,
    );
  }
}

async function resolveIfTargetUnchanged(
  repositoryRoot: string,
  runDirectory: string,
  intent: GitOperationIntent,
): Promise<void> {
  const current = await git(repositoryRoot, ["rev-parse", `refs/heads/${intent.targetBranch}`]).catch(() => "missing");
  if (current === intent.targetBefore) {
    await writeOperationResolution(runDirectory, intent.operationId, "not_applied");
  }
}

async function writeOperationResolution(
  runDirectory: string,
  operationId: string,
  outcome: GitOperationResolution["outcome"],
): Promise<void> {
  const record: GitOperationResolution = {
    schemaVersion: 1,
    operationId,
    outcome,
    resolvedAt: new Date().toISOString(),
  };
  await writeImmutableRecord(join(runDirectory, "operations", "resolutions"), operationId, record);
}

async function readRecords<T>(directory: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) =>
    JSON.parse(await readFile(join(directory, name), "utf8")) as T));
}

async function writeImmutableRecord(directory: string, id: string, value: object): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function canonicalPath(path: string): Promise<string> {
  const canonical = await realpath(resolve(path)).catch(() => resolve(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
