import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

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

class ClaudeProtocolAdapter implements AgentAdapter {
  constructor(
    private readonly command = "claude",
    private readonly prefixArguments: string[] = [],
    private readonly providerLabel = "Claude",
    private readonly artifactStem = "claude",
    private readonly allowModelOverride = true,
    private readonly preserveToolDiscovery = false,
  ) {}

  async execute(request: AdapterRequest): Promise<AdapterResult> {
    if (!this.allowModelOverride && request.node.model) {
      throw new Error(`${this.providerLabel} nodes cannot override the launcher model`);
    }
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
    ];
    if (this.preserveToolDiscovery) {
      args.push("--allowedTools", "Workflow,Skill");
    } else {
      args.push("--tools", tools);
    }
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
      writeFile(join(request.artifactsDirectory, `${request.node.id}.${this.artifactStem}.stdout.json`), processResult.stdout, "utf8"),
      writeFile(join(request.artifactsDirectory, `${request.node.id}.${this.artifactStem}.stderr.txt`), processResult.stderr, "utf8"),
    ]);
    if (processResult.exitCode !== 0) throw processFailure(this.providerLabel, processResult);
    const parsed = JSON.parse(processResult.stdout) as unknown;
    const candidate = findStructuredOutput(parsed);
    return { ...processResult, handoff: validateHandoff(candidate) };
  }
}

export class ClaudeAdapter extends ClaudeProtocolAdapter {
  constructor(command = "claude", prefixArguments: string[] = []) {
    super(command, prefixArguments, "Claude", "claude", true, false);
  }
}

export class ClaudexAdapter extends ClaudeProtocolAdapter {
  constructor(command = "claudex", prefixArguments: string[] = []) {
    super(command, prefixArguments, "Claudex", "claudex", false, true);
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  timeoutMs: number;
}

async function runProcess(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  const resolved = await resolveSpawnCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
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
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut, timeoutMs });
    });
    child.stdin.end(input);
  });
}

export async function resolveSpawnCommand(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ command: string; args: string[] }> {
  if (platform !== "win32") return { command, args };

  let resolved = command;
  if (!command.includes("/") && !command.includes("\\") && extname(command) === "") {
    const pathValue = getEnvironmentValue(environment, "PATH") ?? "";
    const directories = pathValue.split(";").map((entry) => entry.replace(/^"|"$/g, ""));
    const extensions = [".exe", ".com", ".cmd", ".bat", ".ps1"];
    outer: for (const directory of directories) {
      if (!directory) continue;
      for (const extension of extensions) {
        const candidate = join(directory, `${command}${extension}`);
        try {
          await access(candidate);
          resolved = candidate;
          break outer;
        } catch {
          // Continue searching the configured PATH.
        }
      }
    }
  }

  if (/\.(cmd|bat)$/i.test(resolved)) {
    return {
      command: getEnvironmentValue(environment, "ComSpec") ?? "cmd.exe",
      args: ["/d", "/s", "/c", resolved, ...args],
    };
  }
  if (/\.ps1$/i.test(resolved)) {
    return {
      command: "pwsh.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolved, ...args],
    };
  }
  return { command: resolved, args };
}

function getEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
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
  if (result.timedOut) return new Error(`${provider} timed out after ${result.timeoutMs}ms`);
  const detail =
    result.stderr.trim() || providerResultDetail(result.stdout) || result.stdout.trim() || "no output";
  return new Error(`${provider} exited ${result.exitCode}: ${detail.slice(-2_000)}`);
}

function providerResultDetail(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return isRecord(parsed) && typeof parsed.result === "string" ? parsed.result : undefined;
  } catch {
    return undefined;
  }
}
