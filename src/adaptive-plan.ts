import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { validateGraph } from "./graph.js";
import { graphHash } from "./graph-hash.js";
import type { GraphDefinition, GraphPatchRecord, PlanRevisionRecord, RunBudgets } from "./types.js";
import { assertSafeRunId } from "./run-id.js";

interface ActivePointer {
  schemaVersion: 1;
  revisionId: string;
  graphHash: string;
}

export interface ProposalOptions {
  proposer: string;
  rationale: string;
  patchId?: string;
  reversible?: boolean;
}

export interface ActivationContext {
  activeAttemptIds: string[];
  availableCapabilities?: string[];
  availableResources?: string[];
}

export interface ActivePlan extends PlanRevisionRecord {
  graph: GraphDefinition;
}

const defaultBudget = (graph: GraphDefinition): RunBudgets => ({
  maxNodes: graph.run.budgets?.maxNodes ?? graph.nodes.length,
  maxDepth: graph.run.budgets?.maxDepth ?? depth(graph),
  maxDurationMs: graph.run.budgets?.maxDurationMs ?? graph.nodes.reduce((sum, node) => sum + (node.timeoutMs ?? 20 * 60_000), 0),
  maxProviderCalls: graph.run.budgets?.maxProviderCalls ?? graph.nodes.filter((node) => node.executor && node.executor !== "shell").length,
  ...(graph.run.budgets?.maxCostUsd === undefined ? {} : { maxCostUsd: graph.run.budgets.maxCostUsd }),
});

export class PlanRegistry {
  private constructor(
    readonly root: string,
    private readonly budgets: RunBudgets,
  ) {}

  static async open(root: string, baseGraph: GraphDefinition, budgets = defaultBudget(baseGraph)): Promise<PlanRegistry> {
    const registry = new PlanRegistry(root, budgets);
    await mkdir(registry.revisionsDirectory, { recursive: true });
    await mkdir(registry.patchesDirectory, { recursive: true });
    const hash = graphHash(baseGraph);
    const revisionId = `plan-${hash.slice(0, 24)}`;
    const base: ActivePlan = {
      schemaVersion: 1,
      revisionId,
      runId: baseGraph.run.id,
      graphHash: hash,
      createdAt: new Date(0).toISOString(),
      graph: structuredClone(baseGraph),
    };
    await writeImmutable(join(registry.revisionsDirectory, `${revisionId}.v2.json`), canonical(base));
    try {
      await readFile(registry.activePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await registry.publishActive({ schemaVersion: 1, revisionId, graphHash: hash });
    }
    const active = await registry.active();
    if (active.runId !== baseGraph.run.id) throw new Error("active plan belongs to a different run");
    return registry;
  }

  async active(): Promise<ActivePlan> {
    const pointer = parseJson<ActivePointer>(await readFile(this.activePath, "utf8"), "active plan pointer");
    if (pointer.schemaVersion !== 1 || !pointer.revisionId || !pointer.graphHash) throw new Error("invalid active plan pointer");
    const revision = parseJson<ActivePlan>(await readFile(join(this.revisionsDirectory, `${pointer.revisionId}.v2.json`), "utf8"), "plan revision");
    if (!revision.graph || revision.graphHash !== pointer.graphHash || graphHash(revision.graph) !== pointer.graphHash) {
      throw new Error("active plan pointer and immutable revision do not agree");
    }
    return revision;
  }

  async revision(revisionId: string): Promise<ActivePlan> {
    const revision = parseJson<ActivePlan>(await readFile(join(this.revisionsDirectory, `${revisionId}.v2.json`), "utf8"), "plan revision");
    if (!revision.graph || graphHash(revision.graph) !== revision.graphHash) throw new Error("immutable plan revision hash mismatch");
    return revision;
  }

  async patches(): Promise<GraphPatchRecord[]> {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(this.patchesDirectory)).catch(() => [] as string[]);
    const patches: GraphPatchRecord[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      patches.push(parseJson<GraphPatchRecord>(await readFile(join(this.patchesDirectory, entry), "utf8"), "graph patch"));
    }
    return patches.sort((left, right) => left.proposedAt.localeCompare(right.proposedAt) || left.patchId.localeCompare(right.patchId));
  }

  async propose(proposedGraph: GraphDefinition, options: ProposalOptions): Promise<GraphPatchRecord> {
    if (!options.proposer.trim() || !options.rationale.trim()) throw new Error("patch proposer and rationale are required");
    if (options.proposer.length > 256 || options.rationale.length > 4_000) throw new Error("patch proposer or rationale exceeds its bounded size");
    const patchId = options.patchId ?? randomUUID();
    assertSafeRunId(patchId);
    const parent = await this.active();
    if (proposedGraph.run.id !== parent.runId) throw new Error("patch cannot change run identity");
    const patch: GraphPatchRecord = {
      schemaVersion: 1,
      patchId,
      runId: parent.runId,
      parentRevisionId: parent.revisionId,
      proposer: options.proposer,
      rationale: options.rationale,
      proposedGraphHash: graphHash(proposedGraph),
      proposedGraph: structuredClone(proposedGraph),
      reversible: options.reversible ?? true,
      proposedAt: new Date().toISOString(),
    };
    await writeImmutable(join(this.patchesDirectory, `${patch.patchId}.json`), canonical(patch));
    return patch;
  }

  async activate(patchId: string, context: ActivationContext): Promise<ActivePlan> {
    const revision = await this.prepareActivation(patchId, context);
    await this.setActive(revision);
    return revision;
  }

  async prepareActivation(patchId: string, context: ActivationContext): Promise<ActivePlan> {
    assertSafeRunId(patchId);
    if (context.activeAttemptIds.length > 0) throw new Error("plan patches activate only between waves");
    const patch = parseJson<GraphPatchRecord>(await readFile(join(this.patchesDirectory, `${patchId}.json`), "utf8"), "graph patch");
    const parent = await this.active();
    if (patch.parentRevisionId !== parent.revisionId) throw new Error("patch parent is not the active plan revision");
    this.validatePatch(patch, context, parent);
    const revisionId = `plan-${patch.proposedGraphHash.slice(0, 16)}-${patch.patchId.slice(0, 8)}`;
    const revision: ActivePlan = {
      schemaVersion: 1,
      revisionId,
      runId: patch.runId,
      graphHash: patch.proposedGraphHash,
      createdAt: new Date().toISOString(),
      parentRevisionId: parent.revisionId,
      patchId: patch.patchId,
      graph: structuredClone(patch.proposedGraph),
    };
    await writeImmutable(join(this.revisionsDirectory, `${revisionId}.v2.json`), canonical(revision));
    return revision;
  }

  async setActive(revision: ActivePlan): Promise<void> {
    await this.publishActive({ schemaVersion: 1, revisionId: revision.revisionId, graphHash: revision.graphHash });
  }

  private validatePatch(patch: GraphPatchRecord, context: ActivationContext, parent: ActivePlan): void {
    if (graphHash(patch.proposedGraph) !== patch.proposedGraphHash) throw new Error("graph patch hash mismatch");
    const errors = validateGraph(patch.proposedGraph).errors;
    if (errors.length > 0) throw new Error(`patch validation failed: ${errors.join("; ")}`);
    const graph = patch.proposedGraph;
    if (canonical(graph.run) !== canonical(parent.graph.run)) throw new Error("patch cannot mutate run configuration or authority bounds");
    if (graph.nodes.length > this.budgets.maxNodes) throw new Error(`patch exceeds mandate maxNodes ${this.budgets.maxNodes}`);
    if (depth(graph) > this.budgets.maxDepth) throw new Error(`patch exceeds mandate maxDepth ${this.budgets.maxDepth}`);
    const duration = graph.nodes.reduce((sum, node) => sum + (node.timeoutMs ?? 20 * 60_000), 0);
    if (duration > this.budgets.maxDurationMs) throw new Error(`patch exceeds mandate maxDurationMs ${this.budgets.maxDurationMs}`);
    const providerCalls = graph.nodes.filter((node) => node.executor && node.executor !== "shell").length;
    if (providerCalls > this.budgets.maxProviderCalls) throw new Error(`patch exceeds mandate maxProviderCalls ${this.budgets.maxProviderCalls}`);
    const cost = graph.nodes.reduce((sum, node) => sum + (node.estimatedCostUsd ?? 0), 0);
    if (this.budgets.maxCostUsd !== undefined && cost > this.budgets.maxCostUsd) throw new Error(`patch exceeds mandate maxCostUsd ${this.budgets.maxCostUsd}`);
    const capabilities = new Set(context.availableCapabilities ?? []);
    for (const node of graph.nodes) for (const capability of node.capabilities ?? []) {
      if (context.availableCapabilities && !capabilities.has(capability)) throw new Error(`patch requires unavailable capability "${capability}"`);
    }
    const resources = new Set(context.availableResources ?? []);
    for (const node of graph.nodes) for (const resource of node.resources ?? []) {
      if (context.availableResources && !resources.has(resource.name)) throw new Error(`patch requires unavailable resource "${resource.name}"`);
    }
  }

  private async publishActive(pointer: ActivePointer): Promise<void> {
    const temporary = `${this.activePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, canonical(pointer), { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.activePath);
  }

  private get revisionsDirectory(): string { return join(this.root, "plan-revisions"); }
  private get patchesDirectory(): string { return join(this.root, "plan-patches"); }
  private get activePath(): string { return join(this.root, "ACTIVE_PLAN.json"); }
}

function depth(graph: GraphDefinition): number {
  const values = new Map<string, number>();
  const visit = (id: string, path = new Set<string>()): number => {
    if (path.has(id)) return Number.POSITIVE_INFINITY;
    const cached = values.get(id);
    if (cached !== undefined) return cached;
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node) return 0;
    const nextPath = new Set(path).add(id);
    const value = 1 + Math.max(0, ...node.needs.map((dependency) => visit(dependency, nextPath)));
    values.set(id, value);
    return value;
  };
  return Math.max(0, ...graph.nodes.map((node) => visit(node.id)));
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item, 2)}\n`;
}

async function writeImmutable(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== content) throw new Error(`immutable artifact already exists with different content: ${path}`);
  }
}

function parseJson<T>(raw: string, label: string): T {
  try { return JSON.parse(raw) as T; } catch { throw new Error(`invalid ${label}`); }
}
