import { CliError } from "./cli-error.js";
import { hasUnusedReceipt, issueApprovalReceipt, repositoryFingerprint } from "./authority.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "./persistence.js";
import { RunLifecycle } from "./lifecycle.js";
import { readRunStateArtifact } from "./observation.js";
import { gitChangedFiles } from "./repository.js";
import { acquireRunLock } from "./run-lock.js";
import { RunStore } from "./store.js";
import { resolveActivePlanGraph } from "./run-plan.js";
import type { GraphDefinition, GraphNodeDefinition, RunState } from "./types.js";

export class OperatorControl {
  constructor(
    private graph: GraphDefinition,
    private readonly repositoryRoot: string,
  ) {}

  async approve(nodeId: string, target: string): Promise<RunState> {
    this.graph = await resolveActivePlanGraph(this.repositoryRoot, this.graph);
    const gate = this.requireGate(nodeId, target);
    this.requireGateReady(gate.id, gate.needs, await this.currentState());
    return this.mutate(async (store) => {
      this.requireGateReady(gate.id, gate.needs, store.state);
      const receipt = issueApprovalReceipt(
        this.graph,
        store.state,
        nodeId,
        target,
        await repositoryFingerprint(store.state.repository.worktreePath ?? this.repositoryRoot),
      );
      store.state.authority.receipts.push(receipt);
      const event = new RunLifecycle(this.graph, store.state).approveGate(nodeId, target);
      await store.appendEvent({ at: new Date().toISOString(), ...event });
      await store.save("approval-recorded");
    });
  }

  async retry(nodeId: string, reconciliationPath?: string): Promise<RunState> {
    this.graph = await resolveActivePlanGraph(this.repositoryRoot, this.graph);
    const definition = this.graph.nodes.find((node) => node.id === nodeId);
    if (!definition) {
      throw new CliError(`node "${nodeId}" does not exist`, 3, "NODE_NOT_FOUND");
    }
    await this.currentState();
    return this.mutate(async (store) => {
      if (store.state.status === "completed" || store.state.git?.resultId) {
        throw new CliError(
          `run ${store.state.runId} already has a completed immutable result; use a new run.id and explicit baseCommit`,
          3,
          "COMPLETED_RUN_IMMUTABLE",
        );
      }
      const nodeState = store.state.nodes[nodeId]!;
      if (definition.type === "external_action" && nodeState.retryBlocked) {
        if (!reconciliationPath) {
          throw new CliError(
            `external action "${nodeId}" requires --reconciliation evidence before retry`,
            3,
            "RECONCILIATION_REQUIRED",
          );
        }
        if (!hasUnusedReceipt(this.graph, store.state, nodeId)) {
          throw new CliError(
            `external action "${nodeId}" requires a newly issued approval receipt before retry`,
            3,
            "FRESH_APPROVAL_REQUIRED",
          );
        }
        const attemptId = nodeState.currentAttemptId;
        if (!attemptId) throw new CliError(`node "${nodeId}" has no attempt to reconcile`, 3, "ATTEMPT_MISSING");
        const content = await readFile(reconciliationPath).catch((error: unknown) => {
          throw new CliError(
            `cannot read reconciliation evidence ${reconciliationPath}: ${error instanceof Error ? error.message : String(error)}`,
            3,
            "RECONCILIATION_INVALID",
          );
        });
        const digest = sha256(content);
        const directory = join(store.runDirectory, "reconciliation");
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${attemptId}-${digest.slice(0, 24)}.evidence`);
        try {
          await writeFile(path, content, { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!Buffer.from(await readFile(path)).equals(content)) {
            throw new CliError("reconciliation evidence path already contains different bytes", 3, "RECONCILIATION_INVALID");
          }
        }
        const record = {
          schemaVersion: 1 as const,
          reconciliationId: randomUUID(),
          attemptId,
          sha256: digest,
          size: content.byteLength,
          localPath: relative(store.runDirectory, path).replaceAll("\\", "/"),
          recordedAt: new Date().toISOString(),
        };
        store.state.authority.reconciliations.push(record);
        await store.appendEvent({
          at: record.recordedAt,
          type: "reconciliation_recorded",
          nodeId,
          detail: record.reconciliationId,
        });
      }
      const events = new RunLifecycle(this.graph, store.state).retryFrom(nodeId);
      for (const event of events) {
        await store.appendEvent({ at: new Date().toISOString(), ...event });
      }
      await store.save("manual-retry");
    });
  }

  async acknowledgeAdvisor(): Promise<RunState> {
    this.graph = await resolveActivePlanGraph(this.repositoryRoot, this.graph);
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
