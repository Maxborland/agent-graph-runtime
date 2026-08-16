import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createInitialState } from "./state.js";
import { graphHash } from "./graph-hash.js";
import { RunLifecycle } from "./lifecycle.js";
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
  ) {
    this.runDirectory = join(repositoryRoot, ".agent-graph", "runs", graph.run.id);
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
    const runDirectory = join(repositoryRoot, ".agent-graph", "runs", graph.run.id);
    await mkdir(join(runDirectory, "evidence"), { recursive: true });
    await mkdir(join(runDirectory, "outputs"), { recursive: true });
    await mkdir(join(runDirectory, "prompts"), { recursive: true });

    let state: RunState;
    try {
      state = JSON.parse(await readFile(join(runDirectory, "state.json"), "utf8")) as RunState;
      if (state.runId !== graph.run.id) throw new Error("stored run ID does not match graph");
      if (state.graphHash !== graphHash(graph)) {
        throw new Error(
          "stored graph does not match the current graph; use a new run.id or restore the original graph",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = createInitialState(graph, baselineChangedFiles);
    }

    const store = new RunStore(
      repositoryRoot,
      graph,
      state,
      await readNextEventSequence(join(runDirectory, "events.jsonl")),
    );
    const recoveryEvents = new RunLifecycle(graph, store.state).recoverInterruptedNodes();
    for (const event of recoveryEvents) {
      await store.appendEvent({
        at: new Date().toISOString(),
        ...event,
      });
    }
    if (recoveryEvents.length > 0 || !(await fileExists(store.statePath))) await store.save("open");
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
    const write = this.eventWriteQueue.then(() => appendFile(
      this.eventsPath,
      `${JSON.stringify(persisted)}\n`,
      "utf8",
    ));
    this.eventWriteQueue = write.catch(() => undefined);
    await write;
    return persisted;
  }
}

async function readNextEventSequence(path: string): Promise<number> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).length + 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
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
