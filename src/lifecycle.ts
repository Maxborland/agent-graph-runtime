import type { GraphDefinition, GraphNodeDefinition, RunEvent, RunState } from "./types.js";

export type LifecycleEvent = Omit<RunEvent, "seq" | "at">;

export class RunLifecycle {
  constructor(
    private readonly graph: GraphDefinition,
    readonly state: RunState,
  ) {}

  approveGate(nodeId: string, target: string): LifecycleEvent {
    const node = this.graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`node "${nodeId}" does not exist`);
    if (node.type !== "human_gate") throw new Error(`node "${nodeId}" is not a human gate`);
    if (!node.target) throw new Error(`human gate "${nodeId}" has no exact target`);
    if (node.target !== target) {
      throw new Error(`approval target "${target}" does not match required target "${node.target}"`);
    }
    if (!node.needs.every((dependency) => this.state.nodes[dependency]?.status === "accepted")) {
      throw new Error(`human gate "${nodeId}" is not dependency-ready`);
    }
    const nodeState = this.state.nodes[nodeId]!;
    nodeState.approvedTarget = target;
    nodeState.status = "pending";
    this.state.status = "running";
    return { type: "approval_recorded", nodeId, detail: target };
  }

  retryFrom(nodeId: string): LifecycleEvent[] {
    if (!this.graph.nodes.some((node) => node.id === nodeId)) {
      throw new Error(`node "${nodeId}" does not exist`);
    }
    const invalidated = collectDescendants(this.graph, nodeId);
    invalidated.add(nodeId);
    const events: LifecycleEvent[] = [];
    for (const id of invalidated) {
      const nodeState = this.state.nodes[id]!;
      nodeState.status = "pending";
      nodeState.attempts = 0;
      nodeState.evidenceFiles = [];
      delete nodeState.retryBlocked;
      delete nodeState.approvedTarget;
      delete nodeState.lastError;
      events.push({ type: "node_invalidated", nodeId: id, detail: `manual retry from ${nodeId}` });
    }
    this.state.status = "running";
    return events;
  }

  resumeRun(): LifecycleEvent {
    this.state.status = "running";
    return { type: "run_started" };
  }

  requireAttention(): LifecycleEvent {
    if (!this.attentionRequired()) throw new Error("run has no recorded attention blocker");
    this.state.status = "needs_attention";
    return { type: "run_needs_attention" };
  }

  readyNodes(): GraphNodeDefinition[] {
    const running = Object.values(this.state.nodes).filter((node) => node.status === "running").length;
    const capacity = Math.max(0, this.graph.run.maxConcurrency - running);
    return this.graph.nodes
      .filter((node) => {
        const nodeState = this.state.nodes[node.id];
        if (!nodeState) return false;
        if (!["pending", "failed"].includes(nodeState.status)) return false;
        if (nodeState.retryBlocked) return false;
        if (nodeState.attempts >= node.maxAttempts) return false;
        return node.needs.every((dependency) => this.state.nodes[dependency]?.status === "accepted");
      })
      .slice(0, capacity);
  }

  readyUnapprovedGate(): GraphNodeDefinition | undefined {
    return this.graph.nodes.find((node) => {
      const nodeState = this.state.nodes[node.id];
      return (
        node.type === "human_gate" &&
        nodeState?.status !== "accepted" &&
        !nodeState?.approvedTarget &&
        node.needs.every((dependency) => this.state.nodes[dependency]?.status === "accepted")
      );
    });
  }

  awaitApproval(nodeId: string): LifecycleEvent {
    const gate = this.readyUnapprovedGate();
    if (!gate || gate.id !== nodeId) throw new Error(`human gate "${nodeId}" is not ready for approval`);
    this.state.nodes[nodeId]!.status = "awaiting_approval";
    this.state.status = "awaiting_approval";
    return { type: "approval_required", nodeId, detail: gate.target ?? gate.prompt ?? "human approval" };
  }

  acceptApprovedGates(): boolean {
    let changed = false;
    for (const node of this.graph.nodes.filter((candidate) => candidate.type === "human_gate")) {
      const nodeState = this.state.nodes[node.id]!;
      if (
        nodeState.approvedTarget &&
        nodeState.approvedTarget === node.target &&
        node.needs.every((dependency) => this.state.nodes[dependency]?.status === "accepted")
      ) {
        nodeState.status = "accepted";
        changed = true;
      }
    }
    return changed;
  }

  assertExternalActionAuthorized(nodeId: string): void {
    const node = this.graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`node "${nodeId}" does not exist`);
    if (node.type !== "external_action") throw new Error(`node "${nodeId}" is not an external action`);
    if (!this.graph.run.allowExternalActions) throw new Error("external actions are disabled for this graph");
    const approved = node.needs.some((dependency) => {
      const dependencyNode = this.graph.nodes.find((candidate) => candidate.id === dependency);
      const dependencyState = this.state.nodes[dependency];
      return (
        dependencyNode?.type === "human_gate" &&
        dependencyState?.status === "accepted" &&
        dependencyState.approvedTarget === node.target
      );
    });
    if (!approved) throw new Error("external action lacks an approved human gate for its target");
  }

  startNode(nodeId: string): LifecycleEvent & { type: "node_started"; nodeId: string; detail: string } {
    const node = this.readyNodes().find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`node "${nodeId}" is not ready to start`);
    const nodeState = this.state.nodes[nodeId]!;
    nodeState.status = "running";
    nodeState.attempts += 1;
    delete nodeState.lastError;
    return { type: "node_started", nodeId, detail: `attempt ${nodeState.attempts}` };
  }

  acceptNode(nodeId: string): LifecycleEvent {
    const nodeState = this.state.nodes[nodeId];
    if (!nodeState) throw new Error(`node "${nodeId}" does not exist`);
    if (nodeState.status !== "running") throw new Error(`node "${nodeId}" is not running`);
    nodeState.status = "accepted";
    delete nodeState.retryBlocked;
    delete nodeState.lastError;
    return { type: "node_accepted", nodeId };
  }

  failNode(nodeId: string, error: string, retryBlocked: boolean): LifecycleEvent {
    const nodeState = this.state.nodes[nodeId];
    if (!nodeState) throw new Error(`node "${nodeId}" does not exist`);
    if (nodeState.status !== "running") throw new Error(`node "${nodeId}" is not running`);
    nodeState.status = "failed";
    nodeState.lastError = error;
    if (retryBlocked) nodeState.retryBlocked = true;
    else delete nodeState.retryBlocked;
    return {
      type: "node_failed",
      nodeId,
      detail: retryBlocked
        ? "attempt failed and requires operator reconciliation; inspect evidence"
        : "attempt failed; inspect evidence",
    };
  }

  attentionRequired(): boolean {
    return Object.values(this.state.nodes).some((node) => node.retryBlocked) || Boolean(this.state.advisor?.blocker);
  }

  recoverInterruptedNodes(): LifecycleEvent[] {
    const events: LifecycleEvent[] = [];
    for (const [nodeId, nodeState] of Object.entries(this.state.nodes)) {
      if (nodeState.status !== "running") continue;
      const definition = this.graph.nodes.find((candidate) => candidate.id === nodeId);
      const requiresReconciliation = definition?.type === "external_action";
      nodeState.status = requiresReconciliation ? "failed" : "pending";
      if (requiresReconciliation) {
        nodeState.retryBlocked = true;
        nodeState.lastError = "external action was interrupted; inspect partial effects, then use agr retry explicitly";
      }
      events.push({
        type: "node_interrupted",
        nodeId,
        detail: requiresReconciliation
          ? "External action requires partial-effect reconciliation before explicit retry"
          : "Recovered a node left running by a previous process",
      });
    }
    return events;
  }

  interruptNode(nodeId: string, terminationUnconfirmed: boolean): LifecycleEvent {
    const nodeState = this.state.nodes[nodeId];
    if (!nodeState) throw new Error(`node "${nodeId}" does not exist`);
    if (nodeState.status !== "running") throw new Error(`node "${nodeId}" is not running`);
    nodeState.status = "failed";
    nodeState.retryBlocked = true;
    nodeState.lastError = terminationUnconfirmed
      ? "cancelled and process-tree termination was not confirmed; reconcile surviving work before agr retry"
      : "cancelled during execution; inspect partial effects before agr retry";
    return { type: "node_interrupted", nodeId, detail: nodeState.lastError };
  }

  cancelRun(): LifecycleEvent & { type: "run_cancelled" } {
    if (Object.values(this.state.nodes).some((node) => node.status === "running")) {
      throw new Error("cannot finalize cancellation while a node is still recorded as running");
    }
    this.state.status = "cancelled";
    return { type: "run_cancelled" };
  }

  acknowledgeAdvisorBlocker(): LifecycleEvent {
    const blocker = this.state.advisor?.blocker;
    if (!blocker) throw new Error(`run ${this.state.runId} has no advisor blocker to acknowledge`);
    delete this.state.advisor!.blocker;
    this.state.status = "running";
    return {
      type: "advisor_acknowledged",
      nodeId: blocker.id,
      detail: blocker.summary,
      severity: blocker.severity,
      evidenceFile: blocker.evidenceFile,
    };
  }

  finishWhenIdle(): LifecycleEvent & { type: "run_completed" | "run_needs_attention" | "run_failed" } {
    if (Object.values(this.state.nodes).some((node) => node.status === "running") || this.readyNodes().length > 0) {
      throw new Error("run is not idle");
    }
    if (this.graph.nodes.every((node) => this.state.nodes[node.id]?.status === "accepted")) {
      this.state.status = "completed";
      return { type: "run_completed" };
    }
    if (this.attentionRequired()) {
      this.state.status = "needs_attention";
      return { type: "run_needs_attention" };
    }
    for (const node of this.graph.nodes) {
      const nodeState = this.state.nodes[node.id]!;
      if (["accepted", "failed", "awaiting_approval"].includes(nodeState.status)) continue;
      nodeState.status = "blocked";
      nodeState.lastError = "dependency did not reach accepted state";
    }
    this.state.status = "failed";
    return { type: "run_failed" };
  }
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
