import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { readCurrentGeneration, sha256 } from "./persistence.js";
import { readSqliteRunProjection } from "./sqlite-coordinator.js";
import type { RunState } from "./types.js";

export interface RetentionEntry { runId: string; path: string; reason: string }
export interface RetentionPlan {
  schemaVersion: 1;
  repositoryRoot: string;
  createdAt: string;
  removable: RetentionEntry[];
  protected: RetentionEntry[];
  runRevisions: Record<string, { revision: number; generation: string }>;
  planHash: string;
}

export async function planRetention(repositoryRoot: string, options: { olderThanMs: number; now?: number }): Promise<RetentionPlan> {
  const root = await realpath(resolve(repositoryRoot));
  const runsDirectory = join(root, ".agent-graph", "runs");
  const removable: RetentionEntry[] = [];
  const protectedEntries: RetentionEntry[] = [];
  const runRevisions: RetentionPlan["runRevisions"] = {};
  for (const entry of await readdir(runsDirectory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  })) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const runDirectory = join(runsDirectory, runId);
    const sqlite = await readSqliteRunProjection(root, runId);
    const generation = sqlite ? undefined : await readCurrentGeneration(runDirectory);
    if (!sqlite && !generation) continue;
    const state = JSON.parse(sqlite?.stateRaw ?? generation!.stateRaw) as RunState;
    runRevisions[runId] = { revision: state.revision, generation: sqlite ? `sqlite:${sqlite.storageRevision}` : generation!.pointer.generation };
    const unresolved = state.status !== "completed" || Object.values(state.nodes).some((node) => node.retryBlocked) ||
      state.authority.reservations.some((reservation) => !state.authority.consumptions.some((consumption) => consumption.reservationId === reservation.reservationId));
    const oldEnough = (options.now ?? Date.now()) - Date.parse(state.updatedAt) >= options.olderThanMs;
    if (unresolved || !oldEnough) {
      protectedEntries.push({ runId, path: relative(root, runDirectory).replaceAll("\\", "/"), reason: unresolved ? "unresolved or active effect" : "retention age threshold not reached" });
      continue;
    }
    for (const category of ["prompts", "outputs"] as const) {
      const directory = join(runDirectory, category);
      for (const file of await listFiles(directory)) {
        removable.push({ runId, path: relative(root, file).replaceAll("\\", "/"), reason: `expired ${category} detail` });
      }
    }
    const generations = join(runDirectory, "generations");
    for (const generationEntry of await readdir(generations, { withFileTypes: true }).catch(() => [])) {
      if (generationEntry.isDirectory() && generationEntry.name !== generation?.pointer.generation) {
        removable.push({ runId, path: relative(root, join(generations, generationEntry.name)).replaceAll("\\", "/"), reason: "superseded state generation" });
      }
    }
    if (generation) {
      protectedEntries.push({ runId, path: relative(root, generation.statePath).replaceAll("\\", "/"), reason: "authoritative minimal state" });
      protectedEntries.push({ runId, path: relative(root, generation.eventsPath).replaceAll("\\", "/"), reason: "authoritative event journal" });
    } else {
      const sqliteProjection = sqlite!;
      const databaseRelative = relative(root, sqliteProjection.databasePath);
      const outsideRepository = databaseRelative === ".." || databaseRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(databaseRelative);
      protectedEntries.push({
        runId,
        path: outsideRepository ? sqliteProjection.databasePath : databaseRelative.replaceAll("\\", "/"),
        reason: outsideRepository ? "authoritative SQLite state and event journal outside repository" : "authoritative SQLite state and event journal",
      });
    }
  }
  const unsigned = {
    schemaVersion: 1 as const,
    repositoryRoot: root,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    removable: removable.sort(comparePath),
    protected: protectedEntries.sort(comparePath),
    runRevisions,
  };
  return { ...unsigned, planHash: sha256(canonical(unsigned)) };
}

export async function executeRetention(repositoryRoot: string, plan: RetentionPlan): Promise<{ removed: string[] }> {
  const root = await realpath(resolve(repositoryRoot));
  const { planHash, ...unsigned } = plan;
  if (plan.repositoryRoot !== root || sha256(canonical(unsigned)) !== planHash) throw new Error("retention plan identity or hash mismatch");
  for (const [runId, expected] of Object.entries(plan.runRevisions)) {
    const sqlite = await readSqliteRunProjection(root, runId);
    const generation = sqlite ? undefined : await readCurrentGeneration(join(root, ".agent-graph", "runs", runId));
    if (!sqlite && !generation) throw new Error(`run ${runId} disappeared after retention preview`);
    const state = JSON.parse(sqlite?.stateRaw ?? generation!.stateRaw) as RunState;
    const identity = sqlite ? `sqlite:${sqlite.storageRevision}` : generation!.pointer.generation;
    if (state.revision !== expected.revision || identity !== expected.generation) throw new Error(`run ${runId} changed after retention preview`);
  }
  const affectedRuns = new Set(plan.removable.map((entry) => entry.runId));
  for (const runId of affectedRuns) {
    const directory = join(root, ".agent-graph", "runs", runId, "retention-operations");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${planHash}.json`);
    const pending = `${JSON.stringify({
      schemaVersion: 1,
      planHash,
      status: "pending",
      entries: plan.removable.filter((entry) => entry.runId === runId),
      createdAt: plan.createdAt,
    }, null, 2)}\n`;
    try { await writeFile(path, pending, { encoding: "utf8", flag: "wx" }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(path, "utf8")) as { planHash?: string; status?: string };
      if (existing.planHash !== planHash || !["pending", "completed"].includes(existing.status ?? "")) throw new Error(`retention operation journal is invalid for ${runId}`);
    }
  }
  const removed: string[] = [];
  for (const entry of plan.removable) {
    const path = safePath(root, entry.path);
    await rm(path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  for (const runId of affectedRuns) {
    const path = join(root, ".agent-graph", "runs", runId, "retention-manifest.json");
    const record = { schemaVersion: 1, planHash, removed: plan.removable.filter((entry) => entry.runId === runId), executedAt: new Date().toISOString() };
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await writeFile(join(root, ".agent-graph", "runs", runId, "retention-operations", `${planHash}.json`), `${JSON.stringify({
      schemaVersion: 1, planHash, status: "completed", removed: record.removed, executedAt: record.executedAt,
    }, null, 2)}\n`, "utf8");
  }
  return { removed };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`retention path must be relative: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error(`retention path escapes repository: ${path}`);
  return absolute;
}

function comparePath(left: RetentionEntry, right: RetentionEntry): number { return left.path.localeCompare(right.path); }
function canonical(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
