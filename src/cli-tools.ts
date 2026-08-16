import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, delimiter, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { validateGraph } from "./graph.js";
import { CliError } from "./cli-error.js";
import { resolveSpawnCommand } from "./adapters.js";
import {
  readRunEventArtifact,
  readRunStateArtifact,
} from "./observation.js";
import type { ExecutorName, GraphDefinition, GraphNodeDefinition, RunEvent, RunState } from "./types.js";

const exec = promisify(execFile);

export const graphSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Agent Graph Runtime graph",
  type: "object",
  additionalProperties: false,
  required: ["version", "run", "nodes"],
  properties: {
    version: { const: 1 },
    run: {
      type: "object",
      additionalProperties: false,
      required: ["id", "objective", "repository", "maxConcurrency"],
      properties: {
        id: { type: "string", minLength: 1 },
        objective: { type: "string", minLength: 1 },
        repository: { type: "string", minLength: 1 },
        maxConcurrency: { type: "integer", minimum: 1 },
        allowExternalActions: { type: "boolean" },
        codeGraph: { type: "boolean" },
        advisor: {
          type: "object",
          additionalProperties: false,
          required: ["executor"],
          properties: {
            executor: { enum: ["codex", "claude", "claudex"] },
            model: { type: "string", minLength: 1 },
            instructions: { type: "string", maxLength: 4_000 },
            stopOnBlocker: { type: "boolean" },
          },
          allOf: [{
            if: { properties: { executor: { const: "claudex" } }, required: ["executor"] },
            then: { not: { required: ["model"] } },
          }],
        },
      },
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "needs", "owns", "checks", "maxAttempts"],
        properties: {
          id: { type: "string", minLength: 1 },
          type: { enum: ["agent", "verify", "review", "human_gate", "external_action"] },
          executor: { enum: ["codex", "claude", "claudex", "shell"] },
          prompt: { type: "string" },
          target: { type: "string" },
          needs: { type: "array", items: { type: "string" } },
          owns: { type: "array", items: { type: "string" } },
          implicitOutputs: { type: "array", items: { type: "string" } },
          checks: { type: "array", items: { type: "string" } },
          maxAttempts: { type: "integer", minimum: 1 },
          timeoutMs: { type: "integer", minimum: 1 },
          model: { type: "string" },
          requiredModelUsage: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["model", "provider", "contextWindow"],
              properties: {
                model: { type: "string", minLength: 1 },
                provider: { type: "string", minLength: 1 },
                contextWindow: { type: "integer", minimum: 1 },
              },
            },
          },
          context: {
            type: "object",
            additionalProperties: false,
            properties: {
              symbols: { type: "array", items: { type: "string" } },
              impact: { type: "array", items: { type: "string" } },
              affectedFiles: { type: "array", items: { type: "string" } },
            },
          },
        },
        allOf: [
          {
            if: { properties: { type: { enum: ["agent", "review"] } }, required: ["type"] },
            then: { required: ["executor", "prompt"] },
          },
          {
            if: { properties: { type: { const: "review" } }, required: ["type"] },
            then: {
              properties: {
                owns: { type: "array", maxItems: 0 },
                implicitOutputs: { type: "array", maxItems: 0 },
              },
            },
          },
          {
            if: { properties: { type: { enum: ["human_gate", "external_action"] } }, required: ["type"] },
            then: { required: ["target"] },
          },
          {
            if: { properties: { type: { const: "external_action" } }, required: ["type"] },
            then: { required: ["executor"] },
          },
          {
            if: { properties: { executor: { const: "claudex" } }, required: ["executor"] },
            then: { not: { required: ["model"] } },
          },
          {
            if: { required: ["requiredModelUsage"] },
            then: {
              properties: {
                executor: { const: "claudex" },
                type: { enum: ["agent", "review", "external_action"] },
              },
              required: ["executor", "type"],
            },
          },
        ],
      },
    },
  },
} as const;

export async function initializeGraph(
  graphPath: string,
  template: "minimal" | "codex-claudex",
  repositoryRoot = process.cwd(),
): Promise<GraphDefinition> {
  const conventionalAlias =
    basename(dirname(graphPath)) === ".agent-graph" && basename(graphPath).toLowerCase() === "graph.json";
  const repository = conventionalAlias
    ? "."
    : (relative(dirname(graphPath), repositoryRoot).replaceAll("\\", "/") || ".");
  const nodes: GraphNodeDefinition[] = template === "minimal"
    ? [{ id: "verify", type: "verify", needs: [], owns: [], checks: [], maxAttempts: 1 }]
    : [
        { id: "implementation", type: "agent", executor: "codex", prompt: "Implement the requested change.", needs: [], owns: ["src/**", "test/**"], checks: [], maxAttempts: 1 },
        { id: "review", type: "review", executor: "claudex", prompt: "Independently review the final implementation.", needs: ["implementation"], owns: [], checks: [], maxAttempts: 1 },
      ];
  const graph: GraphDefinition = {
    version: 1,
    run: {
      id: `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
      objective: "Replace with the user-visible outcome",
      repository,
      maxConcurrency: 1,
    },
    nodes,
  };
  await mkdir(dirname(graphPath), { recursive: true });
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return graph;
}

export async function readRunState(repositoryRoot: string, runId: string): Promise<RunState> {
  return readRunStateArtifact(repositoryRoot, runId);
}

export async function listRuns(repositoryRoot: string): Promise<RunState[]> {
  const root = join(repositoryRoot, ".agent-graph", "runs");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const states: RunState[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    try {
      states.push(await readRunState(repositoryRoot, entry.name));
    } catch (error) {
      if (!(error instanceof CliError && error.code === "RUN_NOT_FOUND")) throw error;
    }
  }
  return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readRunEvents(repositoryRoot: string, runId: string): Promise<RunEvent[]> {
  return readRunEventArtifact(repositoryRoot, runId);
}

export async function readRunLogs(
  repositoryRoot: string,
  runId: string,
  nodeId?: string,
): Promise<Array<{ path: string; content: string }>> {
  await readRunState(repositoryRoot, runId);
  const root = join(runDirectory(repositoryRoot, runId), "outputs");
  let attempts;
  try {
    attempts = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const logs: Array<{ path: string; content: string }> = [];
  for (const attempt of attempts.filter((entry) => entry.isDirectory() && (!nodeId || entry.name.startsWith(`${nodeId}-attempt-`)))) {
    const attemptRoot = join(root, attempt.name);
    for (const file of await readdir(attemptRoot, { withFileTypes: true })) {
      if (!file.isFile() || !/\.(stdout|stderr)\.(jsonl|json|txt)$/.test(file.name)) continue;
      const path = join(attemptRoot, file.name);
      logs.push({ path, content: await readFile(path, "utf8") });
    }
  }
  return logs;
}

export function explainNode(graph: GraphDefinition, nodeId: string): Record<string, unknown> {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new CliError(`node "${nodeId}" not found`, 3, "NODE_NOT_FOUND");
  const dependants = graph.nodes.filter((candidate) => candidate.needs.includes(nodeId)).map((candidate) => candidate.id);
  return {
    ...node,
    dependants,
    gate: node.type === "human_gate",
    externalEffect: node.type === "external_action",
    writeScope: node.type === "review" ? "read-only" : node.owns,
  };
}

export function graphToMermaid(graph: GraphDefinition): string {
  const lines = ["flowchart TD"];
  graph.nodes.forEach((node, index) => {
    const shape = node.type === "human_gate" ? [`n${index}{`, "}"] : node.type === "external_action" ? [`n${index}([`, "])" ] : [`n${index}[`, "]"];
    lines.push(`  ${shape[0]}"${escapeMermaid(node.id)} · ${node.type}"${shape[1]}`);
  });
  const indices = new Map(graph.nodes.map((node, index) => [node.id, index]));
  graph.nodes.forEach((node, index) => node.needs.forEach((dependency) => lines.push(`  n${indices.get(dependency)} --> n${index}`)));
  return `${lines.join("\n")}\n`;
}

export function completionScript(shell: "powershell" | "bash" | "zsh"): string {
  const commands = "validate plan run progress follow wait inspect why advisor status runs events logs report approve retry cancel unlock doctor init schema node graph install-skills completion";
  if (shell === "powershell") return `Register-ArgumentCompleter -Native -CommandName agr -ScriptBlock { param($wordToComplete) '${commands}'.Split(' ') | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) } }\n`;
  if (shell === "zsh") return `#compdef agr\n_arguments '1:command:(${commands})'\n`;
  return `complete -W '${commands}' agr\n`;
}

export async function diagnoseEnvironment(
  graph: GraphDefinition,
  repositoryRoot: string,
): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.versions.node });
  const validation = validateGraph(graph);
  checks.push({ name: "graph", ok: validation.errors.length === 0, detail: validation.errors.join("; ") || `${graph.nodes.length} nodes` });
  try {
    const { stdout } = await exec("git", ["--version"], { encoding: "utf8" });
    checks.push({ name: "git", ok: true, detail: stdout.trim() });
  } catch (error) {
    checks.push({ name: "git", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    await access(repositoryRoot);
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repositoryRoot, encoding: "utf8" });
    checks.push({ name: "repository", ok: true, detail: repositoryRoot });
  } catch (error) {
    checks.push({ name: "repository", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const executors = new Set([
    ...graph.nodes.map((node) => node.executor),
    graph.run.advisor?.executor,
  ].filter((value): value is ExecutorName => Boolean(value) && value !== "shell"));
  for (const executor of executors) {
    const path = await findOnPath(executor);
    if (!path) {
      checks.push({ name: executor, ok: false, detail: "not found on PATH" });
      continue;
    }
    try {
      const resolved = await resolveSpawnCommand(path, ["--version"]);
      const { stdout, stderr } = await exec(resolved.command, resolved.args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      checks.push({ name: executor, ok: true, detail: `${path} — ${(stdout || stderr).trim() || "version command succeeded"}` });
    } catch (error) {
      checks.push({ name: executor, ok: false, detail: `${path} — ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (process.platform === "win32" && executors.has("claudex")) {
    const path = await findOnPath("pwsh");
    checks.push({ name: "pwsh", ok: Boolean(path), detail: path ?? "not found on PATH" });
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export function runDirectory(repositoryRoot: string, runId: string): string {
  return join(repositoryRoot, ".agent-graph", "runs", runId);
}

async function findOnPath(command: string): Promise<string | undefined> {
  const extensions = process.platform === "win32"
    ? [...new Set([...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";"), ".PS1"])]
    : [""];
  if (extname(command)) extensions.unshift("");
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(directory.replace(/^"|"$/g, ""), `${command}${extension.toLowerCase()}`);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Continue PATH resolution.
      }
    }
  }
  return undefined;
}

function escapeMermaid(value: string): string {
  return value.replaceAll('"', "'").replaceAll("\n", " ");
}
