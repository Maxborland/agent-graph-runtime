import type {
  GraphDefinition,
  GraphNodeDefinition,
  GraphValidationResult,
} from "./types.js";
import { executorNames } from "./types.js";

const nodeTypes = new Set([
  "agent",
  "verify",
  "review",
  "human_gate",
  "external_action",
]);
const executors = new Set<string>(executorNames);
const agentDispatchNodeTypes = new Set(["agent", "review", "external_action"]);
const graphProperties = new Set(["version", "run", "nodes"]);
const runProperties = new Set(["id", "objective", "repository", "maxConcurrency", "allowExternalActions", "codeGraph", "advisor"]);
const advisorProperties = new Set(["executor", "model", "instructions", "stopOnBlocker"]);
const nodeProperties = new Set([
  "id", "type", "executor", "prompt", "target", "needs", "owns",
  "implicitOutputs", "checks", "maxAttempts", "timeoutMs", "model",
  "requiredModelUsage", "context",
]);
const modelUsageProperties = new Set(["model", "provider", "contextWindow"]);
const contextProperties = new Set(["symbols", "impact", "affectedFiles"]);

export function validateGraph(graph: GraphDefinition): GraphValidationResult {
  const errors: string[] = [];
  if (!isRecord(graph)) return { errors: ["graph must be an object"], topologicalOrder: [] };
  errors.push(...unknownPropertyErrors(graph, graphProperties, "graph"));
  if (!isRecord(graph.run)) {
    errors.push("run must be an object");
    return { errors, topologicalOrder: [] };
  }
  errors.push(...unknownPropertyErrors(graph.run, runProperties, "run"));
  if (!Array.isArray(graph.nodes)) {
    errors.push("nodes must be an array");
    return { errors, topologicalOrder: [] };
  }
  if (graph.version !== 1) errors.push("version must be 1");
  if (typeof graph.run.id !== "string" || !graph.run.id.trim()) errors.push("run.id is required");
  if (typeof graph.run.objective !== "string" || !graph.run.objective.trim()) errors.push("run.objective is required");
  if (typeof graph.run.repository !== "string" || !graph.run.repository.trim()) errors.push("run.repository is required");
  if (!Number.isInteger(graph.run?.maxConcurrency) || graph.run.maxConcurrency < 1) {
    errors.push("run.maxConcurrency must be a positive integer");
  }
  if (graph.run.allowExternalActions !== undefined && typeof graph.run.allowExternalActions !== "boolean") {
    errors.push("run.allowExternalActions must be a boolean");
  }
  if (graph.run.codeGraph !== undefined && typeof graph.run.codeGraph !== "boolean") {
    errors.push("run.codeGraph must be a boolean");
  }
  if (graph.run.advisor !== undefined) {
    if (!isRecord(graph.run.advisor)) {
      errors.push("run.advisor must be an object");
    } else {
      errors.push(...unknownPropertyErrors(graph.run.advisor, advisorProperties, "run.advisor"));
      if (
        typeof graph.run.advisor.executor !== "string" ||
        !["codex", "claude", "claudex"].includes(graph.run.advisor.executor)
      ) {
        errors.push("run.advisor requires a Codex, Claude, or Claudex executor");
      }
      if (
        graph.run.advisor.model !== undefined &&
        (typeof graph.run.advisor.model !== "string" || !graph.run.advisor.model.trim())
      ) {
        errors.push("run.advisor.model must be a non-empty string");
      }
      if (graph.run.advisor.instructions !== undefined && typeof graph.run.advisor.instructions !== "string") {
        errors.push("run.advisor.instructions must be a string");
      } else if ((graph.run.advisor.instructions?.length ?? 0) > 4_000) {
        errors.push("run.advisor.instructions must be at most 4000 characters");
      }
      if (graph.run.advisor.stopOnBlocker !== undefined && typeof graph.run.advisor.stopOnBlocker !== "boolean") {
        errors.push("run.advisor.stopOnBlocker must be a boolean");
      }
      if (graph.run.advisor.executor === "claudex" && graph.run.advisor.model) {
        errors.push("Claudex advisor cannot override the launcher model");
      }
    }
  }

  const byId = new Map<string, GraphNodeDefinition>();
  let dependencyShapeValid = true;
  for (const [index, node] of graph.nodes.entries()) {
    if (!isRecord(node)) {
      errors.push(`node at index ${index} must be an object`);
      continue;
    }
    errors.push(...unknownPropertyErrors(node, nodeProperties, `node "${String(node.id ?? index)}"`));
    if (typeof node.id !== "string" || !node.id.trim()) {
      errors.push("every node requires an id");
      dependencyShapeValid = false;
      continue;
    }
    if (byId.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    byId.set(node.id, node);
    if (!nodeTypes.has(node.type)) errors.push(`node "${node.id}" has invalid type`);
    if (node.executor !== undefined && (typeof node.executor !== "string" || !executors.has(node.executor))) {
      errors.push(`node "${node.id}" has invalid executor`);
    }
    if (node.prompt !== undefined && typeof node.prompt !== "string") {
      errors.push(`node "${node.id}" prompt must be a string`);
    }
    if (node.target !== undefined && typeof node.target !== "string") {
      errors.push(`node "${node.id}" target must be a string`);
    }
    if (["agent", "review"].includes(node.type) && !node.executor) {
      errors.push(`node "${node.id}" requires an executor`);
    }
    if (["agent", "review"].includes(node.type) && (typeof node.prompt !== "string" || !node.prompt.trim())) {
      errors.push(`node "${node.id}" requires a prompt`);
    }
    if (node.executor === "claudex" && node.model) {
      errors.push(`Claudex node "${node.id}" cannot override the launcher model`);
    }
    if (node.requiredModelUsage !== undefined) {
      if (node.executor !== "claudex") {
        errors.push(`node "${node.id}" requiredModelUsage is supported only for Claudex`);
      }
      if (!agentDispatchNodeTypes.has(node.type)) {
        errors.push(`node "${node.id}" requiredModelUsage requires a dispatched Claudex node`);
      }
      if (!Array.isArray(node.requiredModelUsage) || node.requiredModelUsage.length === 0) {
        errors.push(`node "${node.id}" requiredModelUsage must be a non-empty array`);
      } else {
        for (const required of node.requiredModelUsage) {
          if (
            !required ||
            typeof required.model !== "string" ||
            !required.model.trim() ||
            typeof required.provider !== "string" ||
            !required.provider.trim() ||
            !Number.isInteger(required.contextWindow) ||
            required.contextWindow < 1
          ) {
            errors.push(
              `node "${node.id}" requiredModelUsage requires a model, provider, and positive contextWindow`,
            );
          }
        }
      }
    }
    if (
      node.type === "review" &&
      ((node.owns?.length ?? 0) > 0 || (node.implicitOutputs?.length ?? 0) > 0)
    ) {
      errors.push(`review node "${node.id}" must not declare writable ownership`);
    }
    if (["human_gate", "external_action"].includes(node.type) && (typeof node.target !== "string" || !node.target.trim())) {
      errors.push(`${node.type} node "${node.id}" requires a target`);
    }
    if (node.type === "external_action" && !node.executor) {
      errors.push(`external_action node "${node.id}" requires an executor`);
    }
    if (!Array.isArray(node.needs)) {
      errors.push(`node "${node.id}" needs must be an array`);
      dependencyShapeValid = false;
    }
    if (!Array.isArray(node.owns)) {
      errors.push(`node "${node.id}" owns must be an array`);
      dependencyShapeValid = false;
    }
    if (node.implicitOutputs !== undefined && !Array.isArray(node.implicitOutputs)) {
      dependencyShapeValid = false;
    }
    if (!Array.isArray(node.checks)) errors.push(`node "${node.id}" checks must be an array`);
    for (const [field, value] of [["needs", node.needs], ["owns", node.owns], ["checks", node.checks], ["implicitOutputs", node.implicitOutputs]] as const) {
      if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
        errors.push(`node "${node.id}" ${field} must contain only strings`);
        if (["needs", "owns", "implicitOutputs"].includes(field)) dependencyShapeValid = false;
      }
    }
    if (node.timeoutMs !== undefined && (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1)) {
      errors.push(`node "${node.id}" timeoutMs must be a positive integer`);
    }
    if (node.model !== undefined && typeof node.model !== "string") {
      errors.push(`node "${node.id}" model must be a string`);
    }
    if (node.context !== undefined) {
      if (!isRecord(node.context)) {
        errors.push(`node "${node.id}" context must be an object`);
      } else {
        errors.push(...unknownPropertyErrors(node.context, contextProperties, `node "${node.id}" context`));
        for (const [field, value] of Object.entries(node.context)) {
          if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
            errors.push(`node "${node.id}" context.${field} must contain only strings`);
          }
        }
      }
    }
    if (Array.isArray(node.requiredModelUsage)) {
      for (const [usageIndex, usage] of node.requiredModelUsage.entries()) {
        if (isRecord(usage)) {
          errors.push(...unknownPropertyErrors(usage, modelUsageProperties, `node "${node.id}" requiredModelUsage[${usageIndex}]`));
        }
      }
    }
    if (!Number.isInteger(node.maxAttempts) || node.maxAttempts < 1) {
      errors.push(`node "${node.id}" maxAttempts must be a positive integer`);
    }
  }

  if (!dependencyShapeValid) return { errors, topologicalOrder: [] };

  for (const node of byId.values()) {
    for (const dependency of node.needs ?? []) {
      if (!byId.has(dependency)) {
        errors.push(`node "${node.id}" has missing dependency "${dependency}"`);
      }
    }
    if (node.type === "external_action" && node.target) {
      const matchingGate = (node.needs ?? []).some((dependency) => {
        const dependencyNode = byId.get(dependency);
        return dependencyNode?.type === "human_gate" && dependencyNode.target === node.target;
      });
      if (!matchingGate) {
        errors.push(
          `external_action node "${node.id}" requires a direct human_gate dependency for target "${node.target}"`,
        );
      }
    }
  }

  const topologicalOrder = topologicalSort([...byId.values()], byId);
  if (topologicalOrder.length !== byId.size) errors.push("graph contains a dependency cycle");
  if (topologicalOrder.length === byId.size) {
    errors.push(...findParallelOwnershipConflicts([...byId.values()], byId));
  }
  return { errors, topologicalOrder };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownPropertyErrors(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): string[] {
  return Object.keys(value)
    .filter((property) => !allowed.has(property))
    .map((property) => `${label} has unknown property "${property}"`);
}

function findParallelOwnershipConflicts(
  nodes: GraphNodeDefinition[],
  byId: Map<string, GraphNodeDefinition>,
): string[] {
  const errors: string[] = [];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      if (dependsOn(left.id, right.id, byId) || dependsOn(right.id, left.id, byId)) continue;
      const leftPatterns = [...left.owns, ...(left.implicitOutputs ?? [])];
      const rightPatterns = [...right.owns, ...(right.implicitOutputs ?? [])];
      if (leftPatterns.some((a) => rightPatterns.some((b) => patternsMayOverlap(a, b)))) {
        errors.push(
          `nodes "${left.id}" and "${right.id}" have overlapping ownership and may run in parallel`,
        );
      }
    }
  }
  return errors;
}

function dependsOn(
  nodeId: string,
  possibleDependency: string,
  byId: Map<string, GraphNodeDefinition>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(nodeId)) return false;
  seen.add(nodeId);
  const node = byId.get(nodeId);
  if (!node) return false;
  return node.needs.some(
    (dependency) =>
      dependency === possibleDependency || dependsOn(dependency, possibleDependency, byId, seen),
  );
}

function patternsMayOverlap(left: string, right: string): boolean {
  const leftPrefix = literalPrefix(left);
  const rightPrefix = literalPrefix(right);
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function literalPrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const wildcard = normalized.search(/[?*[]/);
  return wildcard === -1 ? normalized : normalized.slice(0, wildcard);
}

function topologicalSort(
  nodes: GraphNodeDefinition[],
  byId: Map<string, GraphNodeDefinition>,
): string[] {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const dependants = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) {
    for (const dependency of node.needs ?? []) {
      if (!byId.has(dependency)) continue;
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      dependants.get(dependency)?.push(node.id);
    }
  }
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependant of dependants.get(id) ?? []) {
      const next = (indegree.get(dependant) ?? 0) - 1;
      indegree.set(dependant, next);
      if (next === 0) ready.push(dependant);
    }
  }
  return order;
}
