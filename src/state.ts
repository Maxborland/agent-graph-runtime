import type {
  GraphDefinition,
  GraphNodeDefinition,
  RunState,
} from "./types.js";
import { graphHash } from "./graph-hash.js";
import { RunLifecycle } from "./lifecycle.js";

export function createInitialState(
  graph: GraphDefinition,
  baselineChangedFiles: string[],
): RunState {
  const now = new Date().toISOString();
  const nodes = Object.fromEntries(
    graph.nodes.map((node) => [
      node.id,
      {
        status: "pending" as const,
        attempts: 0,
        generationAttempts: 0,
        attemptHighWater: 0,
        evidenceFiles: [],
      },
    ]),
  );
  return {
    runId: graph.run.id,
    graphHash: graphHash(graph),
    status: "running",
    createdAt: now,
    updatedAt: now,
    baselineChangedFiles: [...baselineChangedFiles],
    nodes,
  };
}

export function selectReadyNodes(
  graph: GraphDefinition,
  state: RunState,
): GraphNodeDefinition[] {
  return new RunLifecycle(graph, state).readyNodes();
}
