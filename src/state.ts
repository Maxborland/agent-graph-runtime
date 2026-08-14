import type {
  GraphDefinition,
  GraphNodeDefinition,
  RunState,
} from "./types.js";
import { graphHash } from "./graph-hash.js";

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
  const running = Object.values(state.nodes).filter((node) => node.status === "running").length;
  const capacity = Math.max(0, graph.run.maxConcurrency - running);
  return graph.nodes
    .filter((node) => {
      const nodeState = state.nodes[node.id];
      if (!nodeState) return false;
      if (!["pending", "failed"].includes(nodeState.status)) return false;
      if (nodeState.attempts >= node.maxAttempts) return false;
      return node.needs.every((dependency) => state.nodes[dependency]?.status === "accepted");
    })
    .slice(0, capacity);
}
