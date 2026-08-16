import type { GraphDefinition, GraphNodeDefinition } from "./types.js";
import { repositorySnapshotHash, repositorySnapshotTransfer } from "./repository-snapshot.js";
import { applyVerifiedWorkerResult, verifyWorkerResultInIsolation } from "./worker-acceptance.js";
import { dispatchToWorker, verifyWorkerResult, workerHealth, type WorkerDispatchRequest, type WorkerResultEnvelope } from "./worker-protocol.js";
import { CoordinatorDatabase, type RemoteAttemptEnvelope } from "./sqlite-coordinator.js";

export interface EnrolledWorkerConnection {
  workerId: string;
  endpoint: string;
  coordinatorToken: string;
  workerToken: string;
}

export const coordinatorSnapshotHash = repositorySnapshotHash;

export class DistributedCoordinator {
  constructor(
    private readonly database: CoordinatorDatabase,
    private readonly workers: Map<string, EnrolledWorkerConnection>,
  ) {}

  async dispatchAndAccept(options: {
    node: GraphNodeDefinition;
    envelope: RemoteAttemptEnvelope;
    workerId?: string;
    worktree: string;
    payload: WorkerDispatchRequest["payload"];
    leaseTtlMs: number;
    afterIntentStaged?: () => void;
    afterCompletionAccepted?: () => void;
  }): Promise<WorkerResultEnvelope> {
    if (options.node.type === "external_action") throw new Error("external actions are coordinator-local and cannot be remotely dispatched");
    if (await repositorySnapshotHash(options.worktree) !== options.envelope.repositorySnapshotHash) throw new Error("coordinator repository snapshot drifted before remote dispatch");
    const worker = this.requireConnection(options.workerId ?? this.database.selectWorker(options.envelope.requiredCapabilities));
    const health = await workerHealth(worker.endpoint, worker.coordinatorToken);
    if (health.workerId !== worker.workerId) throw new Error("worker health identity does not match enrollment connection");
    const repositorySnapshot = await repositorySnapshotTransfer(options.worktree, health.repositoryHead);
    this.database.createAttempt(options.envelope);
    const lease = this.database.acquireLease(options.envelope.attemptId, worker.workerId, worker.workerToken, options.leaseTtlMs);
    const result = await dispatchToWorker(worker.endpoint, worker.coordinatorToken, {
      envelope: options.envelope,
      lease,
      payload: { ...options.payload, repositorySnapshot },
    });
    verifyWorkerResult(result, { attemptId: options.envelope.attemptId, workerId: worker.workerId, fencingToken: lease.fencingToken });
    if (await repositorySnapshotHash(options.worktree) !== options.envelope.repositorySnapshotHash) throw new Error("coordinator repository snapshot drifted before result acceptance");
    const completion = {
      attemptId: result.attemptId,
      workerId: result.workerId,
      workerToken: worker.workerToken,
      fencingToken: result.fencingToken,
      completedAt: result.completedAt,
      resultHash: result.resultHash,
    };
    this.database.stageAcceptanceIntent(completion, JSON.stringify(result));
    options.afterIntentStaged?.();
    await verifyWorkerResultInIsolation(options.worktree, options.node, result, { attemptId: result.attemptId, workerId: result.workerId, fencingToken: result.fencingToken });
    const accepted = this.database.completeAttempt(completion);
    if (!accepted.accepted) throw new Error(`coordinator rejected worker result: ${accepted.reason}`);
    options.afterCompletionAccepted?.();
    if (await repositorySnapshotHash(options.worktree) !== options.envelope.repositorySnapshotHash) {
      throw new Error("coordinator repository snapshot drifted after acceptance; intent remains pending for explicit reconciliation");
    }
    await applyVerifiedWorkerResult(options.worktree, options.node, result, { attemptId: result.attemptId, workerId: result.workerId, fencingToken: result.fencingToken });
    this.database.resolveAcceptanceIntent(result.attemptId);
    return result;
  }

  async reconcilePending(resolve: (attemptId: string) => { node: GraphNodeDefinition; worktree: string; repositorySnapshotHash: string }, runId?: string): Promise<string[]> {
    const reconciled: string[] = [];
    for (const intent of this.database.pendingAcceptanceIntents(runId)) {
      const result = JSON.parse(intent.resultJson) as WorkerResultEnvelope;
      const worker = this.requireConnection(intent.workerId);
      const target = resolve(intent.attemptId);
      if (await repositorySnapshotHash(target.worktree) !== target.repositorySnapshotHash) throw new Error("coordinator repository snapshot drifted before pending acceptance reconciliation");
      await verifyWorkerResultInIsolation(target.worktree, target.node, result, { attemptId: intent.attemptId, workerId: intent.workerId, fencingToken: intent.fencingToken });
      const accepted = this.database.completeAttempt({
        attemptId: result.attemptId,
        workerId: result.workerId,
        workerToken: worker.workerToken,
        fencingToken: result.fencingToken,
        completedAt: result.completedAt,
        resultHash: result.resultHash,
      });
      if (!accepted.accepted && !accepted.reason?.includes("completed")) throw new Error(`pending acceptance reconciliation failed: ${accepted.reason}`);
      await applyVerifiedWorkerResult(target.worktree, target.node, result, { attemptId: intent.attemptId, workerId: intent.workerId, fencingToken: intent.fencingToken });
      this.database.resolveAcceptanceIntent(intent.attemptId);
      reconciled.push(intent.attemptId);
    }
    return reconciled;
  }

  async reconcileGraphPending(graph: GraphDefinition, worktree: string): Promise<string[]> {
    return this.reconcilePending((attemptId) => {
      const envelope = this.database.attemptEnvelope(attemptId);
      if (!envelope || envelope.runId !== graph.run.id) throw new Error(`pending attempt ${attemptId} does not belong to run ${graph.run.id}`);
      const node = graph.nodes.find((candidate) => candidate.id === envelope.nodeId);
      if (!node) throw new Error(`pending attempt ${attemptId} references a node outside the active plan`);
      return { node, worktree, repositorySnapshotHash: envelope.repositorySnapshotHash };
    }, graph.run.id);
  }

  private requireConnection(workerId: string): EnrolledWorkerConnection {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`worker ${workerId} has no enrolled coordinator connection`);
    return worker;
  }
}
