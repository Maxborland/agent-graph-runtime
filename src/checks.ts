import { spawn } from "node:child_process";
import { terminateProcessTree } from "./adapters.js";

export interface CheckResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  terminationError?: string;
  durationMs: number;
}

export async function runChecks(
  repositoryRoot: string,
  commands: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    if (signal?.aborted) {
      if (results.length > 0) break;
      throw abortError();
    }
    const result = await runCheck(repositoryRoot, command, timeoutMs, signal);
    results.push(result);
    if (result.cancelled || result.terminationError !== undefined) break;
  }
  return results;
}

async function runCheck(
  repositoryRoot: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: repositoryRoot,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let terminating = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    let finalizationTimer: NodeJS.Timeout | undefined;
    let terminationError: string | undefined;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-200_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (finalizationTimer) clearTimeout(finalizationTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (finalizationTimer) clearTimeout(finalizationTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        command,
        exitCode: cancelled ? 130 : timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        timedOut,
        cancelled,
        ...(terminationError ? { terminationError } : {}),
        durationMs: Date.now() - started,
      });
    };
    const terminate = (reason: "timeout" | "abort"): void => {
      if (terminating) return;
      terminating = true;
      timedOut = reason === "timeout";
      cancelled = reason === "abort";
      termination = terminateProcessTree(child).catch((error: unknown) => {
        terminationError = error instanceof Error ? error.message : String(error);
        child.kill();
      });
      finalizationTimer = setTimeout(() => {
        terminationError ??= "process-tree termination was not confirmed before the finalization deadline";
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        (child.stdout as typeof child.stdout & { unref?: () => void }).unref?.();
        (child.stderr as typeof child.stderr & { unref?: () => void }).unref?.();
        child.unref();
        finish(child.exitCode);
      }, 2_500);
    };
    const onAbort = (): void => terminate("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    if (signal?.aborted) terminate("abort");
    child.on("close", async (code) => {
      await termination;
      finish(code);
    });
  });
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}
