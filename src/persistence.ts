import { createHash, randomUUID } from "node:crypto";
import { appendFile, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";

import type { RunEvent, RunState } from "./types.js";

export interface StoragePointer {
  schemaVersion: 1;
  generation: string;
  stateSha256: string;
  eventsSha256: string;
}

interface GenerationManifest extends StoragePointer {
  createdAt: string;
}

export interface LoadedGeneration {
  pointer: StoragePointer;
  stateRaw: string;
  eventsRaw: string;
  statePath: string;
  eventsPath: string;
}

export async function readCurrentGeneration(runDirectory: string): Promise<LoadedGeneration | undefined> {
  let pointer: StoragePointer;
  try {
    pointer = parsePointer(await readFile(join(runDirectory, "CURRENT.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readGeneration(runDirectory, pointer);
}

export async function recoverJournaledGeneration(runDirectory: string): Promise<LoadedGeneration | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(runDirectory, "generation-journal.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const candidates = raw.split(/\r?\n/).filter(Boolean).reverse();
  for (const candidate of candidates) {
    try {
      const pointer = parsePointer(candidate);
      const generation = await readGeneration(runDirectory, pointer);
      await replaceCurrentPointer(runDirectory, pointer);
      return generation;
    } catch {
      // A later torn or corrupt journal entry cannot authorize a partial generation.
    }
  }
  throw new Error("no complete journaled run generation can recover CURRENT.json");
}

export async function publishGeneration(
  runDirectory: string,
  state: RunState,
  events: RunEvent[],
  expectedGeneration?: string,
): Promise<LoadedGeneration> {
  const release = await acquirePublicationLock(runDirectory);
  try {
    return await publishGenerationLocked(runDirectory, state, events, expectedGeneration);
  } finally {
    await release();
  }
}

async function publishGenerationLocked(
  runDirectory: string,
  state: RunState,
  events: RunEvent[],
  expectedGeneration?: string,
): Promise<LoadedGeneration> {
  const current = await readCurrentGeneration(runDirectory);
  if (expectedGeneration !== undefined && current?.pointer.generation !== expectedGeneration) {
    throw new Error(
      `stale run generation: expected ${expectedGeneration}, current ${current?.pointer.generation ?? "missing"}`,
    );
  }
  if (expectedGeneration === undefined && current) {
    throw new Error(`run generation already exists: ${current.pointer.generation}`);
  }

  const generation = `${String(state.revision).padStart(8, "0")}-${randomUUID()}`;
  const generationsDirectory = join(runDirectory, "generations");
  const temporaryDirectory = join(generationsDirectory, `.tmp-${generation}`);
  const generationDirectory = join(generationsDirectory, generation);
  await mkdir(temporaryDirectory, { recursive: true });

  const stateRaw = `${JSON.stringify(state, null, 2)}\n`;
  const eventsRaw = events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
  const pointer: StoragePointer = {
    schemaVersion: 1,
    generation,
    stateSha256: sha256(stateRaw),
    eventsSha256: sha256(eventsRaw),
  };
  const manifest: GenerationManifest = {
    ...pointer,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(temporaryDirectory, "state.json"), stateRaw, "utf8");
  await writeFile(join(temporaryDirectory, "events.jsonl"), eventsRaw, "utf8");
  await writeFile(join(temporaryDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporaryDirectory, generationDirectory);

  await appendFile(
    join(runDirectory, "generation-journal.jsonl"),
    `${JSON.stringify({ ...pointer, recordedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
  await replaceCurrentPointer(runDirectory, pointer);
  // Compatibility projections are intentionally non-authoritative. Readers in
  // this package resolve CURRENT.json and verify generation hashes first.
  await writeFile(join(runDirectory, "state.json"), stateRaw, "utf8");
  await writeFile(join(runDirectory, "events.jsonl"), eventsRaw, "utf8");
  return {
    pointer,
    stateRaw,
    eventsRaw,
    statePath: join(generationDirectory, "state.json"),
    eventsPath: join(generationDirectory, "events.jsonl"),
  };
}

async function acquirePublicationLock(runDirectory: string): Promise<() => Promise<void>> {
  const path = join(runDirectory, ".generation.publish.lock");
  const recoveryPath = `${path}.recovery`;
  const deadline = Date.now() + 10_000;
  await mkdir(runDirectory, { recursive: true });
  while (Date.now() < deadline) {
    const owned = await tryAcquireFileLock(path);
    if (owned) {
      if (await fileExists(recoveryPath)) {
        await owned.release();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        continue;
      }
      return owned.release;
    }
    await recoverStalePublicationLock(path);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("timed out waiting for the run generation publication lock");
}

interface FileLockRecord {
  token: string;
  pid: number;
  host: string;
  createdAt: string;
}

interface OwnedFileLock {
  record: FileLockRecord;
  release(): Promise<void>;
}

async function tryAcquireFileLock(path: string): Promise<OwnedFileLock | undefined> {
  const record: FileLockRecord = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  const temporary = `${path}.${record.token}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return { record, release: () => releaseFileLock(path, record) };
}

async function recoverStalePublicationLock(path: string): Promise<void> {
  const recoveryPath = `${path}.recovery`;
  const recovery = await tryAcquireFileLock(recoveryPath);
  if (!recovery) {
    const owner = await readFileLock(recoveryPath);
    if (owner && fileLockIsStale(owner)) await releaseFileLock(recoveryPath, owner);
    return;
  }
  try {
    const owner = await readLooseFileLock(path);
    if (owner && fileLockIsStale(owner)) {
      if (owner.token) await releaseFileLock(path, owner as FileLockRecord);
      else await rm(path, { force: true });
    }
  } finally {
    await recovery.release();
  }
}

async function readLooseFileLock(path: string): Promise<Partial<FileLockRecord> & { pid: number; host: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<FileLockRecord>;
    if (typeof value.pid === "number" && typeof value.host === "string") {
      return value as Partial<FileLockRecord> & { pid: number; host: string };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  return undefined;
}

async function releaseFileLock(path: string, owner: FileLockRecord): Promise<void> {
  const current = await readFileLock(path);
  if (current?.token === owner.token) await rm(path, { force: true });
}

async function readFileLock(path: string): Promise<FileLockRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<FileLockRecord>;
    if (
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      typeof value.host === "string" &&
      typeof value.createdAt === "string"
    ) return value as FileLockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
  }
  return undefined;
}

function fileLockIsStale(owner: { pid: number; host: string }): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function replaceCurrentPointer(runDirectory: string, pointer: StoragePointer): Promise<void> {
  const temporaryPointer = join(runDirectory, `CURRENT.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPointer, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  await rename(temporaryPointer, join(runDirectory, "CURRENT.json"));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readGeneration(runDirectory: string, pointer: StoragePointer): Promise<LoadedGeneration> {
  const generationDirectory = join(runDirectory, "generations", pointer.generation);
  const statePath = join(generationDirectory, "state.json");
  const eventsPath = join(generationDirectory, "events.jsonl");
  const [stateRaw, eventsRaw, manifestRaw] = await Promise.all([
    readFile(statePath, "utf8"),
    readFile(eventsPath, "utf8"),
    readFile(join(generationDirectory, "manifest.json"), "utf8"),
  ]);
  const manifest = parsePointer(manifestRaw);
  if (
    manifest.generation !== pointer.generation ||
    manifest.stateSha256 !== pointer.stateSha256 ||
    manifest.eventsSha256 !== pointer.eventsSha256
  ) {
    throw new Error(`run generation ${pointer.generation} manifest does not match CURRENT.json`);
  }
  if (sha256(stateRaw) !== pointer.stateSha256 || sha256(eventsRaw) !== pointer.eventsSha256) {
    throw new Error(`run generation ${pointer.generation} artifact hash mismatch`);
  }
  return { pointer, stateRaw, eventsRaw, statePath, eventsPath };
}

function parsePointer(raw: string): StoragePointer {
  const value = JSON.parse(raw) as Partial<StoragePointer>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.generation !== "string" ||
    typeof value.stateSha256 !== "string" ||
    typeof value.eventsSha256 !== "string"
  ) {
    throw new Error("invalid run generation pointer");
  }
  return value as StoragePointer;
}
