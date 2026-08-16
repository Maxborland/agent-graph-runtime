import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { sha256 } from "./persistence.js";
import { assertSafeRunId } from "./run-id.js";
import { CoordinatorDatabase, readSqliteRunProjection } from "./sqlite-coordinator.js";
import { acquireRunLock } from "./run-lock.js";

interface ExportManifest {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  manifestHash: string;
}

export async function exportRunBundle(repositoryRoot: string, runId: string, destination: string): Promise<{ destination: string; manifestHash: string }> {
  assertSafeRunId(runId);
  const lock = await acquireRunLock(repositoryRoot, runId);
  try {
  const source = join(await realpath(resolve(repositoryRoot)), ".agent-graph", "runs", runId);
  const targetRoot = resolve(destination);
  const destinationFromSource = relative(source, targetRoot);
  if (destinationFromSource === "" || (!destinationFromSource.startsWith("..") && !isAbsolute(destinationFromSource))) {
    throw new Error("export destination must be outside the source run directory");
  }
  await stat(source);
  try {
    await stat(targetRoot);
    throw new Error(`export destination already exists: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(targetRoot, { recursive: true });
  const files = await listFiles(source);
  const manifestFiles: ExportManifest["files"] = [];
  for (const sourcePath of files) {
    const path = relative(source, sourcePath).replaceAll("\\", "/");
    if (path.endsWith(".lock") || path.includes(".tmp")) continue;
    const bytes = await readFile(sourcePath);
    const target = join(targetRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    manifestFiles.push({ path, sha256: sha256(bytes), size: bytes.byteLength });
  }
  const sqlite = await readSqliteRunProjection(repositoryRoot, runId);
  if (sqlite) {
    const database = new CoordinatorDatabase(sqlite.databasePath);
    let snapshot: ReturnType<CoordinatorDatabase["exportRunSnapshot"]>;
    try { snapshot = database.exportRunSnapshot(runId); } finally { database.close(); }
    for (const [path, content] of [["authoritative/state.json", snapshot.stateRaw], ["authoritative/events.jsonl", snapshot.eventsRaw]] as const) {
      const bytes = Buffer.from(content);
      const target = join(targetRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
      manifestFiles.push({ path, sha256: sha256(bytes), size: bytes.byteLength });
    }
    const content = `${JSON.stringify(snapshot.audit, null, 2)}\n`;
    const path = "authoritative/coordinator-audit.json";
    const bytes = Buffer.from(content);
    const target = join(targetRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    manifestFiles.push({ path, sha256: sha256(bytes), size: bytes.byteLength });
  }
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
  const unsigned = { schemaVersion: 1 as const, runId, createdAt: new Date().toISOString(), files: manifestFiles };
  const manifestHash = sha256(canonical(unsigned));
  const manifest: ExportManifest = { ...unsigned, manifestHash };
  await writeFile(join(targetRoot, "EXPORT_MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { destination: targetRoot, manifestHash };
  } finally { await lock.release(); }
}

export async function verifyRunBundle(destination: string): Promise<{ valid: boolean; changed: string[]; missing: string[]; added: string[] }> {
  const root = resolve(destination);
  const manifest = JSON.parse(await readFile(join(root, "EXPORT_MANIFEST.json"), "utf8")) as ExportManifest;
  const { manifestHash, ...unsigned } = manifest;
  const changed: string[] = [];
  const missing: string[] = [];
  if (manifest.schemaVersion !== 1 || sha256(canonical(unsigned)) !== manifestHash) changed.push("EXPORT_MANIFEST.json");
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const entry of manifest.files) {
    const bytes = await readFile(join(root, entry.path)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!bytes) missing.push(entry.path);
    else if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) changed.push(entry.path);
  }
  const actual = (await listFiles(root)).map((path) => relative(root, path).replaceAll("\\", "/")).filter((path) => path !== "EXPORT_MANIFEST.json");
  const added = actual.filter((path) => !expected.has(path)).sort();
  return { valid: changed.length === 0 && missing.length === 0 && added.length === 0, changed: changed.sort(), missing: missing.sort(), added };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function canonical(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
