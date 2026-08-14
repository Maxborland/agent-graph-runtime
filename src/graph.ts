import type {
  GraphDefinition,
  GraphNodeDefinition,
  GraphValidationResult,
} from "./types.js";

const nodeTypes = new Set([
  "agent",
  "verify",
  "review",
  "human_gate",
  "external_action",
]);
const executors = new Set(["codex", "claude", "shell"]);

export function validateGraph(graph: GraphDefinition): GraphValidationResult {
  const errors: string[] = [];
  if (graph.version !== 1) errors.push("version must be 1");
  if (!graph.run?.id) errors.push("run.id is required");
  if (!graph.run?.objective) errors.push("run.objective is required");
  if (!graph.run?.repository) errors.push("run.repository is required");
  if (!Number.isInteger(graph.run?.maxConcurrency) || graph.run.maxConcurrency < 1) {
    errors.push("run.maxConcurrency must be a positive integer");
  }

  const byId = new Map<string, GraphNodeDefinition>();
  for (const node of graph.nodes ?? []) {
    if (!node.id) {
      errors.push("every node requires an id");
      continue;
    }
    if (byId.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    byId.set(node.id, node);
    if (!nodeTypes.has(node.type)) errors.push(`node "${node.id}" has invalid type`);
    if (node.executor && !executors.has(node.executor)) {
      errors.push(`node "${node.id}" has invalid executor`);
    }
    if (["agent", "review"].includes(node.type) && !node.executor) {
      errors.push(`node "${node.id}" requires an executor`);
    }
    if (["agent", "review"].includes(node.type) && !node.prompt?.trim()) {
      errors.push(`node "${node.id}" requires a prompt`);
    }
    if (
      node.type === "review" &&
      ((node.owns?.length ?? 0) > 0 || (node.implicitOutputs?.length ?? 0) > 0)
    ) {
      errors.push(`review node "${node.id}" must not declare writable ownership`);
    }
    if (["human_gate", "external_action"].includes(node.type) && !node.target?.trim()) {
      errors.push(`${node.type} node "${node.id}" requires a target`);
    }
    if (node.type === "external_action" && !node.executor) {
      errors.push(`external_action node "${node.id}" requires an executor`);
    }
    if (!Array.isArray(node.needs)) errors.push(`node "${node.id}" needs must be an array`);
    if (!Array.isArray(node.owns)) errors.push(`node "${node.id}" owns must be an array`);
    if (!Array.isArray(node.checks)) errors.push(`node "${node.id}" checks must be an array`);
    if (!Number.isInteger(node.maxAttempts) || node.maxAttempts < 1) {
      errors.push(`node "${node.id}" maxAttempts must be a positive integer`);
    }
  }

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
