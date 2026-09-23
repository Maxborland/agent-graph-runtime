import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createInitialState } from "./state.js";
import { graphHash } from "./graph-hash.js";
import { RunLifecycle } from "./lifecycle.js";
import { assertSafeArtifactId, runArtifactDirectory } from "./artifact-path.js";
import { parseRunEventLog } from "./observation.js";
import type { GraphDefinition, RunEvent, RunState } from "./types.js";

export class RunStore {
  readonly runDirectory: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly evidenceDirectory: string;
  readonly outputsDirectory: string;
  readonly promptsDirectory: string;
  private eventWriteQueue: Promise<void> = Promise.resolve();

  private constructor(
    readonly repositoryRoot: string,
    readonly graph: GraphDefinition,
    public state: RunState,
    private nextEventSeq: number,
    private readonly eventLogUsesSequences: boolean,
    private eventLogNeedsSeparator: boolean,
  ) {
    this.runDirectory = runArtifactDirectory(repositoryRoot, graph.run.id);
    this.statePath = join(this.runDirectory, "state.json");
    this.eventsPath = join(this.runDirectory, "events.jsonl");
    this.evidenceDirectory = join(this.runDirectory, "evidence");
    this.outputsDirectory = join(this.runDirectory, "outputs");
    this.promptsDirectory = join(this.runDirectory, "prompts");
  }

  static async open(
    repositoryRoot: string,
    graph: GraphDefinition,
    baselineChangedFiles: string[],
  ): Promise<RunStore> {
    const runDirectory = runArtifactDirectory(repositoryRoot, graph.run.id);
    for (const node of graph.nodes) assertSafeArtifactId(node.id, "node ID");
    await mkdir(join(runDirectory, "evidence"), { recursive: true });
    await mkdir(join(runDirectory, "outputs"), { recursive: true });
    await mkdir(join(runDirectory, "prompts"), { recursive: true });

    let state: RunState;
    let stateWasCreated = false;
    let stateNeedsNormalization = false;
    try {
      state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as RunState;
      if (state.runId !== graph.run.id) throw new Error("stored run ID does not match graph");
      if (state.graphHash !== graphHash(graph)) {
        throw new Error(
          "stored graph does not match the current graph; use a new run.id or restore the original graph",
        );
      }
      stateNeedsNormalization = normalizeAttemptHistory(state, graph);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = createInitialState(graph, baselineChangedFiles);
      stateWasCreated = true;
    }

    if (await applyAttemptHighWater(state, graph, runDirectory)) stateNeedsNormalization = true;

    const eventLogCursor = await readEventLogCursor(join(runDirectory, "events.jsonl"));
    const store = new RunStore(
      repositoryRoot,
      graph,
      state,
      eventLogCursor.nextSequence,
      eventLogCursor.usesSequences,
      eventLogCursor.needsSeparator,
    );
    const recoveryEvents = new RunLifecycle(graph, store.state).recoverInterruptedNodes();
    for (const event of recoveryEvents) {
      await store.appendEvent({
        at: new Date().toISOString(),
        ...event,
      });
    }
    if (recoveryEvents.length > 0 || stateWasCreated || stateNeedsNormalization || !(await fileExists(store.statePath))) {
      await store.save(stateNeedsNormalization ? "retry-history-normalized" : "open");
    }
    return store;
  }

  async save(reason: string): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.statePath);
    await this.appendEvent({ at: this.state.updatedAt, type: "state_saved", detail: reason });
  }

  async appendEvent(event: Omit<RunEvent, "seq">): Promise<RunEvent> {
    const persisted = { seq: this.nextEventSeq, ...event };
    this.nextEventSeq += 1;
    const record = this.eventLogUsesSequences ? persisted : event;
    const write = this.eventWriteQueue.then(async () => {
      const separator = this.eventLogNeedsSeparator ? "\n" : "";
      await appendFile(this.eventsPath, `${separator}${JSON.stringify(record)}\n`, "utf8");
      this.eventLogNeedsSeparator = false;
    });
    this.eventWriteQueue = write.catch(() => undefined);
    await write;
    return persisted;
  }
}

/**
 * Persist an artifact once. Retrying the same write with identical bytes is
 * idempotent; a different payload for an existing path fails closed instead
 * of erasing historical evidence.
 */
export async function writeImmutableArtifact(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) {
      throw new Error(`immutable run artifact already exists with different content: ${path}`);
    }
  }
}

async function readEventLogCursor(path: string): Promise<{
  nextSequence: number;
  usesSequences: boolean;
  needsSeparator: boolean;
}> {
  try {
    const raw = await readFile(path, "utf8");
    const events = parseRunEventLog(raw);
    const needsSeparator = raw.length > 0 && !raw.endsWith("\n");
    if (events.length === 0) return { nextSequence: 1, usesSequences: true, needsSeparator };
    const firstRecord = JSON.parse(raw.split(/\r?\n/).find((line) => line.trim())!) as Record<string, unknown>;
    const usesSequences = Object.hasOwn(firstRecord, "seq");
    const nextSequence = usesSequences ? events.at(-1)!.seq + 1 : events.length + 1;
    return { nextSequence, usesSequences, needsSeparator };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { nextSequence: 1, usesSequences: true, needsSeparator: false };
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function normalizeAttemptHistory(state: RunState, graph: GraphDefinition): boolean {
  let changed = false;
  for (const definition of graph.nodes) {
    const node = state.nodes[definition.id];
    if (!node) continue;
    validateCounter(node.attempts, "attempts", definition.id);
    if (node.generationAttempts === undefined) {
      // Legacy `attempts` was the only retry budget available, so preserve it
      // as the initial budget while the lifetime ordinal becomes independent.
      node.generationAttempts = node.attempts;
      changed = true;
    }
    if (node.attemptHighWater === undefined) {
      node.attemptHighWater = node.attempts;
      changed = true;
    }
    validateCounter(node.generationAttempts, "generationAttempts", definition.id);
    validateCounter(node.attemptHighWater, "attemptHighWater", definition.id);
    if (node.acceptedAttempt !== undefined) {
      validateCounter(node.acceptedAttempt, "acceptedAttempt", definition.id);
      if (node.acceptedAttempt > node.attempts) {
        throw new Error(`acceptedAttempt exceeds attempts for node "${definition.id}"`);
      }
    } else if (node.status === "accepted" && node.attempts > 0) {
      // Preserve the accepted ordinal when upgrading an old snapshot. This
      // pointer is intentionally independent from a later filesystem
      // high-water bump caused by an orphaned failed attempt.
      node.acceptedAttempt = node.attempts;
      changed = true;
    }
  }
  return changed;
}

async function applyAttemptHighWater(
  state: RunState,
  graph: GraphDefinition,
  runDirectory: string,
): Promise<boolean> {
  const highWater = await readAttemptHighWater(runDirectory, graph);
  let changed = false;
  for (const definition of graph.nodes) {
    const node = state.nodes[definition.id];
    if (!node) continue;
    const highWaterForNode = highWater.get(definition.id) ?? 0;
    const floor = Math.max(highWaterForNode, node.attemptHighWater ?? 0, node.attempts);
    if (node.attemptHighWater !== floor) {
      node.attemptHighWater = floor;
      changed = true;
    }
    // Existing callers use `attempts` to form artifact paths. Keep that
    // lifetime ordinal above every observed legacy path, but do not change
    // `generationAttempts` or `acceptedAttempt` when only an orphan is seen.
    if (node.attempts < floor) {
      node.attempts = floor;
      changed = true;
    }
  }
  return changed;
}

async function readAttemptHighWater(
  runDirectory: string,
  graph: GraphDefinition,
): Promise<Map<string, number>> {
  const result = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]));
  for (const directory of ["evidence", "prompts", "outputs"]) {
    let entries;
    try {
      entries = await readdir(join(runDirectory, directory), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      for (const node of graph.nodes) {
        const prefix = `${node.id}-attempt-`;
        if (!entry.name.startsWith(prefix)) continue;
        const suffix = entry.name.slice(prefix.length).replace(/\.[^.]+$/, "");
        if (!/^\d+$/.test(suffix)) continue;
        const ordinal = Number(suffix);
        if (Number.isSafeInteger(ordinal)) result.set(node.id, Math.max(result.get(node.id) ?? 0, ordinal));
      }
    }
  }

  try {
    const events = await readFile(join(runDirectory, "events.jsonl"), "utf8");
    for (const line of events.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event) || event.type !== "node_started" || typeof event.nodeId !== "string" ||
          typeof event.detail !== "string") continue;
      const match = /\battempt\s+(\d+)\b/i.exec(event.detail);
      if (!match) continue;
      const ordinal = Number(match[1]);
      if (Number.isSafeInteger(ordinal) && result.has(event.nodeId)) {
        result.set(event.nodeId, Math.max(result.get(event.nodeId) ?? 0, ordinal));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

function validateCounter(value: unknown, field: string, nodeId: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${field} for node "${nodeId}"`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
