import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { createInitialState, createRunMandate } from "./state.js";
import { graphHash } from "./graph-hash.js";
import { RunLifecycle } from "./lifecycle.js";
import {
  publishGeneration,
  readCurrentGeneration,
  recoverJournaledGeneration,
  sha256,
  type LoadedGeneration,
} from "./persistence.js";
import { parseRunEventLog } from "./observation.js";
import { assertSafeRunId } from "./run-id.js";
import { CoordinatorDatabase, markSqlitePostCutoverMutation, readSqliteRunProjection } from "./sqlite-coordinator.js";
import type { AttemptRecord, GraphDefinition, NodeRunState, RunEvent, RunState } from "./types.js";

const exec = promisify(execFile);

export class RunStore {
  readonly runDirectory: string;
  private currentGeneration: LoadedGeneration | undefined;
  readonly evidenceDirectory: string;
  readonly outputsDirectory: string;
  readonly promptsDirectory: string;
  private eventWriteQueue: Promise<void> = Promise.resolve();

  private constructor(
    readonly repositoryRoot: string,
    readonly graph: GraphDefinition,
    public state: RunState,
    private events: RunEvent[],
    private nextEventSeq: number,
    private sqliteDatabasePath?: string,
    private sqliteStorageRevision?: number,
  ) {
    this.runDirectory = join(repositoryRoot, ".agent-graph", "runs", graph.run.id);
    this.evidenceDirectory = join(this.runDirectory, "evidence");
    this.outputsDirectory = join(this.runDirectory, "outputs");
    this.promptsDirectory = join(this.runDirectory, "prompts");
  }

  get statePath(): string {
    return this.currentGeneration?.statePath ?? join(this.runDirectory, "state.json");
  }

  get eventsPath(): string {
    return this.currentGeneration?.eventsPath ?? join(this.runDirectory, "events.jsonl");
  }

  static async open(
    repositoryRoot: string,
    graph: GraphDefinition,
    baselineChangedFiles: string[],
  ): Promise<RunStore> {
    assertSafeRunId(graph.run.id);
    const canonicalRoot = await canonicalPath(repositoryRoot);
    const runDirectory = join(repositoryRoot, ".agent-graph", "runs", graph.run.id);
    await mkdir(join(runDirectory, "evidence"), { recursive: true });
    await mkdir(join(runDirectory, "outputs"), { recursive: true });
    await mkdir(join(runDirectory, "prompts"), { recursive: true });

    const sqliteProjection = await readSqliteRunProjection(repositoryRoot, graph.run.id);
    let currentGeneration: LoadedGeneration | undefined;
    let state: RunState;
    let events: RunEvent[];
    if (sqliteProjection) {
      state = parseVersionedState(sqliteProjection.stateRaw, graph);
      events = parseRunEventLog(sqliteProjection.eventsRaw);
      validateStateEventCoherence(state, events);
    } else {
      try {
        currentGeneration = await readCurrentGeneration(runDirectory);
      } catch (error) {
        currentGeneration = await recoverJournaledGeneration(runDirectory).catch(() => {
          throw new Error(`current run generation is invalid and cannot be recovered: ${messageOf(error)}`);
        });
      }
      currentGeneration ??= await recoverJournaledGeneration(runDirectory);
      if (currentGeneration) {
        state = parseVersionedState(currentGeneration.stateRaw, graph);
        events = parseRunEventLog(currentGeneration.eventsRaw);
        validateStateEventCoherence(state, events);
      } else try {
        const legacyStateRaw = await readFile(join(runDirectory, "state.json"), "utf8");
        const legacyState = JSON.parse(legacyStateRaw) as Partial<RunState>;
        if (legacyState.schemaVersion !== undefined) {
          throw new Error(
            "versioned run projection has no authoritative CURRENT.json or recoverable journal",
          );
        }
        state = upgradeLegacyState(
          legacyState,
          graph,
          canonicalRoot,
          await repositoryBaseCommit(repositoryRoot),
        );
        const legacyEventsRaw = await readOptionalFile(join(runDirectory, "events.jsonl"));
        events = parseRunEventLog(legacyEventsRaw).map((event) => ({ ...event, schemaVersion: 2 }));
        state.lastAppliedEventSeq = events.at(-1)?.seq ?? 0;
        await preserveLegacyArtifacts(runDirectory, legacyStateRaw, legacyEventsRaw, state);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = createInitialState(graph, baselineChangedFiles, {
          repositoryId: canonicalRoot,
          root: canonicalRoot,
          baseCommit: await repositoryBaseCommit(repositoryRoot),
        });
        events = [];
      }
    }
    if (state.runId !== graph.run.id) throw new Error("stored run ID does not match graph");
    if (await canonicalPath(state.repository.root) !== canonicalRoot || await canonicalPath(state.repository.repositoryId) !== canonicalRoot) {
      throw new Error("stored run repository identity does not match the current repository root");
    }
    if (state.graphHash !== graphHash(graph)) throw new Error("stored graph does not match the current graph; use a new run.id or restore the original graph");
    await ensureBasePlanRevision(runDirectory, state);

    const store = new RunStore(
      repositoryRoot,
      graph,
      state,
      events,
      (events.at(-1)?.seq ?? 0) + 1,
      sqliteProjection?.databasePath,
      sqliteProjection?.storageRevision,
    );
    store.currentGeneration = currentGeneration;
    const recoveryEvents = new RunLifecycle(graph, store.state).recoverInterruptedNodes();
    for (const event of recoveryEvents) {
      await store.appendEvent({
        at: new Date().toISOString(),
        ...event,
      });
    }
    if (recoveryEvents.length > 0 || (!store.currentGeneration && !sqliteProjection)) await store.save("open");
    return store;
  }

  async save(reason: string): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    this.state.revision += 1;
    const event: RunEvent = {
      schemaVersion: 2,
      seq: this.nextEventSeq,
      at: this.state.updatedAt,
      type: "state_saved",
      detail: reason,
    };
    this.nextEventSeq += 1;
    this.events.push(event);
    this.state.lastAppliedEventSeq = event.seq;
    await this.enqueuePersist();
  }

  async appendEvent(event: Omit<RunEvent, "seq">): Promise<RunEvent> {
    const persisted: RunEvent = { schemaVersion: 2, seq: this.nextEventSeq, ...event };
    this.nextEventSeq += 1;
    this.events.push(persisted);
    this.state.lastAppliedEventSeq = persisted.seq;
    const write = this.eventWriteQueue.then(() => this.persist());
    this.eventWriteQueue = write.catch(() => undefined);
    await write;
    return persisted;
  }

  private async enqueuePersist(): Promise<void> {
    const write = this.eventWriteQueue.then(() => this.persist());
    this.eventWriteQueue = write.catch(() => undefined);
    await write;
  }

  private async persist(): Promise<void> {
    if (this.sqliteDatabasePath !== undefined && this.sqliteStorageRevision !== undefined) {
      const stateRaw = `${JSON.stringify(this.state, null, 2)}\n`;
      const eventsRaw = this.events.map((event) => JSON.stringify(event)).join("\n") + (this.events.length > 0 ? "\n" : "");
      const database = new CoordinatorDatabase(this.sqliteDatabasePath);
      try {
        this.sqliteStorageRevision = database.saveRunProjection(this.state.runId, this.sqliteStorageRevision, stateRaw, eventsRaw);
      } finally { database.close(); }
      await markSqlitePostCutoverMutation(this.repositoryRoot, this.state.runId);
      await writeFile(join(this.runDirectory, "state.json"), stateRaw, "utf8");
      await writeFile(join(this.runDirectory, "events.jsonl"), eventsRaw, "utf8");
      return;
    }
    this.currentGeneration = await publishGeneration(
      this.runDirectory,
      this.state,
      this.events,
      this.currentGeneration?.pointer.generation,
    );
  }
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function preserveLegacyArtifacts(
  runDirectory: string,
  stateRaw: string,
  eventsRaw: string,
  state: RunState,
): Promise<void> {
  const backupDirectory = join(runDirectory, "backups", "legacy");
  await mkdir(backupDirectory, { recursive: true });
  await writeImmutable(join(backupDirectory, "state.json"), stateRaw);
  await writeImmutable(join(backupDirectory, "events.jsonl"), eventsRaw);
  await writeImmutable(
    join(backupDirectory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      stateSha256: sha256(stateRaw),
      eventsSha256: sha256(eventsRaw),
      migratedRunId: state.runId,
    }, null, 2)}\n`,
  );
}

async function ensureBasePlanRevision(runDirectory: string, state: RunState): Promise<void> {
  const directory = join(runDirectory, "plan-revisions");
  await mkdir(directory, { recursive: true });
  await writeImmutable(
    join(directory, `${state.activePlanRevisionId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      revisionId: state.activePlanRevisionId,
      runId: state.runId,
      graphHash: state.graphHash,
      createdAt: state.createdAt,
    }, null, 2)}\n`,
  );
}

async function writeImmutable(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) {
      throw new Error(`immutable run artifact already exists with different content: ${path}`);
    }
  }
}

function parseVersionedState(raw: string, graph: GraphDefinition): RunState {
  const state = JSON.parse(raw) as Partial<RunState>;
  if (
    state.schemaVersion !== 2 ||
    !Number.isInteger(state.revision) ||
    !Number.isInteger(state.lastAppliedEventSeq) ||
    typeof state.activePlanRevisionId !== "string" ||
    !state.repository ||
    !state.nodes ||
    !state.attempts ||
    state.authority?.schemaVersion !== 1 ||
    state.authority.mandate?.schemaVersion !== 1 ||
    state.authority.mandate.issuedBy !== "human" ||
    !Array.isArray(state.authority.policyDecisions) ||
    !Array.isArray(state.authority.receipts) ||
    !Array.isArray(state.authority.reservations) ||
    !Array.isArray(state.authority.consumptions) ||
    !Array.isArray(state.authority.reconciliations)
  ) {
    throw new Error("invalid versioned run state");
  }
  return state as RunState;
}

function validateStateEventCoherence(state: RunState, events: RunEvent[]): void {
  const eventCursor = events.at(-1)?.seq ?? 0;
  if (state.lastAppliedEventSeq !== eventCursor) {
    throw new Error(
      `state cursor ${state.lastAppliedEventSeq} does not match authoritative event cursor ${eventCursor}`,
    );
  }
}

function upgradeLegacyState(
  legacy: Partial<RunState>,
  graph: GraphDefinition,
  repositoryRoot: string,
  baseCommit: string,
): RunState {
  if (legacy.runId !== graph.run.id) throw new Error("stored run ID does not match graph");
  if (legacy.graphHash !== graphHash(graph)) {
    throw new Error("stored graph does not match the current graph; use a new run.id or restore the original graph");
  }
  return normalizeAttemptLedger({
    ...(legacy as RunState),
    schemaVersion: 2,
    revision: 0,
    lastAppliedEventSeq: 0,
    activePlanRevisionId: `plan-${legacy.graphHash.slice(0, 24)}`,
    repository: { repositoryId: repositoryRoot, root: repositoryRoot, baseCommit },
  }, graph);
}

function normalizeAttemptLedger(state: RunState, graph: GraphDefinition): RunState {
  const attempts: Record<string, AttemptRecord> = state.attempts ?? {};
  const nodes = state.nodes ?? {};
  for (const [nodeId, original] of Object.entries(nodes)) {
    const node = original as NodeRunState;
    node.generation ??= 0;
    node.generationAttempts ??= node.attempts;
    if (node.currentAttemptId || node.attempts <= 0) continue;
    for (let ordinal = 1; ordinal <= node.attempts; ordinal += 1) {
      const attemptId = `legacy-${sha256(`${state.runId}\0${nodeId}\0${ordinal}`).slice(0, 24)}`;
      const isCurrent = ordinal === node.attempts;
      const status = isCurrent
        ? node.status === "accepted"
          ? "accepted"
          : node.status === "running"
            ? "running"
            : node.status === "failed"
              ? "failed"
              : "superseded"
        : "superseded";
      attempts[attemptId] = {
        schemaVersion: 1,
        attemptId,
        nodeId,
        planRevisionId: state.activePlanRevisionId,
        generation: node.generation,
        ordinal,
        status,
        startedAt: state.createdAt,
        ...(status === "running" ? {} : { finishedAt: state.updatedAt }),
        ...(isCurrent && node.lastError ? { error: node.lastError } : {}),
        evidence: [],
      };
      if (isCurrent) {
        node.currentAttemptId = attemptId;
        if (status === "accepted") node.acceptedAttemptId = attemptId;
      }
    }
  }
  state.attempts = attempts;
  state.authority ??= {
    schemaVersion: 1,
    mandate: createRunMandate(graph, state.graphHash, state.createdAt),
    policyDecisions: [],
    receipts: [],
    reservations: [],
    consumptions: [],
    reconciliations: [],
  };
  state.authority.mandate ??= createRunMandate(graph, state.graphHash, state.createdAt);
  state.authority.policyDecisions ??= [];
  state.authority.receipts ??= [];
  state.authority.reservations ??= [];
  state.authority.consumptions ??= [];
  state.authority.reconciliations ??= [];
  return state;
}

async function repositoryBaseCommit(repositoryRoot: string): Promise<string> {
  try {
    return (await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  } catch {
    return "unborn";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function canonicalPath(path: string): Promise<string> {
  const canonical = await realpath(resolve(path)).catch(() => resolve(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
