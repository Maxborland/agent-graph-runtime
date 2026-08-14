import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AdapterRequest,
  AdapterResult,
  AgentHandoff,
} from "./types.js";

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["complete", "partial", "blocked"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "changedFiles", "verification", "gaps"],
} as const;

export interface AgentAdapter {
  execute(request: AdapterRequest): Promise<AdapterResult>;
}

export class CodexAdapter implements AgentAdapter {
  constructor(
    private readonly command = "codex",
    private readonly prefixArguments: string[] = [],
  ) {}

  async execute(request: AdapterRequest): Promise<AdapterResult> {
    await mkdir(request.artifactsDirectory, { recursive: true });
    const schemaPath = join(request.artifactsDirectory, `${request.node.id}.schema.json`);
    const outputPath = join(request.artifactsDirectory, `${request.node.id}.codex.json`);
    await writeFile(schemaPath, JSON.stringify(outputSchema), "utf8");
    const sandbox = request.node.type === "review" ? "read-only" : "workspace-write";
    const args = [
      ...this.prefixArguments,
      "exec",
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--sandbox",
      sandbox,
      "--cd",
      request.repositoryRoot,
      "-c",
      'approval_policy="never"',
    ];
    if (request.node.model) args.push("--model", request.node.model);
    args.push("-");
    const processResult = await runProcess(
      this.command,
      args,
      request.prompt,
      request.repositoryRoot,
      request.timeoutMs,
    );
    await Promise.all([
      writeFile(join(request.artifactsDirectory, `${request.node.id}.codex.stdout.jsonl`), processResult.stdout, "utf8"),
      writeFile(join(request.artifactsDirectory, `${request.node.id}.codex.stderr.txt`), processResult.stderr, "utf8"),
    ]);
    if (processResult.exitCode !== 0) throw processFailure("Codex", processResult);
    const raw = await readFile(outputPath, "utf8");
    return { ...processResult, handoff: parseHandoff(raw) };
  }
}

export class ClaudeAdapter implements AgentAdapter {
  constructor(
    private readonly command = "claude",
    private readonly prefixArguments: string[] = [],
  ) {}

  async execute(request: AdapterRequest): Promise<AdapterResult> {
    await mkdir(request.artifactsDirectory, { recursive: true });
    const readOnly = request.node.type === "review";
    const tools = readOnly ? "Read,Glob,Grep,Bash" : "Read,Edit,Write,Glob,Grep,Bash";
    const args = [
      ...this.prefixArguments,
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(outputSchema),
      "--permission-mode",
      readOnly ? "dontAsk" : "acceptEdits",
      "--tools",
      tools,
    ];
    if (readOnly) args.push("--disallowedTools", "Edit,Write,NotebookEdit");
    if (request.node.model) args.push("--model", request.node.model);
    const processResult = await runProcess(
      this.command,
      args,
      request.prompt,
      request.repositoryRoot,
      request.timeoutMs,
    );
    await Promise.all([
      writeFile(join(request.artifactsDirectory, `${request.node.id}.claude.stdout.json`), processResult.stdout, "utf8"),
      writeFile(join(request.artifactsDirectory, `${request.node.id}.claude.stderr.txt`), processResult.stderr, "utf8"),
    ]);
    if (processResult.exitCode !== 0) throw processFailure("Claude", processResult);
    const parsed = JSON.parse(processResult.stdout) as unknown;
    const candidate = findStructuredOutput(parsed);
    return { ...processResult, handoff: validateHandoff(candidate) };
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runProcess(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-1_000_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.end(input);
  });
}

function parseHandoff(raw: string): AgentHandoff {
  return validateHandoff(JSON.parse(raw) as unknown);
}

function findStructuredOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("structured_output" in value) return value.structured_output;
  if ("structuredOutput" in value) return value.structuredOutput;
  if (typeof value.result === "string") {
    try {
      return JSON.parse(value.result) as unknown;
    } catch {
      return value.result;
    }
  }
  return value;
}

function validateHandoff(value: unknown): AgentHandoff {
  if (!isRecord(value)) throw new Error("agent output is not an object");
  if (!["complete", "partial", "blocked"].includes(String(value.status))) {
    throw new Error("agent output has invalid status");
  }
  if (typeof value.summary !== "string") throw new Error("agent output requires summary");
  for (const key of ["changedFiles", "verification", "gaps"] as const) {
    if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string")) {
      throw new Error(`agent output requires string array ${key}`);
    }
  }
  return {
    status: value.status as AgentHandoff["status"],
    summary: value.summary,
    changedFiles: value.changedFiles as string[],
    verification: value.verification as string[],
    gaps: value.gaps as string[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processFailure(provider: string, result: ProcessResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return new Error(`${provider} exited ${result.exitCode}: ${detail.slice(-2_000)}`);
}
