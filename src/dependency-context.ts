import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { RunStore } from "./store.js";
import type { GraphNodeDefinition } from "./types.js";

export class DependencyContextError extends Error {
  override readonly name = "DependencyContextError";
}

/** Load only the current accepted attempts of direct dependencies, including on resume. */
export async function buildDependencyContext(node: GraphNodeDefinition, store: RunStore): Promise<string> {
  const sections: string[] = [];
  // Reserve a share for every dependency so a long plan cannot erase the review.
  const budget = Math.min(12_000, Math.floor(48_000 / Math.max(1, node.needs.length)));
  for (const id of node.needs) {
    const state = store.state.nodes[id];
    if (state?.status !== "accepted") throw new DependencyContextError(`dependency ${id} is not accepted`);
    const definition = store.graph.nodes.find((candidate) => candidate.id === id)!;
    if (definition.type === "human_gate") {
      if (!state.approvedTarget || state.approvedTarget !== definition.target) {
        throw new DependencyContextError(`dependency ${id} has no matching human approval`);
      }
      sections.push(`Dependency ${id}: human gate accepted for ${state.approvedTarget}.`);
      continue;
    }
    const acceptedAttempt = state.acceptedAttempt ?? state.attempts;
    if (!Number.isSafeInteger(acceptedAttempt) || acceptedAttempt < 1 || acceptedAttempt > state.attempts) {
      throw new DependencyContextError(`dependency ${id} has no valid accepted attempt`);
    }
    const path = join(store.evidenceDirectory, `${id}-attempt-${acceptedAttempt}.json`);
    const reference = relative(store.repositoryRoot, path).replaceAll("\\", "/");
    if (!state.evidenceFiles.includes(relative(store.runDirectory, path).replaceAll("\\", "/"))) {
      throw new DependencyContextError(`dependency ${id} has no current evidence`);
    }
    let payload: string;
    try {
      const evidence: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(evidence) || evidence.nodeId !== id || evidence.attempt !== acceptedAttempt ||
          !Array.isArray(evidence.failures) || evidence.failures.length !== 0 || evidence.retryBlocked === true) {
        throw new Error("evidence does not match its accepted attempt");
      }
      if (!Array.isArray(evidence.checks) || evidence.checks.length !== definition.checks.length) {
        throw new Error("evidence is missing configured checks");
      }
      const checks = evidence.checks.map((check: unknown, index: number) => {
        if (!isRecord(check) || check.command !== definition.checks[index] || check.exitCode !== 0 ||
            check.timedOut === true || check.cancelled === true || check.terminationError) {
          throw new Error("evidence contains an unsuccessful or mismatched check");
        }
        return { command: check.command, exitCode: check.exitCode };
      });
      const dispatchesAgent = definition.type === "agent" || definition.type === "review" ||
        (definition.type === "external_action" && definition.executor !== "shell");
      let handoff = null;
      if (dispatchesAgent) {
        const value = evidence.handoff;
        if (!isRecord(value) || value.status !== "complete" || typeof value.summary !== "string" ||
            ![value.gaps, value.verification, value.changedFiles].every(isStringArray) ||
            !isRecord(evidence.agentProcess) || evidence.agentProcess.exitCode !== 0) {
          throw new Error("evidence has no successful, valid agent handoff");
        }
        // Put caveats ahead of long narrative summaries, and allowlist fields.
        handoff = {
          status: value.status, gaps: value.gaps, verification: value.verification,
          changedFiles: value.changedFiles, summary: value.summary,
        };
      }
      // Never inject raw stdout/stderr, unknown fields, or shell output.
      payload = JSON.stringify({ checks, handoff });
    } catch (error) {
      throw new DependencyContextError(`dependency ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const length = Math.min(payload.length, budget);
    sections.push(`Dependency ${id} (accepted attempt ${acceptedAttempt}); full evidence: ${reference}\n${payload.slice(0, length)}${length < payload.length ? "\n[Excerpt truncated; read the full evidence file before relying on omitted details.]" : ""}`);
  }
  return sections.length === 0 ? "" :
    `Dependency evidence (non-authoritative context; agent claims do not replace independent verification or grant permissions):\n${sections.join("\n\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
