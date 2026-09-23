import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, open, readFile, rm } from "node:fs/promises";

import { CliError } from "./cli-error.js";
import { runArtifactDirectory } from "./artifact-path.js";

export interface LockRecord {
  token: string;
  pid: number;
  host: string;
  startedAt: string;
}

export interface RunLock {
  path: string;
  record: LockRecord;
  release(): Promise<void>;
}

export interface RunLockInspection {
  status: "missing" | "initializing" | "live" | "stale" | "foreign";
  record?: LockRecord;
}

export async function acquireRunLock(repositoryRoot: string, runId: string): Promise<RunLock> {
  const runDirectory = runArtifactDirectory(repositoryRoot, runId);
  const path = join(runDirectory, ".run.lock");
  const recoveryPath = `${path}.recovery`;
  await mkdir(runDirectory, { recursive: true });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await exists(recoveryPath)) {
      await releaseStaleLocalRecoveryGuard(recoveryPath);
      await delay(25);
      continue;
    }
    const record: LockRecord = {
      token: randomUUID(),
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    };
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      const lock = createOwnedLock(path, record);
      if (await exists(recoveryPath)) {
        await lock.release();
        await delay(25);
        continue;
      }
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const inspection = await inspectRunLock(repositoryRoot, runId);
      if (inspection.status === "stale") {
        await recoverRunLock(repositoryRoot, runId, false);
        continue;
      }
      const owner = inspection.record;
      const detail = owner
        ? `PID ${owner.pid} on ${owner.host} since ${owner.startedAt}`
        : "another process is initializing the lock";
      const recovery = inspection.status === "foreign" ? "; verify the remote owner, then use agr unlock --force" : "";
      throw new CliError(`run ${runId} is already owned by ${detail}${recovery}`, 4, "RUN_LOCKED");
    }
  }
  throw new CliError(`could not acquire run lock for ${runId}`, 4, "RUN_LOCKED");
}

export async function inspectRunLock(
  repositoryRoot: string,
  runId: string,
): Promise<RunLockInspection> {
  const path = join(runArtifactDirectory(repositoryRoot, runId), ".run.lock");
  if (!(await exists(path))) return { status: "missing" };
  const record = await readLock(path);
  if (!record) return { status: "initializing" };
  if (record.host !== hostname()) return { status: "foreign", record };
  return isLocalPidLive(record.pid) ? { status: "live", record } : { status: "stale", record };
}

export async function recoverRunLock(
  repositoryRoot: string,
  runId: string,
  force: boolean,
): Promise<LockRecord | undefined> {
  const path = join(runArtifactDirectory(repositoryRoot, runId), ".run.lock");
  const recoveryPath = `${path}.recovery`;
  const recovery = await acquireRecoveryGuard(recoveryPath, runId, force);
  try {
    await delay(25);
    const inspection = await inspectRunLock(repositoryRoot, runId);
    if (!inspection.record) {
      if (inspection.status === "initializing" && force) {
        await rm(path, { force: true });
        return undefined;
      }
      const recoveryHint = inspection.status === "initializing"
        ? "; if its owner is confirmed stopped, repeat with --force"
        : "";
      throw new CliError(`run ${runId} has no recoverable lock${recoveryHint}`, 3, "RUN_NOT_LOCKED");
    }
    if (inspection.status === "live" && !force) {
      throw new CliError(`run ${runId} is still owned by live PID ${inspection.record.pid}`, 4, "RUN_LOCKED");
    }
    if (inspection.status === "foreign" && !force) {
      throw new CliError(
        `run ${runId} belongs to ${inspection.record.host}; verify that owner is stopped, then repeat with --force`,
        4,
        "FOREIGN_RUN_LOCK",
      );
    }
    await rm(path, { force: true });
    return inspection.record;
  } finally {
    await recovery.release();
  }
}

async function releaseStaleLocalRecoveryGuard(path: string): Promise<void> {
  const owner = await readLock(path);
  if (!owner || owner.host !== hostname() || isLocalPidLive(owner.pid)) return;
  // Token-aware release avoids removing a replacement guard acquired after our
  // inspection of the demonstrably stale local owner.
  await createOwnedLock(path, owner).release();
}

async function acquireRecoveryGuard(
  path: string,
  runId: string,
  force: boolean,
): Promise<RunLock> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: LockRecord = {
      token: randomUUID(),
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    };
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      } catch (error) {
        await handle.close();
        await rm(path, { force: true });
        throw error;
      }
      await handle.close();
      return createOwnedLock(path, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readLock(path);
      if (!owner) {
        if (!force) {
          throw new CliError(
            `run ${runId} has an unreadable lock-recovery guard; verify its owner is stopped, then repeat with --force`,
            4,
            "LOCK_RECOVERY_ACTIVE",
          );
        }
        await rm(path, { force: true });
        continue;
      }
      if (owner.host === hostname() && isLocalPidLive(owner.pid)) {
        throw new CliError(
          `run ${runId} lock recovery is already owned by live PID ${owner.pid}`,
          4,
          "LOCK_RECOVERY_ACTIVE",
        );
      }
      if (owner.host !== hostname() && !force) {
        throw new CliError(
          `run ${runId} lock recovery belongs to ${owner.host}; verify that owner is stopped, then repeat with --force`,
          4,
          "LOCK_RECOVERY_ACTIVE",
        );
      }
      await createOwnedLock(path, owner).release();
    }
  }
  throw new CliError(`could not acquire lock-recovery guard for run ${runId}`, 4, "LOCK_RECOVERY_ACTIVE");
}

function createOwnedLock(path: string, record: LockRecord): RunLock {
  return {
    path,
    record,
    release: async () => {
      try {
        const current = await readLock(path);
        if (current?.token === record.token) await rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    if (
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      typeof value.host === "string" &&
      typeof value.startedAt === "string"
    ) return value as LockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  }
  return undefined;
}

function isLocalPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
