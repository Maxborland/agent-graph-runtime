import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type GitChangeSnapshot = Record<string, string>;

export async function gitChangedFiles(repositoryRoot: string, signal?: AbortSignal): Promise<string[]> {
  return [...new Set((await gitStatusEntries(repositoryRoot, signal)).map((entry) => entry.path))].sort();
}

export async function gitChangeSnapshot(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<GitChangeSnapshot> {
  const entries = await gitStatusEntries(repositoryRoot, signal);
  const indexMetadata = await gitIndexMetadata(repositoryRoot, signal);
  const snapshot: GitChangeSnapshot = {};
  for (const entry of entries) {
    const hash = createHash("sha256");
    hash.update(entry.status);
    hash.update("\0");
    hash.update(indexMetadata.get(entry.path) ?? "<not-in-index>");
    hash.update("\0");
    const absolutePath = join(repositoryRoot, ...entry.path.split("/"));
    try {
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(String(stats.mode));
        hash.update("\0");
        hash.update(await readlink(absolutePath));
      } else if (stats.isFile()) {
        hash.update("file\0");
        hash.update(String(stats.mode));
        hash.update("\0");
        hash.update(await readFile(absolutePath));
      } else if (stats.isDirectory() && isGitlink(indexMetadata.get(entry.path))) {
        hash.update("gitlink\0");
        hash.update(await gitHead(absolutePath, signal));
        hash.update("\0");
        hash.update(JSON.stringify(await gitChangeSnapshot(absolutePath, signal)));
      } else {
        hash.update("other:" + stats.mode);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("<missing>");
    }
    snapshot[entry.path] = hash.digest("hex");
  }
  return snapshot;
}

function isGitlink(metadata: string | undefined): boolean {
  return metadata?.startsWith("160000 ") ?? false;
}

async function gitHead(repositoryRoot: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
    ...(signal ? { signal } : {}),
  });
  return stdout.trim();
}

interface GitStatusEntry {
  path: string;
  status: string;
}

async function gitStatusEntries(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<GitStatusEntry[]> {
  const { stdout } = await exec(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      ...(signal ? { signal } : {}),
    },
  );
  const entries = stdout.split("\0").filter(Boolean);
  const files: GitStatusEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    files.push({ path: normalizePath(path), status });
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
      const sourcePath = entries[index + 1]!;
      index += 1;
      if (status.includes("R")) files.push({ path: normalizePath(sourcePath), status });
    }
  }
  return files;
}

async function gitIndexMetadata(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const { stdout } = await exec("git", ["ls-files", "--stage", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    ...(signal ? { signal } : {}),
  });
  const metadata = new Map<string, string>();
  for (const entry of stdout.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator === -1) continue;
    metadata.set(normalizePath(entry.slice(separator + 1)), entry.slice(0, separator));
  }
  return metadata;
}

export async function findUnexpectedChanges(
  repositoryRoot: string,
  baselineChangedFiles: string[] | GitChangeSnapshot,
  ownershipPatterns: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const current = await gitChangeSnapshot(repositoryRoot, signal);
  const changed = Array.isArray(baselineChangedFiles)
    ? Object.keys(current).filter(
        (file) => !new Set(baselineChangedFiles.map(normalizePath)).has(file),
      )
    : [...new Set([...Object.keys(baselineChangedFiles), ...Object.keys(current)])].filter(
        (file) => baselineChangedFiles[file] !== current[file],
      );
  return changed
    .filter((file) => !ownershipPatterns.some((pattern) => matchesGlob(file, pattern)))
    .sort();
}

export function matchesGlob(file: string, pattern: string): boolean {
  const normalizedFile = normalizePath(file);
  const normalizedPattern = normalizePath(pattern).replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      index += 1;
      if (normalizedPattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(normalizedFile);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}
