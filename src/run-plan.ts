import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PlanRegistry, type ActivePlan } from "./adaptive-plan.js";
import { graphHash } from "./graph-hash.js";
import { readCurrentGeneration } from "./persistence.js";
import { readSqliteRunProjection } from "./sqlite-coordinator.js";
import type { GraphDefinition, RunState } from "./types.js";
import type { RunStore } from "./store.js";

export async function resolveActivePlanGraph(repositoryRoot: string, baseGraph: GraphDefinition): Promise<GraphDefinition> {
  const runDirectory = join(repositoryRoot, ".agent-graph", "runs", baseGraph.run.id);
  const sqlite = await readSqliteRunProjection(repositoryRoot, baseGraph.run.id);
  const generation = sqlite ? undefined : await readCurrentGeneration(runDirectory).catch(() => undefined);
  if (!sqlite && !generation) return baseGraph;
  const state = JSON.parse(sqlite?.stateRaw ?? generation!.stateRaw) as RunState;
  if (state.activePlanRevisionId === `plan-${graphHash(baseGraph).slice(0, 24)}`) return baseGraph;
  const raw = await readFile(join(runDirectory, "plan-revisions", `${state.activePlanRevisionId}.v2.json`), "utf8");
  const revision = JSON.parse(raw) as ActivePlan;
  if (revision.revisionId !== state.activePlanRevisionId || revision.graphHash !== state.graphHash || graphHash(revision.graph) !== state.graphHash) {
    throw new Error("run state and active immutable plan revision do not agree");
  }
  const registry = await PlanRegistry.open(runDirectory, baseGraph, baseGraph.run.budgets);
  if ((await registry.active()).revisionId !== revision.revisionId) await registry.setActive(revision);
  return revision.graph;
}

export async function activatePatchInStore(
  baseGraph: GraphDefinition,
  store: RunStore,
  patchId: string,
  automatic: boolean,
): Promise<GraphDefinition> {
  if (store.state.status === "completed" || store.state.git?.resultId) throw new Error("completed immutable runs cannot activate another plan revision; start a new run ID");
  const currentGraph = await resolveActivePlanGraph(store.repositoryRoot, baseGraph);
  const mandate = store.state.authority.mandate;
  const registry = await PlanRegistry.open(store.runDirectory, baseGraph, {
    maxNodes: mandate.maxNodes,
    maxDepth: mandate.maxDepth,
    maxDurationMs: mandate.maxDurationMs,
    maxProviderCalls: mandate.maxProviderCalls ?? currentGraph.run.budgets?.maxProviderCalls ?? mandate.maxNodes,
    ...(mandate.maxCostUsd === undefined ? {} : { maxCostUsd: mandate.maxCostUsd }),
  });
  if ((await registry.active()).revisionId !== store.state.activePlanRevisionId) await registry.setActive(await registry.revision(store.state.activePlanRevisionId));
  const patch = (await registry.patches()).find((candidate) => candidate.patchId === patchId);
  if (!patch) throw new Error(`graph patch ${patchId} does not exist`);
  if (automatic) {
    if (!currentGraph.run.automaticPolicy?.allowReversiblePatches || !patch.reversible) throw new Error("graph patch is not pre-authorized for automatic activation");
    const priorExternal = new Map(currentGraph.nodes.filter((node) => node.type === "external_action").map((node) => [node.id, JSON.stringify(node)]));
    for (const node of patch.proposedGraph.nodes.filter((candidate) => candidate.type === "external_action")) {
      if (priorExternal.get(node.id) !== JSON.stringify(node)) throw new Error("automatic patch cannot add or change an external action");
    }
    const priorNodes = new Map(currentGraph.nodes.map((node) => [node.id, node]));
    for (const node of patch.proposedGraph.nodes) {
      const prior = priorNodes.get(node.id);
      if (!prior && (node.executor === "shell" || node.checks.length > 0)) {
        throw new Error(`automatic patch cannot add shell execution or trusted checks (${node.id})`);
      }
      if (prior && (JSON.stringify(prior.checks) !== JSON.stringify(node.checks) || prior.executor !== node.executor)) {
        throw new Error(`automatic patch cannot change an existing executor or trusted checks (${node.id})`);
      }
    }
  }
  for (const node of patch.proposedGraph.nodes) {
    if (!mandate.allowedActions.includes(node.type)) throw new Error(`patch action type ${node.type} exceeds human mandate`);
    if (node.target && !mandate.allowedTargets.includes(node.target)) throw new Error(`patch target ${node.target} exceeds human mandate`);
  }
  const activeAttemptIds = Object.values(store.state.nodes).flatMap((node) => node.status === "running" && node.currentAttemptId ? [node.currentAttemptId] : []);
  const revision = await registry.prepareActivation(patchId, { activeAttemptIds });
  const nextIds = new Set(revision.graph.nodes.map((node) => node.id));
  for (const [nodeId, nodeState] of Object.entries(store.state.nodes)) {
    if (!nextIds.has(nodeId) && (nodeState.attempts > 0 || nodeState.status === "accepted")) throw new Error(`patch cannot remove attempted node ${nodeId}`);
    if (!nextIds.has(nodeId)) delete store.state.nodes[nodeId];
  }
  for (const node of revision.graph.nodes) store.state.nodes[node.id] ??= { status: "pending", attempts: 0, generation: 0, generationAttempts: 0, evidenceFiles: [] };
  store.state.activePlanRevisionId = revision.revisionId;
  store.state.graphHash = revision.graphHash;
  store.state.authority.mandate = {
    ...mandate,
    mandateId: `${mandate.mandateId}:${revision.revisionId}`,
    planRevisionId: revision.revisionId,
    policyHash: revision.graphHash,
  };
  store.state.authority.policyDecisions.push({
    schemaVersion: 1,
    decisionId: randomUUID(),
    mandateId: store.state.authority.mandate.mandateId,
    actionNodeId: `patch:${patchId}`,
    outcome: "allow",
    reason: automatic ? "reversible patch is within the human-issued mandate" : "human activated a validated patch",
    policyHash: revision.graphHash,
    decidedAt: new Date().toISOString(),
  });
  await store.save(automatic ? "automatic-plan-activation" : "human-plan-activation");
  await registry.setActive(revision);
  return revision.graph;
}

export async function activateNextAutomaticPatch(baseGraph: GraphDefinition, store: RunStore): Promise<GraphDefinition | undefined> {
  if (store.state.git?.resultId || Object.values(store.state.nodes).every((node) => node.status === "accepted")) return undefined;
  const currentGraph = await resolveActivePlanGraph(store.repositoryRoot, baseGraph);
  if (!currentGraph.run.automaticPolicy?.allowReversiblePatches) return undefined;
  const registry = await PlanRegistry.open(store.runDirectory, baseGraph, {
    maxNodes: store.state.authority.mandate.maxNodes,
    maxDepth: store.state.authority.mandate.maxDepth,
    maxDurationMs: store.state.authority.mandate.maxDurationMs,
    maxProviderCalls: store.state.authority.mandate.maxProviderCalls ?? currentGraph.run.budgets?.maxProviderCalls ?? store.state.authority.mandate.maxNodes,
    ...(store.state.authority.mandate.maxCostUsd === undefined ? {} : { maxCostUsd: store.state.authority.mandate.maxCostUsd }),
  });
  const patch = (await registry.patches()).find((candidate) => candidate.parentRevisionId === store.state.activePlanRevisionId && candidate.reversible);
  return patch ? activatePatchInStore(baseGraph, store, patch.patchId, true) : undefined;
}
