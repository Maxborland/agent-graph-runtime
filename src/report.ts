import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunStore } from "./store.js";
import type { GraphDefinition } from "./types.js";

export async function writeRunReport(store: RunStore, graph: GraphDefinition): Promise<string> {
  const lines = [
    `# Agent Graph Run ${store.state.runId}`,
    "",
    "Report schema: 2",
    "",
    `Objective: ${graph.run.objective}`,
    "",
    `Run status: ${store.state.status}`,
    `Updated: ${store.state.updatedAt}`,
    "",
    "| Node | Status | Attempts | Generation | Current attempt | Evidence | Error |",
    "|---|---:|---:|---:|---|---|---|",
  ];
  for (const node of graph.nodes) {
    const state = store.state.nodes[node.id]!;
    lines.push(
      `| ${escapeCell(node.id)} | ${state.status} | ${state.attempts} | ${state.generation} | ${escapeCell(state.currentAttemptId ?? "—")} | ${state.evidenceFiles.map(escapeCell).join("<br>") || "—"} | ${escapeCell(state.lastError ?? "—")} |`,
    );
  }
  lines.push(
    "",
    "## Attempt history",
    "",
    "| Node | Ordinal | Generation | Attempt ID | Status | Evidence |",
    "|---|---:|---:|---|---|---|",
  );
  for (const attempt of Object.values(store.state.attempts).sort(
    (left, right) => left.nodeId.localeCompare(right.nodeId) || left.ordinal - right.ordinal,
  )) {
    lines.push(
      `| ${escapeCell(attempt.nodeId)} | ${attempt.ordinal} | ${attempt.generation} | ${escapeCell(attempt.attemptId)} | ${attempt.status} | ${attempt.evidence.map((item) => escapeCell(item.localPath)).join("<br>") || "—"} |`,
    );
  }
  if (store.state.advisor?.latest) {
    const advisor = store.state.advisor.latest;
    lines.push(
      "",
      `Advisor: ${advisor.severity}${store.state.advisor.blocker ? " (acknowledgement required)" : ""}`,
      `Advisor summary: ${escapeCell(advisor.summary)}`,
      `Advisor evidence: ${escapeCell(advisor.evidenceFile)}`,
    );
  }
  lines.push(
    "",
    "Model handoffs are claims. Acceptance above reflects runtime ownership checks and configured deterministic commands only; user-facing runtime acceptance must be an explicit graph node.",
    "",
  );
  const path = join(store.runDirectory, "report.md");
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
