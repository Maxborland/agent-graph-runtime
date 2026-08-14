import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { AgentAdapter } from "./adapters.js";
import { runChecks, type CheckResult } from "./checks.js";
import { buildCodeContext } from "./context.js";
import { validateGraph } from "./graph.js";
import { findUnexpectedChanges, gitChangedFiles, matchesGlob } from "./repository.js";
import { writeRunReport } from "./report.js";
import { selectReadyNodes } from "./state.js";
import { RunStore } from "./store.js";
import type {
  AdapterResult,
  GraphDefinition,
  GraphNodeDefinition,
  RunState,
} from "./types.js";

type AgentAdapters = Partial<Record<"codex" | "claude", AgentAdapter>>;

interface NodeOutcome {
  node: GraphNodeDefinition;
  prompt: string;
  adapterResult?: AdapterResult;
  checks: CheckResult[];
  error?: string;
}

export class GraphRunner {
  constructor(
    private readonly graph: GraphDefinition,
    private readonly repositoryRoot: string,
    private readonly adapters: AgentAdapters,
    private readonly codeGraphCommand = "codegraph",
  ) {}

  async run(): Promise<RunState> {
    const validation = validateGraph(this.graph);
    if (validation.errors.length > 0) {
      throw new Error(`Invalid graph:\n- ${validation.errors.join("\n- ")}`);
    }
    const currentBaseline = await gitChangedFiles(this.repositoryRoot);
    const store = await RunStore.open(this.repositoryRoot, this.graph, currentBaseline);
    store.state.status = "running";

    while (true) {
      if (this.acceptApprovedGates(store.state)) await store.save("approved-gates");
      const gate = this.findReadyUnapprovedGate(store.state);
      if (gate) {
        store.state.nodes[gate.id]!.status = "awaiting_approval";
        store.state.status = "awaiting_approval";
        await store.appendEvent({
          at: new Date().toISOString(),
          type: "approval_required",
          nodeId: gate.id,
          detail: gate.target ?? gate.prompt ?? "human approval",
        });
        await store.save("awaiting-approval");
        await writeRunReport(store, this.graph);
        return store.state;
      }

      const ready = selectReadyNodes(this.graph, store.state).filter(
        (node) => node.type !== "human_gate",
      );
      if (ready.length === 0) {
        if (this.graph.nodes.every((node) => store.state.nodes[node.id]?.status === "accepted")) {
          store.state.status = "completed";
        } else {
          this.blockUnreachableNodes(store.state);
          store.state.status = "failed";
        }
        await store.save("terminal");
        await writeRunReport(store, this.graph);
        return store.state;
      }

      const waveBaseline = await gitChangedFiles(this.repositoryRoot);
      for (const node of ready) {
        const nodeState = store.state.nodes[node.id]!;
        nodeState.status = "running";
        nodeState.attempts += 1;
        delete nodeState.lastError;
        await store.appendEvent({
          at: new Date().toISOString(),
          type: "node_started",
          nodeId: node.id,
          detail: `attempt ${nodeState.attempts}`,
        });
      }
      await store.save("wave-started");

      const outcomes = await Promise.all(ready.map((node) => this.executeNode(node, store)));
      const waveOwnership = [
        ".agent-graph/**",
        ...ready.flatMap((node) => [...node.owns, ...(node.implicitOutputs ?? [])]),
      ];
      let escapedPaths: string[] = [];
      try {
        escapedPaths = await findUnexpectedChanges(
          this.repositoryRoot,
          waveBaseline,
          waveOwnership,
        );
      } catch (error) {
        escapedPaths = [`<ownership inspection failed: ${messageOf(error)}>`];
      }

      for (const outcome of outcomes) {
        await this.acceptOutcome(outcome, escapedPaths, store);
      }
      await store.save("wave-finished");
    }
  }

  private async executeNode(node: GraphNodeDefinition, store: RunStore): Promise<NodeOutcome> {
    const timeoutMs = node.timeoutMs ?? 20 * 60_000;
    const codeContext = this.graph.run.codeGraph
      ? await buildCodeContext(node, this.repositoryRoot, this.codeGraphCommand)
      : { available: false, text: "", sources: [] as string[] };
    const prompt = buildPrompt(this.graph, node, codeContext.text, codeContext.sources);
    const promptPath = join(
      store.promptsDirectory,
      `${node.id}-attempt-${store.state.nodes[node.id]!.attempts}.md`,
    );
    await writeFile(promptPath, prompt, "utf8");

    try {
      if (node.type === "verify") {
        return { node, prompt, checks: await runChecks(this.repositoryRoot, node.checks, timeoutMs) };
      }
      if (node.type === "external_action") this.assertExternalActionAuthorized(node, store.state);
      if (node.executor === "shell") {
        return { node, prompt, checks: await runChecks(this.repositoryRoot, node.checks, timeoutMs) };
      }
      const adapter = node.executor ? this.adapters[node.executor] : undefined;
      if (!adapter) throw new Error(`executor "${node.executor ?? "none"}" is unavailable`);
      const adapterResult = await adapter.execute({
        node,
        repositoryRoot: this.repositoryRoot,
        prompt,
        artifactsDirectory: join(
          store.outputsDirectory,
          `${node.id}-attempt-${store.state.nodes[node.id]!.attempts}`,
        ),
        timeoutMs,
      });
      const checks = await runChecks(this.repositoryRoot, node.checks, timeoutMs);
      return { node, prompt, adapterResult, checks };
    } catch (error) {
      return { node, prompt, checks: [], error: messageOf(error) };
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
    const requiresAgentHandoff =
      ["agent", "review"].includes(outcome.node.type) ||
      (outcome.node.type === "external_action" && outcome.node.executor !== "shell");
    const handoffFailure = requiresAgentHandoff && !outcome.error && outcome.adapterResult?.handoff.status !== "complete"
      ? `agent status ${outcome.adapterResult?.handoff.status ?? "missing"}`
      : undefined;
    const failures = [
      outcome.error,
      handoffFailure,
      waveEscapedPaths.length > 0 ? `unexpected changed paths: ${waveEscapedPaths.join(", ")}` : undefined,
      claimedEscapes.length > 0 ? `handoff paths outside ownership: ${claimedEscapes.join(", ")}` : undefined,
      failedChecks.length > 0
        ? `failed checks: ${failedChecks.map((check) => check.command).join(", ")}`
        : undefined,
    ].filter((value): value is string => Boolean(value));

    const attempt = nodeState.attempts;
    const evidencePath = join(store.evidenceDirectory, `${outcome.node.id}-attempt-${attempt}.json`);
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          nodeId: outcome.node.id,
          attempt,
          executor: outcome.node.executor ?? "runtime",
          handoff: outcome.adapterResult?.handoff ?? null,
          agentProcess: outcome.adapterResult
            ? { exitCode: outcome.adapterResult.exitCode }
            : null,
          checks: outcome.checks,
          ownership: { declared: ownership, waveEscapedPaths, claimedEscapes },
          failures,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    nodeState.evidenceFiles.push(relative(store.runDirectory, evidencePath).replaceAll("\\", "/"));
    if (failures.length === 0) {
      nodeState.status = "accepted";
      await store.appendEvent({
        at: new Date().toISOString(),
        type: "node_accepted",
        nodeId: outcome.node.id,
      });
    } else {
      nodeState.status = "failed";
      nodeState.lastError = failures.join("; ");
      await store.appendEvent({
        at: new Date().toISOString(),
        type: "node_failed",
        nodeId: outcome.node.id,
        detail: nodeState.lastError,
      });
    }
  }

  private findReadyUnapprovedGate(state: RunState): GraphNodeDefinition | undefined {
    return this.graph.nodes.find((node) => {
      const nodeState = state.nodes[node.id];
      return (
        node.type === "human_gate" &&
        nodeState?.status !== "accepted" &&
        !nodeState?.approvedTarget &&
        node.needs.every((dependency) => state.nodes[dependency]?.status === "accepted")
      );
    });
  }

  private acceptApprovedGates(state: RunState): boolean {
    let changed = false;
    for (const node of this.graph.nodes.filter((candidate) => candidate.type === "human_gate")) {
      const nodeState = state.nodes[node.id]!;
      if (
        nodeState.approvedTarget &&
        nodeState.approvedTarget === node.target &&
        node.needs.every((dependency) => state.nodes[dependency]?.status === "accepted")
      ) {
        nodeState.status = "accepted";
        changed = true;
      }
    }
    return changed;
  }

  private assertExternalActionAuthorized(node: GraphNodeDefinition, state: RunState): void {
    if (!this.graph.run.allowExternalActions) {
      throw new Error("external actions are disabled for this graph");
    }
    const approved = node.needs.some((dependency) => {
      const dependencyNode = this.graph.nodes.find((candidate) => candidate.id === dependency);
      const dependencyState = state.nodes[dependency];
      return (
        dependencyNode?.type === "human_gate" &&
        dependencyState?.status === "accepted" &&
        dependencyState.approvedTarget === node.target
      );
    });
    if (!approved) throw new Error("external action lacks an approved human gate for its target");
  }

  private blockUnreachableNodes(state: RunState): void {
    for (const node of this.graph.nodes) {
      const nodeState = state.nodes[node.id]!;
      if (["accepted", "failed", "awaiting_approval"].includes(nodeState.status)) continue;
      nodeState.status = "blocked";
      nodeState.lastError = "dependency did not reach accepted state";
    }
  }
}

function buildPrompt(
  graph: GraphDefinition,
  node: GraphNodeDefinition,
  context: string,
  sources: string[],
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
- Run useful focused checks, but the parent runtime will rerun configured checks.
- Return only the requested structured handoff. Claims are not acceptance evidence.

Context sources: ${sources.join(", ") || "targeted repository inspection required"}
${context ? `\n${context}\n` : ""}
Required handoff fields: status, summary, changedFiles, verification, gaps.
`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
