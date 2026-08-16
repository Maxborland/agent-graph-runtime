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
  repository: RunState["repository"] = {
    repositoryId: graph.run.repository,
    root: graph.run.repository,
    baseCommit: "unknown",
  },
): RunState {
  const now = new Date().toISOString();
  const hash = graphHash(graph);
  return {
    schemaVersion: 2,
    revision: 0,
    lastAppliedEventSeq: 0,
    runId: graph.run.id,
    graphHash: hash,
    activePlanRevisionId: `plan-${hash.slice(0, 24)}`,
    repository,
    status: "running",
    createdAt: now,
    updatedAt: now,
    baselineChangedFiles: [...baselineChangedFiles],
    attempts: {},
    authority: {
      schemaVersion: 1,
      mandate: createRunMandate(graph, hash, now),
      policyDecisions: [],
      receipts: [],
      reservations: [],
      consumptions: [],
      reconciliations: [],
    },
    nodes: Object.fromEntries(
      graph.nodes.map((node) => [
        node.id,
        { status: "pending", attempts: 0, generation: 0, generationAttempts: 0, evidenceFiles: [] },
      ]),
    ),
  };
}

export function createRunMandate(graph: GraphDefinition, hash: string, issuedAt: string) {
  const allowedActions = [...new Set(graph.nodes.map((node) => node.type))];
  const allowedTargets = [...new Set(graph.nodes.flatMap((node) => node.target ? [node.target] : []))];
  return {
    schemaVersion: 1 as const,
    mandateId: `mandate-${hash.slice(0, 24)}`,
    issuedBy: "human" as const,
    planRevisionId: `plan-${hash.slice(0, 24)}`,
    allowedActions,
    allowedTargets,
    maxNodes: graph.nodes.length,
    maxDepth: graphDepth(graph),
    maxDurationMs: graph.nodes.reduce((total, node) => total + (node.timeoutMs ?? 20 * 60_000), 0),
    policyHash: hash,
    issuedAt,
  };
}

function graphDepth(graph: GraphDefinition): number {
  const depths = new Map<string, number>();
  const visit = (nodeId: string): number => {
    const cached = depths.get(nodeId);
    if (cached !== undefined) return cached;
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    const depth = node ? 1 + Math.max(0, ...node.needs.map(visit)) : 0;
    depths.set(nodeId, depth);
    return depth;
  };
  return Math.max(0, ...graph.nodes.map((node) => visit(node.id)));
}

export function selectReadyNodes(
  graph: GraphDefinition,
  state: RunState,
): GraphNodeDefinition[] {
  return new RunLifecycle(graph, state).readyNodes();
}
