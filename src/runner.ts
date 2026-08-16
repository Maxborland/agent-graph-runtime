import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { NonRetryableAdapterError, type AgentAdapter } from "./adapters.js";
import {
  consumeReservation,
  evaluateMandate,
  repositoryFingerprint,
  requireUsableReceipt,
  reserveApproval,
} from "./authority.js";
import { runChecks, type CheckResult } from "./checks.js";
import { buildCodeContext } from "./context.js";
import { validateGraph } from "./graph.js";
import { digestAcceptedEvidence, GitRunTransaction } from "./git-transaction.js";
import { verifyRunEvidenceArtifacts } from "./evidence.js";
import {
  findUnexpectedChanges,
  gitChangedFiles,
  gitChangeSnapshot,
  matchesGlob,
  type GitChangeSnapshot,
} from "./repository.js";
import { writeRunReport } from "./report.js";
import { RunLifecycle } from "./lifecycle.js";
import { PassiveAdvisor } from "./advisor.js";
import { sha256 } from "./persistence.js";
import { RunStore } from "./store.js";
import { createNodeProgressChannel, type NodeProgressMilestone } from "./node-progress.js";
import { readRunStateArtifact } from "./observation.js";
import type {
  AdapterResult,
  AdvisorObservation,
  ExecutorName,
  GraphDefinition,
  GraphNodeDefinition,
  RunState,
} from "./types.js";

type AgentAdapters = Partial<Record<Exclude<ExecutorName, "shell">, AgentAdapter>>;

export interface RunProgressEvent {
  at: string;
  type:
    | "run_started"
    | "approval_required"
    | "node_started"
    | "node_activity"
    | "node_progress"
    | "heartbeat"
    | "node_accepted"
    | "node_failed"
    | "advisor_note"
    | "advisor_failed"
    | "run_completed"
    | "run_failed"
    | "run_needs_attention"
    | "run_cancelled";
  runId: string;
  nodeId?: string;
  activeNodeIds?: string[];
  elapsedMs?: number;
  detail?: string;
  phase?: string;
  percent?: number;
  severity?: "note" | "concern" | "blocker";
  latestNodeProgress?: Record<string, NodeProgressMilestone>;
}

export interface GraphRunnerOptions {
  codeGraphCommand?: string;
  heartbeatMs?: number;
  onProgress?: (event: RunProgressEvent) => void;
  verbose?: boolean;
  signal?: AbortSignal;
}

interface NodeOutcome {
  node: GraphNodeDefinition;
  prompt: string;
  adapterResult?: AdapterResult;
  checks: CheckResult[];
  error?: string;
  aborted?: boolean;
  retryBlocked?: boolean;
  externalDispatchStarted?: boolean;
}

export class GraphRunner {
  private readonly latestNodeProgress = new Map<string, NodeProgressMilestone>();
  private readonly pendingEventWrites = new Set<Promise<unknown>>();
  private executionRoot: string;
  private transaction: GitRunTransaction | undefined;

  constructor(
    private readonly graph: GraphDefinition,
    private readonly repositoryRoot: string,
    private readonly adapters: AgentAdapters,
    private readonly options: GraphRunnerOptions = {},
  ) {
    this.executionRoot = repositoryRoot;
  }

  async run(): Promise<RunState> {
    const validation = validateGraph(this.graph);
    if (validation.errors.length > 0) {
      throw new Error(`Invalid graph:\n- ${validation.errors.join("\n- ")}`);
    }
    let persistedBaseCommit: string | undefined;
    try {
      const persisted = await readRunStateArtifact(this.repositoryRoot, this.graph.run.id);
      persistedBaseCommit = persisted.git?.baseCommit ?? persisted.repository.baseCommit;
    } catch (error) {
      if ((error as { code?: string }).code !== "RUN_NOT_FOUND") throw error;
    }
    this.transaction = await GitRunTransaction.prepare(
      this.repositoryRoot,
      this.graph,
      persistedBaseCommit,
    );
    this.executionRoot = this.transaction?.worktreePath ?? this.repositoryRoot;
    this.emitProgress({ type: "run_started" });
    let currentBaseline: string[];
    try {
      currentBaseline = await gitChangedFiles(this.executionRoot, this.options.signal);
    } catch (error) {
      if (!this.options.signal?.aborted) throw error;
      const cancelledStore = await RunStore.open(this.repositoryRoot, this.graph, []);
      return this.cancelRun(cancelledStore);
    }
    const store = await RunStore.open(this.repositoryRoot, this.graph, currentBaseline);
    if (this.transaction && !store.state.git) {
      store.state.repository = {
        ...store.state.repository,
        baseCommit: this.transaction.baseCommit,
        worktreePath: this.transaction.worktreePath,
        runBranch: this.transaction.runBranch,
      };
      store.state.git = {
        schemaVersion: 1,
        baseCommit: this.transaction.baseCommit,
        runBranch: this.transaction.runBranch,
        worktreePath: this.transaction.worktreePath,
        checkpoints: [],
      };
      await store.save("git-transaction-created");
    }
    const lifecycle = new RunLifecycle(this.graph, store.state);
    const advisor = new PassiveAdvisor(this.graph, this.executionRoot, this.adapters, {
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      ...(this.options.verbose === undefined ? {} : { verbose: this.options.verbose }),
      onProgress: (event) => this.emitProgress(event),
    });
    await store.appendEvent({ at: new Date().toISOString(), ...lifecycle.resumeRun() });
    while (true) {
      if (this.options.signal?.aborted) return this.cancelRun(store);
      if (lifecycle.acceptApprovedGates()) await store.save("approved-gates");
      if (lifecycle.attentionRequired()) {
        const event = lifecycle.requireAttention();
        await store.save("needs-attention");
        await store.appendEvent({ at: new Date().toISOString(), ...event });
        await writeRunReport(store, this.graph);
        this.emitProgress({ type: "run_needs_attention" });
        return store.state;
      }
      const gate = lifecycle.readyUnapprovedGate();
      if (gate) {
        const event = lifecycle.awaitApproval(gate.id);
        await store.appendEvent({
          at: new Date().toISOString(),
          ...event,
        });
        await store.save("awaiting-approval");
        await writeRunReport(store, this.graph);
        this.emitProgress({
          type: "approval_required",
          nodeId: gate.id,
          detail: gate.target ?? gate.prompt ?? "human approval",
        });
        return store.state;
      }

      const ready = lifecycle.readyNodes().filter(
        (node) => node.type !== "human_gate",
      );
      if (ready.length === 0) {
        const terminalEvent = lifecycle.finishWhenIdle();
        await this.drainEventWrites();
        await store.save("terminal");
        await store.appendEvent({ at: new Date().toISOString(), ...terminalEvent });
        await writeRunReport(store, this.graph);
        if (terminalEvent.type === "run_completed" && this.transaction && store.state.git) {
          const result = await this.transaction.finalize(store.runDirectory, store.state);
          store.state.git.resultId = result.resultId;
          store.state.git.resultCommit = result.resultCommit;
          await store.save("run-result-created");
          await writeRunReport(store, this.graph);
        }
        this.emitProgress({ type: terminalEvent.type });
        return store.state;
      }

      let waveBaseline: GitChangeSnapshot;
      try {
        waveBaseline = await gitChangeSnapshot(this.executionRoot, this.options.signal);
      } catch (error) {
        if (!this.options.signal?.aborted) throw error;
        return this.cancelRun(store);
      }
      for (const node of ready) {
        this.latestNodeProgress.delete(node.id);
        const event = lifecycle.startNode(node.id);
        await store.appendEvent({
          at: new Date().toISOString(),
          ...event,
        });
        this.emitProgress({
          type: "node_started",
          nodeId: node.id,
          detail: event.detail,
        });
      }
      await store.save("wave-started");

      const waveStartedAt = Date.now();
      const activeNodeIds = new Set(ready.map((node) => node.id));
      const waveController = new AbortController();
      const forwardExternalAbort = (): void => waveController.abort();
      this.options.signal?.addEventListener("abort", forwardExternalAbort, { once: true });
      if (this.options.signal?.aborted) forwardExternalAbort();
      let waveAttentionObserved = false;
      const heartbeat = setInterval(() => {
        this.emitProgress({
          type: "heartbeat",
          activeNodeIds: [...activeNodeIds],
          elapsedMs: Date.now() - waveStartedAt,
          latestNodeProgress: Object.fromEntries(
            [...activeNodeIds].flatMap((nodeId) => {
              const progress = this.latestNodeProgress.get(nodeId);
              return progress ? [[nodeId, progress]] : [];
            }),
          ),
        });
      }, Math.max(25, this.options.heartbeatMs ?? (this.options.verbose ? 5_000 : 10_000)));
      let outcomes: NodeOutcome[];
      try {
        outcomes = await Promise.all(
          ready.map(async (node) => {
            try {
              const outcome = await this.executeNode(node, store, waveController.signal);
              if (outcomeRequiresAttention(outcome)) {
                waveAttentionObserved = true;
                waveController.abort();
              } else if (waveAttentionObserved) {
                outcome.retryBlocked = true;
                outcome.error ??= "node completed after another node required operator attention; reconcile partial effects before agr retry";
              }
              return outcome;
            } finally {
              activeNodeIds.delete(node.id);
            }
          }),
        );
      } finally {
        clearInterval(heartbeat);
        this.options.signal?.removeEventListener("abort", forwardExternalAbort);
      }
      if (this.options.signal?.aborted) return this.cancelRun(store, outcomes);
      const waveOwnership = [
        ".agent-graph/**",
        ...ready.flatMap((node) => [...node.owns, ...(node.implicitOutputs ?? [])]),
      ];
      let escapedPaths: string[] = [];
      let waveChangedPaths: string[] = [];
      try {
        [escapedPaths, waveChangedPaths] = await Promise.all([
          findUnexpectedChanges(this.executionRoot, waveBaseline, waveOwnership, this.options.signal),
          findUnexpectedChanges(this.executionRoot, waveBaseline, [], this.options.signal),
        ]);
      } catch (error) {
        escapedPaths = [`<ownership inspection failed: ${messageOf(error)}>`];
      }
      if (this.options.signal?.aborted) return this.cancelRun(store, outcomes);

      if (this.transaction && escapedPaths.length > 0) {
        for (const outcome of outcomes) outcome.retryBlocked = true;
      }
      if (this.transaction) {
        for (const outcome of outcomes) {
          const ownership = [...outcome.node.owns, ...(outcome.node.implicitOutputs ?? [])];
          if (waveChangedPaths.some((path) => ownership.some((pattern) => matchesGlob(path, pattern)))) {
            outcome.retryBlocked = true;
          }
        }
      }

      for (const outcome of outcomes) {
        await this.acceptOutcome(outcome, escapedPaths, store);
      }
      await store.save("wave-finished");
      if (this.transaction && store.state.git) {
        const checkpointedAttempts = new Set(
          store.state.git.checkpoints.flatMap((checkpoint) => checkpoint.acceptedAttemptIds),
        );
        const acceptedNodes = this.graph.nodes.filter((node) => {
          const attemptId = store.state.nodes[node.id]?.acceptedAttemptId;
          return attemptId && !checkpointedAttempts.has(attemptId);
        });
        const acceptedAttemptIds = acceptedNodes.flatMap((node) => {
          const attemptId = store.state.nodes[node.id]?.acceptedAttemptId;
          return attemptId ? [attemptId] : [];
        });
        if (acceptedAttemptIds.length > 0) {
          const checkpoint = await this.transaction.checkpoint(
            store.state.activePlanRevisionId,
            acceptedAttemptIds,
            digestAcceptedEvidence(store.state),
            acceptedNodes.flatMap((node) => [...node.owns, ...(node.implicitOutputs ?? [])]),
          );
          if (!store.state.git.checkpoints.some((item) => item.checkpointId === checkpoint.checkpointId)) {
            store.state.git.checkpoints.push(checkpoint);
            await store.save("checkpoint-created");
          }
        }
      }
      await advisor.reviewWave(store);
    }
  }

  private async executeNode(
    node: GraphNodeDefinition,
    store: RunStore,
    signal: AbortSignal = this.options.signal ?? new AbortController().signal,
  ): Promise<NodeOutcome> {
    const timeoutMs = node.timeoutMs ?? 20 * 60_000;
    const codeContext = this.graph.run.codeGraph
      ? await buildCodeContext(node, this.executionRoot, this.options.codeGraphCommand ?? "codegraph", signal)
      : { available: false, text: "", sources: [] as string[] };
    const prompt = buildPrompt(
      this.graph,
      node,
      codeContext.text,
      codeContext.sources,
      store.state.advisor?.latest,
    );
    const promptPath = join(
      store.promptsDirectory,
      `${node.id}-attempt-${currentAttemptId(store.state, node.id)}.md`,
    );
    await writeFile(promptPath, prompt, "utf8");

    let externalDispatchStarted = false;
    try {
      if (node.type === "verify") {
        const checks = await runChecks(this.executionRoot, node.checks, timeoutMs, signal);
        return { node, prompt, checks, retryBlocked: checks.some((check) => Boolean(check.terminationError)) };
      }
      if (node.type === "external_action") {
        new RunLifecycle(this.graph, store.state).assertExternalActionAuthorized(node.id);
        await verifyRunEvidenceArtifacts(store.runDirectory, store.state);
        evaluateMandate(this.graph, store.state, node.id);
        const attemptId = currentAttemptId(store.state, node.id);
        const receipt = requireUsableReceipt(
          this.graph,
          store.state,
          node.id,
          await repositoryFingerprint(this.executionRoot),
        );
        const reservation = reserveApproval(store.state, receipt, attemptId);
        await store.appendEvent({
          at: reservation.reservedAt,
          type: "approval_reserved",
          nodeId: node.id,
          detail: reservation.reservationId,
        });
        await store.save("approval-reserved");
        const consumption = consumeReservation(store.state, reservation);
        await store.appendEvent({
          at: consumption.consumedAt,
          type: "approval_consumed",
          nodeId: node.id,
          detail: consumption.reservationId,
        });
        await store.save("approval-consumed");
        externalDispatchStarted = true;
      }
      if (node.executor === "shell") {
        const checks = await runChecks(this.executionRoot, node.checks, timeoutMs, signal);
        return { node, prompt, checks, retryBlocked: checks.some((check) => Boolean(check.terminationError)), externalDispatchStarted };
      }
      const adapter = node.executor ? this.adapters[node.executor] : undefined;
      if (!adapter) throw new Error(`executor "${node.executor ?? "none"}" is unavailable`);
      const progressChannel = await createNodeProgressChannel(
        this.graph.run.id,
        node.id,
        async (milestone) => {
          this.latestNodeProgress.set(node.id, milestone);
          this.emitProgress({
            type: "node_progress",
            nodeId: node.id,
            phase: milestone.phase,
            detail: milestone.message,
            ...(milestone.percent === undefined ? {} : { percent: milestone.percent }),
          });
          await store.appendEvent({
            at: milestone.at,
            type: "node_progress",
            nodeId: node.id,
            phase: milestone.phase,
            detail: milestone.message,
            ...(milestone.percent === undefined ? {} : { percent: milestone.percent }),
          });
        },
      ).catch(() => undefined);
      let adapterResult: AdapterResult;
      try {
        adapterResult = await adapter.execute({
          node,
          repositoryRoot: this.executionRoot,
          prompt,
          artifactsDirectory: join(
            store.outputsDirectory,
            `${node.id}-attempt-${currentAttemptId(store.state, node.id)}`,
          ),
          timeoutMs,
          signal,
          ...(progressChannel ? { environment: progressChannel.environment } : {}),
          activityVerbosity: this.options.verbose ? "verbose" : "normal",
          onActivity: (summary) => this.emitDurableProgress(store, {
              type: "node_activity",
              nodeId: node.id,
              detail: summary,
            }),
        });
      } finally {
        await progressChannel?.close().catch(() => undefined);
      }
      const checks = await runChecks(this.executionRoot, node.checks, timeoutMs, signal);
      return { node, prompt, adapterResult, checks, retryBlocked: checks.some((check) => Boolean(check.terminationError)), externalDispatchStarted };
    } catch (error) {
      return {
        node,
        prompt,
        checks: [],
        error: messageOf(error),
        aborted: error instanceof Error && error.name === "AbortError",
        retryBlocked: error instanceof NonRetryableAdapterError,
        externalDispatchStarted,
      };
    }
  }

  private async acceptOutcome(
    outcome: NodeOutcome,
    waveEscapedPaths: string[],
    store: RunStore,
  ): Promise<void> {
    const nodeState = store.state.nodes[outcome.node.id]!;
    const ownership = [...outcome.node.owns, ...(outcome.node.implicitOutputs ?? [])];
    const claimedEscapes = (outcome.adapterResult?.handoff.changedFiles ?? []).filter(
      (file) => !ownership.some((pattern) => matchesGlob(file, pattern)),
    );
    const failedChecks = outcome.checks.filter((check) => check.exitCode !== 0);
    const modelUsageFailures = requiredModelUsageFailures(
      outcome.node,
      outcome.adapterResult,
    );
    const requiresAgentHandoff =
      ["agent", "review"].includes(outcome.node.type) ||
      (outcome.node.type === "external_action" && outcome.node.executor !== "shell");
    const handoffFailure = requiresAgentHandoff && !outcome.error && outcome.adapterResult?.handoff.status !== "complete"
      ? `agent status ${outcome.adapterResult?.handoff.status ?? "missing"}`
      : undefined;
    const semanticAttention = outcome.adapterResult?.handoff.status === "partial" ||
      outcome.adapterResult?.handoff.status === "blocked";
    const failures = [
      outcome.error,
      handoffFailure,
      waveEscapedPaths.length > 0 ? `unexpected changed paths: ${waveEscapedPaths.join(", ")}` : undefined,
      claimedEscapes.length > 0 ? `handoff paths outside ownership: ${claimedEscapes.join(", ")}` : undefined,
      failedChecks.length > 0
        ? `failed checks: ${failedChecks.map((check) => check.command).join(", ")}`
        : undefined,
      ...outcome.checks.flatMap((check) => check.terminationError ? [`unconfirmed check process-tree termination: ${check.terminationError}`] : []),
      ...modelUsageFailures,
    ].filter((value): value is string => Boolean(value));
    const retryBlocked = failures.length > 0 && Boolean(
      outcome.retryBlocked || semanticAttention ||
      (outcome.node.type === "external_action" && outcome.externalDispatchStarted && failures.length > 0),
    );

    const attemptId = currentAttemptId(store.state, outcome.node.id);
    const attempt = store.state.attempts[attemptId]!;
    const evidencePath = join(store.evidenceDirectory, `${outcome.node.id}-attempt-${attemptId}.json`);
    const evidenceRaw = `${JSON.stringify(
        {
          schemaVersion: 1,
          nodeId: outcome.node.id,
          attemptId,
          ordinal: attempt.ordinal,
          generation: attempt.generation,
          executor: outcome.node.executor ?? "runtime",
          handoff: outcome.adapterResult?.handoff ?? null,
          agentProcess: outcome.adapterResult
            ? { exitCode: outcome.adapterResult.exitCode }
            : null,
          modelUsage: outcome.adapterResult?.modelUsage ?? null,
          retryBlocked,
          checks: outcome.checks,
          ownership: { declared: ownership, waveEscapedPaths, claimedEscapes },
          failures,
        },
        null,
        2,
      )}\n`;
    await writeFile(evidencePath, evidenceRaw, "utf8");
    const relativeEvidencePath = relative(store.runDirectory, evidencePath).replaceAll("\\", "/");
    const evidenceHash = sha256(evidenceRaw);
    attempt.evidence.push({
      schemaVersion: 1,
      artifactId: `artifact-${evidenceHash.slice(0, 24)}`,
      kind: "attempt-evidence",
      sha256: evidenceHash,
      size: Buffer.byteLength(evidenceRaw),
      producerAttemptId: attemptId,
      localPath: relativeEvidencePath,
    });
    nodeState.evidenceFiles.push(relativeEvidencePath);
    if (failures.length === 0) {
      const event = new RunLifecycle(this.graph, store.state).acceptNode(outcome.node.id);
      await store.appendEvent({
        at: new Date().toISOString(),
        ...event,
      });
      this.emitProgress({ type: "node_accepted", nodeId: outcome.node.id });
    } else {
      const event = new RunLifecycle(this.graph, store.state).failNode(
        outcome.node.id,
        failures.join("; "),
        retryBlocked,
      );
      await store.appendEvent({
        at: new Date().toISOString(),
        ...event,
      });
      this.emitProgress({
        type: "node_failed",
        nodeId: outcome.node.id,
      });
    }
  }

  private emitProgress(event: Omit<RunProgressEvent, "at" | "runId">): void {
    try {
      this.options.onProgress?.({
        at: new Date().toISOString(),
        runId: this.graph.run.id,
        ...event,
      });
    } catch {
      // Progress rendering is observational and cannot alter execution.
    }
  }

  private emitDurableProgress(
    store: RunStore,
    event: Omit<RunProgressEvent, "at" | "runId" | "type"> & {
      type: Exclude<RunProgressEvent["type"], "heartbeat">;
    },
  ): void {
    const at = new Date().toISOString();
    const write = store.appendEvent({ at, ...event });
    this.pendingEventWrites.add(write);
    void write.finally(() => this.pendingEventWrites.delete(write)).catch(() => undefined);
    this.emitProgress(event);
  }

  private async drainEventWrites(): Promise<void> {
    await Promise.allSettled([...this.pendingEventWrites]);
  }

  private async cancelRun(store: RunStore, outcomes: NodeOutcome[] = []): Promise<RunState> {
    const byNode = new Map(outcomes.map((outcome) => [outcome.node.id, outcome]));
    const lifecycle = new RunLifecycle(this.graph, store.state);
    for (const [nodeId, node] of Object.entries(store.state.nodes)) {
      if (node.status !== "running") continue;
      const outcome = byNode.get(nodeId);
      if (outcome) {
        const attemptId = currentAttemptId(store.state, nodeId);
        const attempt = store.state.attempts[attemptId]!;
        const evidencePath = join(store.evidenceDirectory, `${nodeId}-attempt-${attemptId}.json`);
        const evidenceRaw = `${JSON.stringify({
            schemaVersion: 1,
            nodeId,
            attemptId,
            ordinal: attempt.ordinal,
            generation: attempt.generation,
            executor: outcome.node.executor ?? "runtime",
            handoff: outcome.adapterResult?.handoff ?? null,
            agentProcess: outcome.adapterResult ? { exitCode: outcome.adapterResult.exitCode } : null,
            modelUsage: outcome.adapterResult?.modelUsage ?? null,
            retryBlocked: true,
            checks: outcome.checks,
            ownership: {
              declared: [...outcome.node.owns, ...(outcome.node.implicitOutputs ?? [])],
              waveEscapedPaths: [],
              claimedEscapes: [],
            },
            failures: ["cancelled during execution; partial effects require reconciliation"],
          }, null, 2)}\n`;
        await writeFile(evidencePath, evidenceRaw, "utf8");
        const relativeEvidencePath = relative(store.runDirectory, evidencePath).replaceAll("\\", "/");
        const evidenceHash = sha256(evidenceRaw);
        if (!attempt.evidence.some((reference) => reference.localPath === relativeEvidencePath)) {
          attempt.evidence.push({
            schemaVersion: 1,
            artifactId: `artifact-${evidenceHash.slice(0, 24)}`,
            kind: "attempt-evidence",
            sha256: evidenceHash,
            size: Buffer.byteLength(evidenceRaw),
            producerAttemptId: attemptId,
            localPath: relativeEvidencePath,
          });
        }
        if (!node.evidenceFiles.includes(relativeEvidencePath)) node.evidenceFiles.push(relativeEvidencePath);
      }
      const event = lifecycle.interruptNode(nodeId, Boolean(outcome?.retryBlocked));
      await store.appendEvent({
        at: new Date().toISOString(),
        ...event,
      });
    }
    const runEvent = lifecycle.cancelRun();
    await store.appendEvent({ at: new Date().toISOString(), ...runEvent });
    await store.save("cancelled");
    await writeRunReport(store, this.graph);
    this.emitProgress({ type: "run_cancelled" });
    return store.state;
  }

}

function outcomeRequiresAttention(outcome: NodeOutcome): boolean {
  const status = outcome.adapterResult?.handoff.status;
  return Boolean(outcome.retryBlocked || status === "partial" || status === "blocked");
}

function currentAttemptId(state: RunState, nodeId: string): string {
  const attemptId = state.nodes[nodeId]?.currentAttemptId;
  if (!attemptId || !state.attempts[attemptId]) {
    throw new Error(`node "${nodeId}" has no current attempt identity`);
  }
  return attemptId;
}

function requiredModelUsageFailures(
  node: GraphNodeDefinition,
  result: AdapterResult | undefined,
): string[] {
  const failures: string[] = [];
  for (const required of node.requiredModelUsage ?? []) {
    const observed = result?.modelUsage?.[required.model];
    if (!observed) {
      failures.push(`missing required model usage: ${required.model}`);
      continue;
    }
    if (observed.canonicalModel !== required.model) {
      failures.push(
        `model ${required.model} canonical model ${observed.canonicalModel ?? "missing"} does not match ${required.model}`,
      );
    }
    if (observed.provider !== required.provider) {
      failures.push(
        `model ${required.model} provider ${observed.provider ?? "missing"} does not match ${required.provider}`,
      );
    }
    if (observed.contextWindow !== required.contextWindow) {
      failures.push(
        `model ${required.model} context window ${observed.contextWindow ?? "missing"} does not match ${required.contextWindow}`,
      );
    }
  }
  return failures;
}

function buildPrompt(
  graph: GraphDefinition,
  node: GraphNodeDefinition,
  context: string,
  sources: string[],
  advisor?: AdvisorObservation,
): string {
  return `# Agent Graph node ${node.id}

Objective: ${graph.run.objective}
Node task: ${node.prompt ?? node.id}
Node type: ${node.type}
Owned paths: ${node.owns.join(", ") || "none (read-only)"}
Implicit outputs: ${(node.implicitOutputs ?? []).join(", ") || "none"}

Constraints:
- Work only in the supplied repository and preserve pre-existing changes.
- Do not push, deploy, send messages, delete user data, or perform another external action.
- Do not edit paths outside ownership. A review node is behaviorally read-only.
- This node is the orchestration boundary. Do not launch Workflow, Task, subagents, or another agent executor. Finish the work directly before returning.
- Run useful focused checks, but the parent runtime will rerun configured checks.
- Report meaningful milestones best-effort with \`agr progress --phase inspect|implement|verify|evidence|blocked --message "short operator-safe update" [--percent 0-100]\`. Report only milestones, never prompts, reasoning, secrets, commands, or raw output; reporter failure does not change the task.
- Return only the requested structured handoff. Claims are not acceptance evidence.

Context sources: ${sources.join(", ") || "targeted repository inspection required"}
${context ? `\n${context}\n` : ""}
${advisor ? `\nNon-authoritative advisor ${advisor.severity}: ${advisor.summary}\n` : ""}
Required handoff fields: status, summary, changedFiles, verification, gaps.
`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
