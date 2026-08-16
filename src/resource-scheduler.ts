import type { ExecutorName, GraphNodeDefinition, ResourceClaim } from "./types.js";

export interface ResourceSchedulerOptions {
  maxConcurrency: number;
  providerConcurrency?: Partial<Record<ExecutorName, number>>;
  budgets?: {
    maxProviderCalls?: number;
    maxCostUsd?: number;
    deadlineAt?: number;
  };
  initialAccounting?: {
    providerCalls: number;
    costUsd: number;
  };
}

export interface ResourceLease {
  attemptId: string;
  claims: ResourceClaim[];
  release(outcome?: { accepted: boolean }): void;
}

interface ActiveLease {
  attemptId: string;
  executor?: ExecutorName;
  claims: ResourceClaim[];
}

export class ResourceScheduler {
  private readonly active = new Map<string, ActiveLease>();
  private providerCalls: number;
  private costUsd: number;

  constructor(private readonly options: ResourceSchedulerOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) throw new Error("maxConcurrency must be positive");
    this.providerCalls = options.initialAccounting?.providerCalls ?? 0;
    this.costUsd = options.initialAccounting?.costUsd ?? 0;
  }

  tryAcquire(node: GraphNodeDefinition, attemptId: string): ResourceLease | undefined {
    if (this.active.has(attemptId)) throw new Error(`attempt ${attemptId} already owns resources`);
    this.assertBudget(node);
    if (this.active.size >= this.options.maxConcurrency) return undefined;
    const claims = normalizedClaims(node);
    if (this.conflicts(claims)) return undefined;
    if (node.executor) {
      const limit = this.options.providerConcurrency?.[node.executor];
      const activeForProvider = [...this.active.values()].filter((lease) => lease.executor === node.executor).length;
      if (limit !== undefined && activeForProvider >= limit) return undefined;
    }
    const lease: ActiveLease = {
      attemptId,
      ...(node.executor === undefined ? {} : { executor: node.executor }),
      claims,
    };
    this.active.set(attemptId, lease);
    if (node.executor && node.executor !== "shell") this.providerCalls += 1;
    this.costUsd += node.estimatedCostUsd ?? 0;
    let released = false;
    return {
      attemptId,
      claims: [...claims],
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(attemptId);
      },
    };
  }

  snapshot(): { providerCalls: number; costUsd: number; activeAttemptIds: string[] } {
    return {
      providerCalls: this.providerCalls,
      costUsd: Number(this.costUsd.toFixed(8)),
      activeAttemptIds: [...this.active.keys()].sort(),
    };
  }

  private assertBudget(node: GraphNodeDefinition): void {
    const budgets = this.options.budgets;
    if (!budgets) return;
    if (budgets.deadlineAt !== undefined && Date.now() >= budgets.deadlineAt) throw new Error("run duration budget expired before dispatch");
    if (node.executor && node.executor !== "shell" && budgets.maxProviderCalls !== undefined && this.providerCalls >= budgets.maxProviderCalls) {
      throw new Error("provider-call budget exhausted before dispatch");
    }
    if (budgets.maxCostUsd !== undefined && this.costUsd + (node.estimatedCostUsd ?? 0) > budgets.maxCostUsd) {
      throw new Error("cost budget exceeded before dispatch");
    }
  }

  private conflicts(claims: ResourceClaim[]): boolean {
    for (const claim of claims) for (const active of this.active.values()) for (const held of active.claims) {
      if (claim.name === held.name && (claim.mode === "exclusive" || held.mode === "exclusive")) return true;
    }
    return false;
  }
}

function normalizedClaims(node: GraphNodeDefinition): ResourceClaim[] {
  const claims = [...(node.resources ?? [])].map((claim) => ({ ...claim }));
  for (const pattern of [...node.owns, ...(node.implicitOutputs ?? [])]) {
    claims.push({ name: `repository-write:${pattern}`, mode: "exclusive" });
  }
  return claims;
}
