import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ObservedExecution } from "./types.js";

export class CodexSessionExecutionChangedError extends Error {
  constructor(readonly previousExecution: ObservedExecution, readonly observedExecution: ObservedExecution) {
    super("Codex session reported changing effective model or reasoning effort");
  }
}

/** Read only the rollout belonging to the thread captured from this invocation. */
export async function readCodexSessionExecution(
  threadId: string,
  repositoryRoot: string,
  startedAt: number,
  finishedAt: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ObservedExecution | undefined> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) return undefined;
  const sessions = join(environment.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  // Rollout folders use the host's date. Include adjacent dates for timezone
  // boundaries, but never scan unrelated session contents or archived history.
  const dates = new Set<string>();
  for (const time of [startedAt, finishedAt]) {
    for (const delta of [-86_400_000, 0, 86_400_000]) {
      dates.add(new Date(time + delta).toISOString().slice(0, 10).replaceAll("-", "/"));
    }
  }
  const candidates: string[] = [];
  for (const date of dates) {
    const directory = join(sessions, date);
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) {
          candidates.push(join(directory, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
  }
  if (candidates.length !== 1) return undefined;
  const stream = createReadStream(candidates[0]!, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let matched = false;
  let observed: ObservedExecution | undefined;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return undefined; }
      if (!isRecord(record)) continue;
      const payload = record.payload;
      if (!isRecord(payload)) continue;
      if (record.type === "session_meta") {
        if (matched || payload.id !== threadId || !sameDirectory(payload.cwd, repositoryRoot) ||
          !duringInvocation(payload.timestamp ?? record.timestamp, startedAt, finishedAt)) return undefined;
        matched = true;
      } else if (record.type === "turn_context") {
        if (!matched || !sameDirectory(payload.cwd, repositoryRoot) ||
          !duringInvocation(record.timestamp, startedAt, finishedAt)) return undefined;
        const model = typeof payload.model === "string" && payload.model ? payload.model : undefined;
        const effort = typeof payload.effort === "string" && payload.effort ? payload.effort : undefined;
        if (observed && ((model && observed.model && model !== observed.model) ||
          (effort && observed.reasoningEffort && effort !== observed.reasoningEffort))) {
          throw new CodexSessionExecutionChangedError(observed, {
            ...observed,
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          });
        }
        observed = {
          threadId,
          ...(observed ?? {}),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return observed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sameDirectory(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actual = resolve(value);
  const target = resolve(expected);
  return process.platform === "win32" ? actual.toLowerCase() === target.toLowerCase() : actual === target;
}
function duringInvocation(value: unknown, start: number, end: number): boolean {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= start - 5_000 && timestamp <= end + 5_000;
}
