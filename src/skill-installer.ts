import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SkillInstallOptions {
  projectDirectory?: string;
  homeDirectory?: string;
  dryRun?: boolean;
}

export interface SkillInstallResult {
  path: string;
  status: "installed" | "updated" | "unchanged";
  hash: string;
}

export async function installSkills(
  packageRoot: string,
  options: SkillInstallOptions = {},
): Promise<SkillInstallResult[]> {
  const source = join(packageRoot, "skills", "agent-graph-runtime");
  const base = options.projectDirectory ? resolve(options.projectDirectory) : resolve(options.homeDirectory ?? homedir());
  const destinations = [
    join(base, ".agents", "skills", "agent-graph-runtime"),
    join(base, ".claude", "skills", "agent-graph-runtime"),
  ];
  const sourceFiles = await relativeFiles(source);
  const sourceHash = await directoryHash(source, sourceFiles);
  const results: SkillInstallResult[] = [];
  for (const destination of destinations) {
    let destinationExists = true;
    let destinationHash: string | undefined;
    try {
      const destinationFiles = await relativeFiles(destination);
      destinationHash = await directoryHash(destination, destinationFiles);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await readdir(destination);
      } catch {
        destinationExists = false;
      }
    }
    const status = !destinationExists ? "installed" : destinationHash === sourceHash ? "unchanged" : "updated";
    if (!options.dryRun && status !== "unchanged") {
      if (status === "updated") await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await cp(source, destination, { recursive: true, force: true });
    }
    results.push({ path: destination, status, hash: sourceHash });
  }
  return results;
}

async function relativeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .sort();
}

async function directoryHash(directory: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relativeFile of files) {
    const normalizedPath = Buffer.from(relativeFile.replaceAll("\\", "/"), "utf8");
    const content = await readFile(join(directory, relativeFile));
    const frame = Buffer.allocUnsafe(16);
    frame.writeBigUInt64BE(BigInt(normalizedPath.length), 0);
    frame.writeBigUInt64BE(BigInt(content.length), 8);
    hash.update(frame);
    hash.update(normalizedPath);
    hash.update(content);
  }
  return hash.digest("hex");
}
