import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunStore } from "./store.js";
import type { GraphDefinition } from "./types.js";

export async function writeRunReport(store: RunStore, graph: GraphDefinition): Promise<string> {
  const lines = [
    `# Agent Graph Run ${store.state.runId}`,
    "",
    `Objective: ${graph.run.objective}`,
    "",
    `Run status: ${store.state.status}`,
    `Updated: ${store.state.updatedAt}`,
    "",
    "| Node | Status | Attempts | Evidence | Error |",
    "|---|---:|---:|---|---|",
  ];
  for (const node of graph.nodes) {
    const state = store.state.nodes[node.id]!;
    lines.push(
      `| ${escapeCell(node.id)} | ${state.status} | ${state.attempts} | ${state.evidenceFiles.map(escapeCell).join("<br>") || "—"} | ${escapeCell(state.lastError ?? "—")} |`,
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

