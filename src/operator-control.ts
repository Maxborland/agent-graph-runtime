import { CliError } from "./cli-error.js";
import { RunLifecycle } from "./lifecycle.js";
import { readRunStateArtifact } from "./observation.js";
import { gitChangedFiles } from "./repository.js";
import { acquireRunLock } from "./run-lock.js";
import { RunStore } from "./store.js";
import type { GraphDefinition, GraphNodeDefinition, RunState } from "./types.js";

export class OperatorControl {
  constructor(
    private readonly graph: GraphDefinition,
    private readonly repositoryRoot: string,
  ) {}

  async approve(nodeId: string, target: string): Promise<RunState> {
    const gate = this.requireGate(nodeId, target);
    this.requireGateReady(gate.id, gate.needs, await this.currentState());
    return this.mutate(async (store) => {
      this.requireGateReady(gate.id, gate.needs, store.state);
      const event = new RunLifecycle(this.graph, store.state).approveGate(nodeId, target);
      await store.appendEvent({ at: new Date().toISOString(), ...event });
      await store.save("approval-recorded");
    });
  }

  async retry(nodeId: string): Promise<RunState> {
    if (!this.graph.nodes.some((node) => node.id === nodeId)) {
      throw new CliError(`node "${nodeId}" does not exist`, 3, "NODE_NOT_FOUND");
    }
    await this.currentState();
    return this.mutate(async (store) => {
      const events = new RunLifecycle(this.graph, store.state).retryFrom(nodeId);
      for (const event of events) {
        await store.appendEvent({ at: new Date().toISOString(), ...event });
      }
      await store.save("manual-retry");
    });
  }

  async acknowledgeAdvisor(): Promise<RunState> {
    this.requireAdvisorBlocker(await this.currentState());
    return this.mutate(async (store) => {
      this.requireAdvisorBlocker(store.state);
      const event = new RunLifecycle(this.graph, store.state).acknowledgeAdvisorBlocker();
      await store.appendEvent({ at: new Date().toISOString(), ...event });
      await store.save("advisor-acknowledged");
    });
  }

  private async mutate(change: (store: RunStore) => Promise<void>): Promise<RunState> {
    const lock = await acquireRunLock(this.repositoryRoot, this.graph.run.id);
    try {
      const baseline = await gitChangedFiles(this.repositoryRoot);
      const store = await RunStore.open(this.repositoryRoot, this.graph, baseline);
      await change(store);
      return store.state;
    } finally {
      await lock.release();
    }
  }

  private currentState(): Promise<RunState> {
    return readRunStateArtifact(this.repositoryRoot, this.graph.run.id);
  }

  private requireGate(nodeId: string, target: string): GraphNodeDefinition {
    const node = this.graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new CliError(`node "${nodeId}" does not exist`, 3, "NODE_NOT_FOUND");
    if (node.type !== "human_gate") {
      throw new CliError(`node "${nodeId}" is not a human gate`, 3, "INVALID_APPROVAL");
    }
    if (node.target !== target) {
      throw new CliError(
        `approval target "${target}" does not match required target "${node.target ?? "missing"}"`,
        3,
        "INVALID_APPROVAL_TARGET",
      );
    }
    return node;
  }

  private requireGateReady(nodeId: string, needs: string[], state: RunState): void {
    if (!needs.every((dependency) => state.nodes[dependency]?.status === "accepted")) {
      throw new CliError(`human gate "${nodeId}" is not dependency-ready`, 3, "GATE_NOT_READY");
    }
  }

  private requireAdvisorBlocker(state: RunState): void {
    if (!state.advisor?.blocker) {
      throw new CliError(
        `run ${this.graph.run.id} has no advisor blocker to acknowledge`,
        3,
        "ADVISOR_BLOCKER_MISSING",
      );
    }
  }
}
