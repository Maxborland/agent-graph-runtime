import { spawn } from "node:child_process";

export interface CheckResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export async function runChecks(
  repositoryRoot: string,
  commands: string[],
  timeoutMs: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) {
    results.push(await runCheck(repositoryRoot, command, timeoutMs));
  }
  return results;
}

async function runCheck(
  repositoryRoot: string,
  command: string,
  timeoutMs: number,
): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: repositoryRoot,
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-200_000);
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
      resolve({
        command,
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

