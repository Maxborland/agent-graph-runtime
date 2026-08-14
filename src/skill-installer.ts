import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface SkillInstallOptions {
  projectDirectory?: string;
  homeDirectory?: string;
}

export async function installSkills(
  packageRoot: string,
  options: SkillInstallOptions = {},
): Promise<string[]> {
  const source = join(packageRoot, "skills", "agent-graph-runtime");
  const base = options.projectDirectory ? resolve(options.projectDirectory) : resolve(options.homeDirectory ?? homedir());
  const destinations = [
    join(base, ".agents", "skills", "agent-graph-runtime"),
    join(base, ".claude", "skills", "agent-graph-runtime"),
  ];
  for (const destination of destinations) {
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  }
  return destinations;
}
