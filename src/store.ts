import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createInitialState } from "./state.js";
import { graphHash } from "./graph-hash.js";
import type { GraphDefinition, RunState } from "./types.js";

interface RunEvent {
  at: string;
  type: string;
  nodeId?: string;
  detail?: string;
}

export class RunStore {
  readonly runDirectory: string;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly evidenceDirectory: string;
  readonly outputsDirectory: string;
  readonly promptsDirectory: string;

  private constructor(
    readonly repositoryRoot: string,
    readonly graph: GraphDefinition,
    public state: RunState,
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

    const store = new RunStore(repositoryRoot, graph, state);
    let changed = false;
    for (const [nodeId, node] of Object.entries(store.state.nodes)) {
      if (node.status !== "running") continue;
      node.status = "pending";
      changed = true;
      await store.appendEvent({
        at: new Date().toISOString(),
        type: "node_interrupted",
        nodeId,
        detail: "Recovered a node left running by a previous process",
      });
    }
    if (changed || !(await fileExists(store.statePath))) await store.save("open");
    return store;
  }

  async save(reason: string): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.statePath);
    await this.appendEvent({ at: this.state.updatedAt, type: "state_saved", detail: reason });
  }

  async appendEvent(event: RunEvent): Promise<void> {
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
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
