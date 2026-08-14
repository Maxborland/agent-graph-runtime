import { gitChangedFiles } from "./repository.js";
import { RunStore } from "./store.js";
import type { GraphDefinition, RunState } from "./types.js";

export async function retryNode(
  graph: GraphDefinition,
  repositoryRoot: string,
  nodeId: string,
): Promise<RunState> {
  if (!graph.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`node "${nodeId}" does not exist`);
  }
  const store = await RunStore.open(repositoryRoot, graph, await gitChangedFiles(repositoryRoot));
  const invalidated = collectDescendants(graph, nodeId);
  invalidated.add(nodeId);
  for (const id of invalidated) {
    const nodeState = store.state.nodes[id]!;
    nodeState.status = "pending";
    nodeState.attempts = 0;
    nodeState.evidenceFiles = [];
    delete nodeState.approvedTarget;
    delete nodeState.lastError;
    await store.appendEvent({
      at: new Date().toISOString(),
      type: "node_invalidated",
      nodeId: id,
      detail: `manual retry from ${nodeId}`,
    });
  }
  store.state.status = "running";
  await store.save("manual-retry");
  return store.state;
}

function collectDescendants(graph: GraphDefinition, nodeId: string): Set<string> {
  const result = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const node of graph.nodes) {
      if (!node.needs.includes(current) || result.has(node.id)) continue;
      result.add(node.id);
      queue.push(node.id);
    }
  }
  return result;
}

