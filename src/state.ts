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
  return {
    runId: graph.run.id,
    graphHash: graphHash(graph),
    status: "running",
    createdAt: now,
    updatedAt: now,
    baselineChangedFiles: [...baselineChangedFiles],
    nodes: Object.fromEntries(
      graph.nodes.map((node) => [
        node.id,
        { status: "pending", attempts: 0, evidenceFiles: [] },
      ]),
    ),
  };
}

export function selectReadyNodes(
  graph: GraphDefinition,
  state: RunState,
): GraphNodeDefinition[] {
  return new RunLifecycle(graph, state).readyNodes();
}
