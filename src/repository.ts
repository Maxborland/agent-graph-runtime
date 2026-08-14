import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function gitChangedFiles(repositoryRoot: string): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const entries = stdout.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    let path = entry.slice(3);
    if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
      path = entries[index + 1]!;
      index += 1;
    }
    files.push(normalizePath(path));
  }
  return [...new Set(files)].sort();
}

export async function findUnexpectedChanges(
  repositoryRoot: string,
  baselineChangedFiles: string[],
  ownershipPatterns: string[],
): Promise<string[]> {
  const baseline = new Set(baselineChangedFiles.map(normalizePath));
  const current = await gitChangedFiles(repositoryRoot);
  return current.filter(
    (file) => !baseline.has(file) && !ownershipPatterns.some((pattern) => matchesGlob(file, pattern)),
  );
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
