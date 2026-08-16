import type { GraphDefinition, GraphNodeDefinition } from "./types.js";

export interface PlannedNode {
  id: string;
  type: GraphNodeDefinition["type"];
  executor?: GraphNodeDefinition["executor"];
  needs: string[];
  owns: string[];
  implicitOutputs: string[];
  checks: string[];
  target?: string;
  maxAttempts: number;
  timeoutMs?: number;
  model?: string;
  requiredModelUsage?: GraphNodeDefinition["requiredModelUsage"];
  gate: boolean;
}

export interface ExecutionPlan {
  runId: string;
  objective: string;
  repositoryRoot: string;
  maxConcurrency: number;
  allowExternalActions: boolean;
  advisor?: GraphDefinition["run"]["advisor"];
  waves: Array<{ index: number; nodes: PlannedNode[] }>;
}

export function buildExecutionPlan(
  graph: GraphDefinition,
  repositoryRoot = graph.run.repository,
): ExecutionPlan {
  const remaining = new Map(graph.nodes.map((node) => [node.id, node]));
  const planned = new Set<string>();
  const waves: ExecutionPlan["waves"] = [];

  while (remaining.size > 0) {
    const allReady = graph.nodes.filter(
      (node) => remaining.has(node.id) && node.needs.every((dependency) => planned.has(dependency)),
    );
    const gate = allReady.find((node) => node.type === "human_gate");
    const ready = gate
      ? [gate]
      : allReady.filter((node) => node.type !== "human_gate").slice(0, graph.run.maxConcurrency);
    if (ready.length === 0) break;

    waves.push({
      index: waves.length + 1,
      nodes: ready.map((node) => ({
        id: node.id,
        type: node.type,
        ...(node.executor === undefined ? {} : { executor: node.executor }),
        needs: node.needs,
        owns: node.owns,
        implicitOutputs: node.implicitOutputs ?? [],
        checks: node.checks,
        ...(node.target === undefined ? {} : { target: node.target }),
        maxAttempts: node.maxAttempts,
        ...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
        ...(node.model === undefined ? {} : { model: node.model }),
        ...(node.requiredModelUsage === undefined ? {} : { requiredModelUsage: node.requiredModelUsage }),
        gate: node.type === "human_gate",
      })),
    });
    for (const node of ready) {
      planned.add(node.id);
      remaining.delete(node.id);
    }
  }

  return {
    runId: graph.run.id,
    objective: graph.run.objective,
    repositoryRoot,
    maxConcurrency: graph.run.maxConcurrency,
    allowExternalActions: graph.run.allowExternalActions ?? false,
    ...(graph.run.advisor === undefined ? {} : { advisor: graph.run.advisor }),
    waves,
  };
}
