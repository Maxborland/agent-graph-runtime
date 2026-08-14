import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installSkills } from "../src/skill-installer.js";

test("skill installer installs the same open skill for Codex and Claude projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-skills-"));
  const packageRoot = join(root, "package");
  const projectRoot = join(root, "project");
  const skillRoot = join(packageRoot, "skills", "agent-graph-runtime");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: agent-graph-runtime\n---\n");

  try {
    const installed = await installSkills(packageRoot, { projectDirectory: projectRoot });
    assert.equal(installed.length, 2);
    assert.match(
      await readFile(join(projectRoot, ".agents", "skills", "agent-graph-runtime", "SKILL.md"), "utf8"),
      /agent-graph-runtime/,
    );
    assert.match(
      await readFile(join(projectRoot, ".claude", "skills", "agent-graph-runtime", "SKILL.md"), "utf8"),
      /agent-graph-runtime/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

