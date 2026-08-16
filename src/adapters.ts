import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterRequest,
  AdapterResult,
  AgentHandoff,
  ModelUsageEvidence,
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

const claudexImplementationAllowedTools = [
  "Skill",
  "mcp__plugin_playwright_playwright__browser_close",
  "mcp__plugin_playwright_playwright__browser_console_messages",
  "mcp__plugin_playwright_playwright__browser_network_requests",
  "mcp__plugin_playwright_playwright__browser_navigate",
  "mcp__plugin_playwright_playwright__browser_snapshot",
  "mcp__plugin_playwright_playwright__browser_take_screenshot",
  "mcp__plugin_playwright_playwright__browser_resize",
  "mcp__plugin_playwright_playwright__browser_wait_for",
  "mcp__plugin_playwright_playwright__browser_file_upload",
].join(",");

export interface AgentAdapter {
  execute(request: AdapterRequest): Promise<AdapterResult>;
}

export class NonRetryableAdapterError extends Error {
  override readonly name = "NonRetryableAdapterError";
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
      "--disable",
      "multi_agent",
      "--disable",
      "multi_agent_v2",
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
      request.signal,
      (line) => emitActivity(request.onActivity, summarizeCodexActivity(line)),
      request.environment,
    );
    await Promise.all([
      writeFile(join(request.artifactsDirectory, `${request.node.id}.codex.stdout.jsonl`), processResult.stdout, "utf8"),
      writeFile(join(request.artifactsDirectory, `${request.node.id}.codex.stderr.txt`), processResult.stderr, "utf8"),
    ]);
    if (processResult.terminationError) throw processResult.terminationError;
    if (processResult.aborted || processResult.timedOut || processResult.exitCode !== 0) {
      throw processFailure("Codex", processResult);
    }
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
    const tools = readOnly ? "Read,Glob,Grep" : "Read,Edit,Write,Glob,Grep,Bash";
    const args = [
      ...this.prefixArguments,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(outputSchema),
      "--permission-mode",
      readOnly ? "dontAsk" : this.preserveToolDiscovery ? "auto" : "acceptEdits",
    ];
    if (this.preserveToolDiscovery) {
      if (readOnly) {
        args.push(
          "--tools",
          "Read,Glob,Grep,Skill",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--strict-mcp-config",
          "--setting-sources=",
        );
      } else {
        args.push("--settings", claudexGuardSettings(request.repositoryRoot));
      }
      args.push(
        "--allowedTools",
        readOnly
          ? "Skill"
          : claudexImplementationAllowedTools,
      );
    } else {
      args.push("--tools", tools);
    }
    if (this.preserveToolDiscovery) {
      args.push(
        "--disallowedTools",
        readOnly
          ? "Workflow,Task,Agent,Bash,Edit,Write,NotebookEdit"
          : "Workflow,Task,Agent",
      );
    } else if (readOnly) {
      args.push("--disallowedTools", "Bash,Edit,Write,NotebookEdit");
    }
    if (request.node.model) args.push("--model", request.node.model);
    const processResult = await runProcess(
      this.command,
      args,
      request.prompt,
      request.repositoryRoot,
      request.timeoutMs,
      request.signal,
      (line) => emitActivity(request.onActivity, summarizeClaudeActivity(line, this.providerLabel, request.activityVerbosity)),
      request.environment,
    );
    await Promise.all([
      writeFile(join(request.artifactsDirectory, `${request.node.id}.${this.artifactStem}.stdout.json`), processResult.stdout, "utf8"),
      writeFile(join(request.artifactsDirectory, `${request.node.id}.${this.artifactStem}.stderr.txt`), processResult.stderr, "utf8"),
    ]);
    if (processResult.terminationError) throw processResult.terminationError;
    if (processResult.aborted || processResult.timedOut || processResult.exitCode !== 0) {
      throw processFailure(this.providerLabel, processResult);
    }
    const parsed = processResult.lastResultRecord ?? lastJsonRecord(processResult.stdout);
    const candidate = findStructuredOutput(parsed);
    const modelUsage = findModelUsage(parsed);
    return {
      ...processResult,
      handoff: validateHandoff(candidate),
      ...(modelUsage ? { modelUsage } : {}),
    };
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
  aborted: boolean;
  timeoutMs: number;
  lastResultRecord?: unknown;
  terminationError?: NonRetryableAdapterError;
}

const PROCESS_TREE_TERMINATION_GRACE_MS = 2_000;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 1_500;

async function runProcess(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onStdoutLine?: (line: string) => void,
  environment?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  if (signal?.aborted) throw abortError();
  const resolved = await resolveSpawnCommand(command, args);
  const preparedInput = await prepareProcessInput(resolved, input);
  const execution = new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: preparedInput ? [preparedInput.fd, "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...environment },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let termination: Promise<void> | undefined;
    let terminationError: Error | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let terminationDeadlineTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let stdoutLineBuffer = "";
    let lastResultRecord: unknown;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-1_000_000);
    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (terminationDeadlineTimer) clearTimeout(terminationDeadlineTimer);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (stdoutLineBuffer.trim()) observeStdoutLine(stdoutLineBuffer);
      stdoutLineBuffer = "";
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
        aborted,
        timeoutMs,
        ...(lastResultRecord === undefined ? {} : { lastResultRecord }),
        ...(terminationError
          ? {
              terminationError: new NonRetryableAdapterError(
                `failed to terminate ${timedOut ? "timed-out " : ""}process tree for PID ${child.pid ?? "unknown"}: ${terminationError.message}`,
              ),
            }
          : {}),
      });
    };
    const observeStdoutLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const record = JSON.parse(trimmed) as unknown;
        if (isRecord(record) && record.type === "result") lastResultRecord = record;
      } catch {
        // Raw output remains available for diagnostics; only complete result records are retained.
      }
      safelyObserveLine(onStdoutLine, line);
    };
    const forceFinalization = (error: Error): void => {
      if (settled) return;
      terminationError = error;
      child.kill();
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (!stream) continue;
        (stream as typeof stream & { unref?: () => void }).unref?.();
      }
      child.unref();
      finish(child.exitCode);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      stdoutLineBuffer += chunk.toString("utf8");
      let newline = stdoutLineBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutLineBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
        observeStdoutLine(line);
        newline = stdoutLineBuffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    const startTermination = (reason: "timeout" | "abort"): void => {
      if (termination || settled) return;
      timedOut = reason === "timeout";
      aborted = reason === "abort";
      termination = terminateProcessTree(child).catch((error: unknown) => {
        forceFinalization(error instanceof Error ? error : new Error(String(error)));
      });
      terminationDeadlineTimer = setTimeout(() => {
        forceFinalization(
          new Error(
            `process-tree termination was not confirmed within ${PROCESS_TREE_TERMINATION_GRACE_MS}ms`,
          ),
        );
      }, PROCESS_TREE_TERMINATION_GRACE_MS);
    };
    const onAbort = (): void => startTermination("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) startTermination("abort");
    timeoutTimer = setTimeout(() => startTermination("timeout"), timeoutMs);
    child.once("close", async (code) => {
      signal?.removeEventListener("abort", onAbort);
      await termination;
      finish(code);
    });
    child.stdin?.end(input);
  });
  const cleanup = preparedInput
    ? preparedInput.dispose().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )
    : Promise.resolve(undefined);
  try {
    const result = await execution;
    const cleanupError = await cleanup;
    if (cleanupError && !result.terminationError && result.exitCode === 0) {
      throw new NonRetryableAdapterError(`agent completed but temporary input cleanup failed: ${cleanupError.message}`);
    }
    return result;
  } catch (error) {
    await cleanup;
    throw error;
  }
}

async function prepareProcessInput(
  resolved: { command: string; args: string[] },
  input: string,
): Promise<{ fd: number; dispose: () => Promise<void> } | undefined> {
  const fileIndex = resolved.args.findIndex((argument) => argument.toLowerCase() === "-file");
  const isPowerShellFile =
    /(^|[\\/])pwsh(?:\.exe)?$/i.test(resolved.command) &&
    fileIndex !== -1 &&
    /\.ps1$/i.test(resolved.args[fileIndex + 1] ?? "");
  if (process.platform !== "win32" || !isPowerShellFile) return undefined;

  const directory = await mkdtemp(join(tmpdir(), "agr-stdin-"));
  const path = join(directory, "stdin.txt");
  try {
    await writeFile(path, input, { encoding: "utf8", mode: 0o600 });
    const handle = await open(path, "r");
    return {
      fd: handle.fd,
      dispose: async () => {
        await handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform !== "win32") {
    await terminatePosixProcessGroup(child.pid);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const taskkillPath = process.env.NODE_ENV === "test" && process.env.AGR_TEST_TASKKILL_PATH
    ? process.env.AGR_TEST_TASKKILL_PATH
    : join(systemRoot, "System32", "taskkill.exe");
  const resolvedKiller = await resolveSpawnCommand(
    taskkillPath,
    ["/PID", String(child.pid), "/T", "/F"],
  );
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(resolvedKiller.command, resolvedKiller.args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    killer.once("error", (error) => finish(error));
    killer.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`taskkill exited ${code ?? 1}`));
    });
    timer = setTimeout(() => {
      killer.kill();
      killer.unref();
      finish(new Error(`taskkill did not exit within ${WINDOWS_TREE_KILL_TIMEOUT_MS}ms`));
    }, WINDOWS_TREE_KILL_TIMEOUT_MS);
  });
}

async function terminatePosixProcessGroup(processGroupId: number): Promise<void> {
  if (!signalProcessGroup(processGroupId, "SIGTERM")) return;
  if (await waitForProcessGroupExit(processGroupId, 1_000)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return !isProcessGroupAlive(processGroupId);
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
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

function lastJsonRecord(raw: string): unknown {
  const records = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  if (records.length === 0) throw new Error("agent output is empty");
  return [...records].reverse().find((record) => isRecord(record) && record.type === "result") ?? records.at(-1);
}

function summarizeCodexActivity(line: string): string | undefined {
  const value = parseActivityRecord(line);
  if (!value) return undefined;
  const event = allowedValue(value.type, ["thread.started", "turn.started", "turn.completed", "item.started", "item.completed", "error"]);
  if (!event) return "Codex activity";
  if ((event === "item.started" || event === "item.completed") && isRecord(value.item)) {
    const item = allowedValue(value.item.type, ["agent_message", "reasoning", "command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"]);
    return `Codex ${event}${item ? `:${item}` : ":item"}`;
  }
  return `Codex ${event}`;
}

function summarizeClaudeActivity(
  line: string,
  provider: string,
  verbosity: AdapterRequest["activityVerbosity"] = "normal",
): string | undefined {
  const value = parseActivityRecord(line);
  if (!value) return undefined;
  const event = allowedValue(value.type, ["system", "assistant", "user", "result"]);
  if (!event) return `${provider} activity`;
  if ((event === "assistant" || event === "user") && isRecord(value.message) && Array.isArray(value.message.content)) {
    const blockTypes = [...new Set(value.message.content.flatMap((block) =>
      isRecord(block)
        ? [allowedValue(block.type, ["text", "tool_use", "tool_result", "thinking", "server_tool_use"]) ?? "content"]
        : [],
    ))];
    const toolNames = verbosity === "verbose"
      ? [...new Set(value.message.content.flatMap((block) => {
          if (!isRecord(block) || block.type !== "tool_use") return [];
          return typeof block.name === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(block.name)
            ? [block.name]
            : [];
        }))].slice(0, 4)
      : [];
    const toolDetail = toolNames.length > 0 ? `[${toolNames.join(",")}]` : "";
    return `${provider} ${event}${blockTypes.length > 0 ? `:${blockTypes.join("+")}` : ""}${toolDetail}`;
  }
  const subtype = event === "system" || event === "result"
    ? allowedValue(value.subtype, ["init", "success", "error_max_turns", "error_during_execution"])
    : undefined;
  if (event === "system" && !subtype) return undefined;
  return `${provider} ${event}${subtype ? `:${subtype}` : ""}`;
}

function parseActivityRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function allowedValue(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

function emitActivity(callback: AdapterRequest["onActivity"], summary: string | undefined): void {
  if (!callback || !summary) return;
  try {
    callback(summary);
  } catch {
    // Progress rendering must not affect execution.
  }
}

function safelyObserveLine(callback: ((line: string) => void) | undefined, line: string): void {
  if (!callback) return;
  try {
    callback(line);
  } catch {
    // Activity observers are non-authoritative diagnostics.
  }
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

function claudexGuardSettings(repositoryRoot: string): string {
  const guardPath = fileURLToPath(new URL("./claudex-guard.js", import.meta.url));
  const command = [process.execPath, guardPath, repositoryRoot]
    .map(quoteHookArgument)
    .join(" ");
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Edit|Write|NotebookEdit|Glob|Grep|Bash|mcp__plugin_playwright_playwright__.*",
          hooks: [{ type: "command", command }],
        },
      ],
    },
  });
}

function quoteHookArgument(value: string): string {
  return '"' +
    value
      .replaceAll("\\", "/")
      .replaceAll('"', '\\"')
      .replaceAll("$", "\\$") +
    '"';
}

function findModelUsage(value: unknown): Record<string, ModelUsageEvidence> | undefined {
  if (!isRecord(value) || !isRecord(value.modelUsage)) return undefined;
  const usage: Record<string, ModelUsageEvidence> = {};
  for (const [model, candidate] of Object.entries(value.modelUsage)) {
    if (!isRecord(candidate)) continue;
    usage[model] = {
      ...(typeof candidate.canonicalModel === "string"
        ? { canonicalModel: candidate.canonicalModel }
        : {}),
      ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
      ...(typeof candidate.contextWindow === "number"
        ? { contextWindow: candidate.contextWindow }
        : {}),
    };
  }
  return usage;
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
  if (result.aborted) return abortError(`${provider} cancelled`);
  if (result.timedOut) return new Error(`${provider} timed out after ${result.timeoutMs}ms`);
  const detail =
    result.stderr.trim() || providerResultDetail(result) || result.stdout.trim() || "no output";
  return new Error(`${provider} exited ${result.exitCode}: ${detail.slice(-2_000)}`);
}

function abortError(message = "operation cancelled"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function providerResultDetail(result: ProcessResult): string | undefined {
  try {
    const parsed = result.lastResultRecord ?? lastJsonRecord(result.stdout);
    return isRecord(parsed) && typeof parsed.result === "string" ? parsed.result : undefined;
  } catch {
    return undefined;
  }
}
