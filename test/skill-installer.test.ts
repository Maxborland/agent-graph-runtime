import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { installSkills } from "../src/skill-installer.js";

test("bundled skill requires parent agents to follow background runs to a terminal state", async () => {
  const skill = await readFile(resolve("skills", "agent-graph-runtime", "SKILL.md"), "utf8");
  assert.match(skill, /agr follow <graph>/);
  assert.match(skill, /agr wait <graph> --after <cursor> --timeout-ms 60000 --json/);
  assert.match(skill, /never end the turn while the returned status is `running`/i);
  assert.match(skill, /agr advisor status/);
  assert.match(skill, /agr advisor acknowledge/);
});

test("bundled skill stays below one hundred physical lines", async () => {
  const skill = await readFile(resolve("skills", "agent-graph-runtime", "SKILL.md"), "utf8");
  assert.ok(skill.trimEnd().split(/\r?\n/).length < 100);
});

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
    assert.deepEqual(installed.map((result) => result.status), ["installed", "installed"]);
    assert.match(
      await readFile(join(projectRoot, ".agents", "skills", "agent-graph-runtime", "SKILL.md"), "utf8"),
      /agent-graph-runtime/,
    );
    const unchanged = await installSkills(packageRoot, { projectDirectory: projectRoot });
    assert.deepEqual(unchanged.map((result) => result.status), ["unchanged", "unchanged"]);
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: agent-graph-runtime\ndescription: updated\n---\n");
    const updated = await installSkills(packageRoot, { projectDirectory: projectRoot });
    assert.deepEqual(updated.map((result) => result.status), ["updated", "updated"]);
    assert.match(
      await readFile(join(projectRoot, ".claude", "skills", "agent-graph-runtime", "SKILL.md"), "utf8"),
      /agent-graph-runtime/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer dry-run reports destinations without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-skills-dry-"));
  const packageRoot = join(root, "package");
  const projectRoot = join(root, "project");
  const skillRoot = join(packageRoot, "skills", "agent-graph-runtime");
  await mkdir(skillRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: agent-graph-runtime\n---\n");
  try {
    const planned = await installSkills(packageRoot, { projectDirectory: projectRoot, dryRun: true });
    assert.deepEqual(planned.map((result) => result.status), ["installed", "installed"]);
    await assert.rejects(readFile(join(projectRoot, ".agents", "skills", "agent-graph-runtime", "SKILL.md")));
    await assert.rejects(readFile(join(projectRoot, ".claude", "skills", "agent-graph-runtime", "SKILL.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill hashes frame file paths and contents unambiguously", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-skills-framing-"));
  const packageRoot = join(root, "package");
  const projectRoot = join(root, "project");
  const source = join(packageRoot, "skills", "agent-graph-runtime");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "a"), "X");
  await writeFile(join(source, "b"), "YbZ");
  for (const base of [".agents", ".claude"]) {
    const destination = join(projectRoot, base, "skills", "agent-graph-runtime");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "a"), "XbY");
    await writeFile(join(destination, "b"), "Z");
  }
  try {
    const results = await installSkills(packageRoot, { projectDirectory: projectRoot });
    assert.deepEqual(results.map((result) => result.status), ["updated", "updated"]);
    assert.equal(await readFile(join(projectRoot, ".agents", "skills", "agent-graph-runtime", "a"), "utf8"), "X");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer removes destination files that no longer exist in the package", async () => {
  const root = await mkdtemp(join(tmpdir(), "agr-skills-stale-"));
  const packageRoot = join(root, "package");
  const projectRoot = join(root, "project");
  const source = join(packageRoot, "skills", "agent-graph-runtime");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "current");
  try {
    await installSkills(packageRoot, { projectDirectory: projectRoot });
    for (const base of [".agents", ".claude"]) {
      await writeFile(join(projectRoot, base, "skills", "agent-graph-runtime", "obsolete.md"), "stale");
    }
    const results = await installSkills(packageRoot, { projectDirectory: projectRoot });
    assert.deepEqual(results.map((result) => result.status), ["updated", "updated"]);
    for (const base of [".agents", ".claude"]) {
      await assert.rejects(readFile(join(projectRoot, base, "skills", "agent-graph-runtime", "obsolete.md")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
