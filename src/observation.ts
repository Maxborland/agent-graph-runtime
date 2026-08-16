import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "./cli-error.js";
import { inspectRunLock } from "./run-lock.js";
import { readCurrentGeneration } from "./persistence.js";
import { assertSafeRunId } from "./run-id.js";
import type { RunEvent, RunState } from "./types.js";

export interface RunObservationSnapshot {
  runId: string;
  status: RunState["status"];
  terminal: boolean;
  cursor: number;
  events: RunEvent[];
  activeNodes: Array<{ id: string; attempts: number }>;
  state: RunState;
}

export interface RunWaitObservation extends RunObservationSnapshot {
  timedOut: boolean;
}

export interface RunInspection {
  runId: string;
  status: RunState["status"];
  cursor: number;
  updatedAt: string;
  activeNodes: Array<{
    id: string;
    attempts: number;
    elapsedMs: number;
    silentForMs: number;
    latestMilestone?: { phase?: string; message?: string; percent?: number; at: string };
  }>;
  attentionNodes: Array<{ id: string; error?: string }>;
  advisorBlocker?: { id: string; severity: "blocker"; summary: string; evidenceFile: string };
}

export interface RunStopIssue {
  code: string;
  nodeId?: string;
  retrySafety: "not_applicable" | "safe" | "inspect_required" | "forbidden";
  paths?: string[];
  detail?: string;
  nextAction: string;
}

export interface RunStopExplanation {
  runId: string;
  status: RunState["status"];
  issues: RunStopIssue[];
}

export interface ObserverHeartbeat {
  at: string;
  type: "observer_heartbeat";
  cursor: number;
  status: RunState["status"];
  activeNodeIds: string[];
}

const runEventTypes = new Set<RunEvent["type"]>([
  "state_saved",
  "node_interrupted",
  "run_started",
  "approval_required",
  "node_started",
  "node_activity",
  "node_progress",
  "node_accepted",
  "node_failed",
  "run_completed",
  "run_failed",
  "run_needs_attention",
  "run_cancelled",
  "approval_recorded",
  "approval_reserved",
  "approval_consumed",
  "reconciliation_recorded",
  "node_invalidated",
  "advisor_note",
  "advisor_failed",
  "advisor_acknowledged",
]);

export class RunObserver {
  constructor(
    private readonly repositoryRoot: string,
    private readonly runId: string,
  ) {}

  async read(after = 0, limit = 100): Promise<RunObservationSnapshot> {
    const [state, history] = await Promise.all([
      readRunStateArtifact(this.repositoryRoot, this.runId),
      readRunEventArtifact(this.repositoryRoot, this.runId),
    ]);
    const events = history.filter((event) => event.seq > after).slice(0, limit);
    return {
      runId: state.runId,
      status: state.status,
      terminal: state.status !== "running",
      cursor: events.at(-1)?.seq ?? after,
      events,
      activeNodes: Object.entries(state.nodes)
        .filter(([, node]) => node.status === "running")
        .map(([id, node]) => ({ id, attempts: node.attempts })),
      state,
    };
  }

  async wait(after: number, timeoutMs: number, limit = 100): Promise<RunWaitObservation> {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await this.read(after, limit);
    while (snapshot.events.length === 0 && !snapshot.terminal && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      snapshot = await this.read(after, limit);
    }
    return {
      ...snapshot,
      timedOut: snapshot.events.length === 0 && !snapshot.terminal && Date.now() >= deadline,
    };
  }

  async inspect(now = Date.now()): Promise<RunInspection> {
    const [state, events] = await Promise.all([
      readRunStateArtifact(this.repositoryRoot, this.runId),
      readRunEventArtifact(this.repositoryRoot, this.runId),
    ]);
    const activeNodes = Object.entries(state.nodes)
      .filter(([, node]) => node.status === "running")
      .map(([id, node]) => {
        const nodeEvents = events.filter((event) => event.nodeId === id);
        const started = [...nodeEvents].reverse().find((event) => event.type === "node_started");
        const latest = nodeEvents.at(-1) ?? started;
        const milestone = [...nodeEvents].reverse().find((event) => event.type === "node_progress");
        const startedAt = Date.parse(started?.at ?? state.updatedAt);
        const lastAt = Date.parse(latest?.at ?? started?.at ?? state.updatedAt);
        return {
          id,
          attempts: node.attempts,
          elapsedMs: Math.max(0, now - startedAt),
          silentForMs: Math.max(0, now - lastAt),
          ...(milestone
            ? {
                latestMilestone: {
                  ...(milestone.phase === undefined ? {} : { phase: milestone.phase }),
                  ...(milestone.detail === undefined ? {} : { message: milestone.detail }),
                  ...(milestone.percent === undefined ? {} : { percent: milestone.percent }),
                  at: milestone.at,
                },
              }
            : {}),
        };
      });
    return {
      runId: state.runId,
      status: state.status,
      cursor: events.at(-1)?.seq ?? 0,
      updatedAt: state.updatedAt,
      activeNodes,
      attentionNodes: Object.entries(state.nodes)
        .filter(([, node]) => Boolean(node.retryBlocked))
        .map(([id, node]) => ({ id, ...(node.lastError === undefined ? {} : { error: node.lastError }) })),
      ...(state.advisor?.blocker === undefined
        ? {}
        : {
            advisorBlocker: {
              id: state.advisor.blocker.id,
              severity: "blocker" as const,
              summary: state.advisor.blocker.summary,
              evidenceFile: state.advisor.blocker.evidenceFile,
            },
          }),
    };
  }

  async explain(): Promise<RunStopExplanation> {
    const state = await readRunStateArtifact(this.repositoryRoot, this.runId);
    const issues: RunStopIssue[] = [];
    if (state.status === "running") {
      issues.push({
        code: "RUN_ACTIVE",
        retrySafety: "forbidden",
        nextAction: "Keep observing with agr follow or agr wait; do not start another run or retry an active node.",
      });
    } else if (state.status === "awaiting_approval") {
      const gate = Object.entries(state.nodes).find(([, node]) => node.status === "awaiting_approval");
      issues.push({
        code: "APPROVAL_REQUIRED",
        ...(gate ? { nodeId: gate[0] } : {}),
        retrySafety: "not_applicable",
        nextAction: gate
          ? `Inspect the gate target, then use agr approve ${gate[0]} <exact-target> explicitly.`
          : "Inspect the run report and approve only the exact recorded gate target.",
      });
    } else {
      if (state.advisor?.blocker) {
        issues.push({
          code: "ADVISOR_BLOCKER",
          nodeId: state.advisor.blocker.id,
          retrySafety: "inspect_required",
          detail: state.advisor.blocker.summary,
          nextAction: "Inspect the advisor evidence and affected contract, then run agr advisor acknowledge explicitly before resuming.",
        });
      }
      for (const [nodeId, node] of Object.entries(state.nodes)) {
        if (!node.lastError) continue;
        const ownership = /unexpected changed paths:\s*([^;]+)/i.exec(node.lastError);
        if (ownership) {
          issues.push({
            code: "OWNERSHIP_ESCAPE",
            nodeId,
            retrySafety: "inspect_required",
            paths: ownership[1]!.split(/,\s*/).map((path) => path.trim()).filter(Boolean),
            nextAction: `Stop or isolate every external writer, inspect the paths and evidence, then run agr retry ${nodeId} explicitly.`,
          });
          continue;
        }
        const termination = /unconfirmed .*process-tree termination|failed to terminate/i.test(node.lastError);
        const checkFailure = /failed checks:/i.test(node.lastError);
        const semanticBlock = /agent status (partial|blocked)/i.test(node.lastError);
        issues.push({
          code: termination
            ? "PROCESS_TERMINATION_UNCONFIRMED"
            : checkFailure
              ? "CHECK_FAILED"
              : semanticBlock
                ? "AGENT_NEEDS_ATTENTION"
                : "NODE_FAILED",
          nodeId,
          retrySafety: node.retryBlocked ? "inspect_required" : "safe",
          detail: node.lastError,
          nextAction: node.retryBlocked
            ? `Inspect the node evidence and partial effects, then run agr retry ${nodeId} explicitly.`
            : "Inspect the node evidence, correct the cause, then resume with agr run.",
        });
      }
    }
    return { runId: state.runId, status: state.status, issues };
  }

  async recent(limit = 50): Promise<RunEvent[]> {
    return (await readRunEventArtifact(this.repositoryRoot, this.runId)).slice(-limit);
  }

  async *follow(after = 0, intervalMs = 1_000): AsyncGenerator<RunEvent | ObserverHeartbeat> {
    let cursor = after;
    let terminalEventObserved = false;
    while (true) {
      const snapshot = await this.read(cursor, 100);
      for (const event of snapshot.events) {
        yield event;
        cursor = event.seq;
        if (isTerminalEvent(event)) terminalEventObserved = true;
      }
      if (snapshot.events.length === 100) continue;
      if (snapshot.terminal) {
        const owner = await inspectRunLock(this.repositoryRoot, this.runId);
        if (terminalEventObserved || !["live", "foreign", "initializing"].includes(owner.status)) return;
        await delay(intervalMs);
        continue;
      }
      if (snapshot.events.length === 0) {
        yield {
          at: new Date().toISOString(),
          type: "observer_heartbeat",
          cursor,
          status: snapshot.status,
          activeNodeIds: snapshot.activeNodes.map((node) => node.id),
        };
      }
      await delay(intervalMs);
    }
  }
}

export async function readRunStateArtifact(repositoryRoot: string, runId: string): Promise<RunState> {
  try {
    const root = runRoot(repositoryRoot, runId);
    const current = await readCurrentGeneration(root);
    return JSON.parse(
      current?.stateRaw ?? await readFile(join(root, "state.json"), "utf8"),
    ) as RunState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`run ${runId} has no state yet; start it with agr run`, 3, "RUN_NOT_FOUND");
    }
    throw error;
  }
}

export async function readRunEventArtifact(repositoryRoot: string, runId: string): Promise<RunEvent[]> {
  try {
    const root = runRoot(repositoryRoot, runId);
    const current = await readCurrentGeneration(root);
    return parseRunEventLog(
      current?.eventsRaw ?? await readFile(join(root, "events.jsonl"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`run ${runId} has no events yet; start it with agr run`, 3, "RUN_NOT_FOUND");
    }
    throw error;
  }
}

export function parseRunEventLog(raw: string): RunEvent[] {
  const records = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw invalidEventLog(index + 1, "invalid JSON");
    }
    if (!isRecord(value)) throw invalidEventLog(index + 1, "event must be an object");
    if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) {
      throw invalidEventLog(index + 1, "at must be a valid timestamp string");
    }
    if (typeof value.type !== "string" || !runEventTypes.has(value.type as RunEvent["type"])) {
      throw invalidEventLog(index + 1, "type must be a known run event");
    }
    for (const field of ["nodeId", "detail", "phase", "evidenceFile"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        throw invalidEventLog(index + 1, `${field} must be a string`);
      }
    }
    if (value.percent !== undefined && (typeof value.percent !== "number" || !Number.isFinite(value.percent))) {
      throw invalidEventLog(index + 1, "percent must be a finite number");
    }
    if (value.severity !== undefined && !["note", "concern", "blocker"].includes(String(value.severity))) {
      throw invalidEventLog(index + 1, "severity must be note, concern, or blocker");
    }
    return { value, line: index + 1 };
  });

  const cursorCount = records.filter(({ value }) => value.seq !== undefined).length;
  if (cursorCount !== 0 && cursorCount !== records.length) {
    const mixed = records.find(({ value }) => value.seq === undefined)!;
    throw invalidEventLog(mixed.line, "cannot mix legacy and cursor-bearing events");
  }
  if (cursorCount === 0) {
    return records.map(({ value }, index) => ({ ...value, seq: index + 1 } as unknown as RunEvent));
  }

  let previous = 0;
  return records.map(({ value, line }) => {
    if (!Number.isInteger(value.seq) || (value.seq as number) <= previous) {
      throw invalidEventLog(line, "seq must be a positive strictly increasing integer");
    }
    previous = value.seq as number;
    return value as unknown as RunEvent;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidEventLog(line: number, detail: string): CliError {
  return new CliError(
    `invalid run artifact events.jsonl line ${line}: ${detail}; preserve the file and inspect or restore that line before following the run`,
    3,
    "EVENT_LOG_INVALID",
  );
}

function runRoot(repositoryRoot: string, runId: string): string {
  return join(repositoryRoot, ".agent-graph", "runs", assertSafeRunId(runId));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isTerminalEvent(event: RunEvent): boolean {
  return ["run_completed", "run_failed", "run_needs_attention", "run_cancelled", "approval_required"].includes(event.type);
}
