import { gitChangedFiles } from "./repository.js";
import { RunStore } from "./store.js";
import type { GraphDefinition, RunState } from "./types.js";

export async function approveGate(
  graph: GraphDefinition,
  repositoryRoot: string,
  nodeId: string,
  target: string,
): Promise<RunState> {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`node "${nodeId}" does not exist`);
  if (node.type !== "human_gate") throw new Error(`node "${nodeId}" is not a human gate`);
  if (!node.target) throw new Error(`human gate "${nodeId}" has no exact target`);
  if (node.target !== target) {
    throw new Error(`approval target "${target}" does not match required target "${node.target}"`);
  }
  const store = await RunStore.open(repositoryRoot, graph, await gitChangedFiles(repositoryRoot));
  const nodeState = store.state.nodes[nodeId]!;
  if (!node.needs.every((dependency) => store.state.nodes[dependency]?.status === "accepted")) {
    throw new Error(`human gate "${nodeId}" is not dependency-ready`);
  }
  nodeState.approvedTarget = target;
  nodeState.status = "pending";
  store.state.status = "running";
  await store.appendEvent({
    at: new Date().toISOString(),
    type: "approval_recorded",
    nodeId,
    detail: target,
  });
  await store.save("approval-recorded");
  return store.state;
}

