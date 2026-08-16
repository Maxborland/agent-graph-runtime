import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { NonRetryableAdapterError, type AgentAdapter } from "./adapters.js";
import { findUnexpectedChanges, gitChangeSnapshot, type GitChangeSnapshot } from "./repository.js";
import { RunObserver } from "./observation.js";
import { RunStore } from "./store.js";
import type {
  AdapterResult,
  AdvisorObservation,
  AdvisorSeverity,
  ExecutorName,
  GraphDefinition,
  GraphNodeDefinition,
  RunEvent,
  RunState,
} from "./types.js";

type AdvisorAdapters = Partial<Record<Exclude<ExecutorName, "shell">, AgentAdapter>>;

export interface AdvisorRuntimeEvent {
  type: "node_activity" | "advisor_note" | "advisor_failed";
  nodeId: string;
  detail?: string;
  severity?: AdvisorSeverity;
}

export interface PassiveAdvisorOptions {
  signal?: AbortSignal;
  verbose?: boolean;
  onProgress?: (event: AdvisorRuntimeEvent) => void;
}

export class PassiveAdvisor {
  constructor(
    private readonly graph: GraphDefinition,
    private readonly repositoryRoot: string,
    private readonly adapters: AdvisorAdapters,
    private readonly options: PassiveAdvisorOptions = {},
  ) {}

  async reviewWave(store: RunStore): Promise<void> {
    const definition = this.graph.run.advisor;
    if (!definition) return;
    store.state.advisor ??= {};
    const wave = Math.max(
      store.state.advisor.lastSequence ?? 0,
      store.state.advisor.latest?.wave ?? 0,
    ) + 1;
    store.state.advisor.lastSequence = wave;
    await store.save("advisor-started");
    const adapter = this.adapters[definition.executor];
    const advisorId = `__advisor-wave-${wave}`;
    if (!adapter) {
      await store.appendEvent({
        at: new Date().toISOString(),
        type: "advisor_failed",
        nodeId: advisorId,
        detail: `advisor executor "${definition.executor}" is unavailable`,
      });
      this.options.onProgress?.({
        type: "advisor_failed",
        nodeId: advisorId,
        detail: `advisor executor "${definition.executor}" is unavailable`,
      });
      return;
    }
    const node: GraphNodeDefinition = {
      id: advisorId,
      type: "review",
      executor: definition.executor,
      prompt: definition.instructions ?? "Passively review the completed wave for risks, contradictions, and missing evidence.",
      needs: [],
      owns: [],
      checks: [],
      maxAttempts: 1,
      ...(definition.model === undefined ? {} : { model: definition.model }),
    };
    let recentEvents: RunEvent[];
    try {
      recentEvents = await new RunObserver(this.repositoryRoot, this.graph.run.id).recent(50);
    } catch (error) {
      await this.recordFailure(store, advisorId, wave, `advisor event context failed: ${messageOf(error)}`, true);
      return;
    }
    const prompt = buildAdvisorPrompt(this.graph, node, store.state, wave, recentEvents, definition.instructions);
    await writeFile(join(store.promptsDirectory, `${advisorId}.md`), prompt, "utf8");
    let baseline: GitChangeSnapshot;
    try {
      baseline = await gitChangeSnapshot(this.repositoryRoot, this.options.signal);
    } catch (error) {
      await this.recordFailure(store, advisorId, wave, `advisor ownership baseline failed: ${messageOf(error)}`, true);
      return;
    }
    const pendingActivity = new Set<Promise<unknown>>();
    let result: AdapterResult;
    try {
      result = await adapter.execute({
        node,
        repositoryRoot: this.repositoryRoot,
        prompt,
        artifactsDirectory: join(store.outputsDirectory, advisorId),
        timeoutMs: 20 * 60_000,
        ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
        activityVerbosity: this.options.verbose ? "verbose" : "normal",
        onActivity: (summary) => {
          const at = new Date().toISOString();
          const write = store.appendEvent({ at, type: "node_activity", nodeId: advisorId, detail: summary });
          pendingActivity.add(write);
          void write.finally(() => pendingActivity.delete(write)).catch(() => undefined);
          this.options.onProgress?.({ type: "node_activity", nodeId: advisorId, detail: summary });
        },
      });
    } catch (error) {
      await Promise.allSettled([...pendingActivity]);
      await this.recordFailure(store, advisorId, wave, messageOf(error), error instanceof NonRetryableAdapterError);
      return;
    }
    await Promise.allSettled([...pendingActivity]);
    let escapedPaths: string[];
    try {
      escapedPaths = await findUnexpectedChanges(this.repositoryRoot, baseline, [".agent-graph/**"], this.options.signal);
    } catch (error) {
      escapedPaths = [`<advisor ownership inspection failed: ${messageOf(error)}>`];
    }
    const safetyFailures = [
      ...(result.handoff.changedFiles.length > 0
        ? [`advisor claimed changed paths: ${result.handoff.changedFiles.join(", ")}`]
        : []),
      ...(escapedPaths.length > 0 ? [`advisor changed paths outside .agent-graph/**: ${escapedPaths.join(", ")}`] : []),
    ];
    const severity = safetyFailures.length > 0
      ? "blocker"
      : result.handoff.status === "blocked"
        ? "blocker"
        : result.handoff.status === "partial"
          ? "concern"
          : "note";
    const evidencePath = join(store.evidenceDirectory, `advisor-wave-${wave}.json`);
    await writeFile(evidencePath, `${JSON.stringify({
      advisorId,
      wave,
      executor: definition.executor,
      severity,
      handoff: result.handoff,
      modelUsage: result.modelUsage ?? null,
      ownership: { declared: [], escapedPaths },
      failures: safetyFailures,
    }, null, 2)}\n`, "utf8");
    const observation: AdvisorObservation = {
      id: advisorId,
      wave,
      at: new Date().toISOString(),
      severity,
      summary: (safetyFailures.join("; ") || result.handoff.summary).slice(0, 1_000),
      evidenceFile: relative(store.runDirectory, evidencePath).replaceAll("\\", "/"),
    };
    store.state.advisor.latest = observation;
    if (severity === "blocker" && (safetyFailures.length > 0 || definition.stopOnBlocker !== false)) {
      store.state.advisor.blocker = observation;
    }
    await store.appendEvent({
      at: observation.at,
      type: "advisor_note",
      nodeId: advisorId,
      detail: observation.summary,
      severity,
      evidenceFile: observation.evidenceFile,
    });
    this.options.onProgress?.({
      type: "advisor_note",
      nodeId: advisorId,
      detail: observation.summary,
      severity,
    });
    await store.save("advisor-finished");
  }

  private async recordFailure(
    store: RunStore,
    advisorId: string,
    wave: number,
    detail: string,
    blocker: boolean,
  ): Promise<void> {
    const evidencePath = join(store.evidenceDirectory, `advisor-wave-${wave}.json`);
    await writeFile(evidencePath, `${JSON.stringify({ advisorId, wave, failures: [detail], blocker }, null, 2)}\n`, "utf8");
    const at = new Date().toISOString();
    const safeSummary = blocker
      ? "advisor process safety could not be confirmed; inspect evidence"
      : "advisor execution failed; inspect evidence";
    await store.appendEvent({
      at,
      type: "advisor_failed",
      nodeId: advisorId,
      detail: safeSummary,
      evidenceFile: relative(store.runDirectory, evidencePath).replaceAll("\\", "/"),
    });
    this.options.onProgress?.({ type: "advisor_failed", nodeId: advisorId, detail: safeSummary });
    if (blocker) {
      const observation: AdvisorObservation = {
        id: advisorId,
        wave,
        at,
        severity: "blocker",
        summary: detail.slice(0, 1_000),
        evidenceFile: relative(store.runDirectory, evidencePath).replaceAll("\\", "/"),
      };
      store.state.advisor ??= {};
      store.state.advisor.latest = observation;
      store.state.advisor.blocker = observation;
      await store.save("advisor-failed-blocking");
    }
  }
}

function buildAdvisorPrompt(
  graph: GraphDefinition,
  node: GraphNodeDefinition,
  state: RunState,
  wave: number,
  recentEvents: RunEvent[],
  instructions?: string,
): string {
  return `# Agent Graph passive advisor ${node.id}

Objective: ${graph.run.objective}
Completed wave: ${wave}
Specialization: ${instructions ?? "Review architecture, safety, contradictions, and evidence quality."}

Current node state:
${JSON.stringify(Object.fromEntries(Object.entries(state.nodes).map(([id, value]) => [id, {
  status: value.status,
  attempts: value.attempts,
  retryBlocked: value.retryBlocked ?? false,
  lastError: value.lastError?.slice(0, 1_000) ?? null,
  evidenceFiles: value.evidenceFiles,
}])), null, 2)}

Recent safe runtime events (oldest to newest, maximum 50):
${JSON.stringify(recentEvents.map((event) => ({
  seq: event.seq,
  at: event.at,
  type: event.type,
  ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
  ...(event.detail === undefined ? {} : { detail: event.detail }),
  ...(event.phase === undefined ? {} : { phase: event.phase }),
  ...(event.percent === undefined ? {} : { percent: event.percent }),
  ...(event.severity === undefined ? {} : { severity: event.severity }),
  ...(event.evidenceFile === undefined ? {} : { evidenceFile: event.evidenceFile }),
})), null, 2)}

Constraints:
- You are a passive independent advisor, not an executor or peer.
- Remain read-only. Do not edit, write, run Bash, launch Workflow/Task/subagents, approve, retry, cancel, deploy, push, or message externally.
- Inspect only as needed to identify a quiet note, material concern, or hard blocker.
- Use status complete for a note, partial for a concern, and blocked only for a hard blocker that should stop the next wave.
- Return only the structured handoff with changedFiles empty. Put the concise advice in summary and supporting concerns in gaps.
`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
