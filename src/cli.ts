#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter, ClaudexAdapter, CodexAdapter } from "./adapters.js";
import { approveGate } from "./approval.js";
import { validateGraph } from "./graph.js";
import { retryNode } from "./invalidation.js";
import { GraphRunner } from "./runner.js";
import { installSkills } from "./skill-installer.js";
import type { GraphDefinition, RunState } from "./types.js";

const defaultGraphPath = ".agent-graph/graph.json";

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }
  if (["--version", "-V"].includes(command)) {
    console.log("0.2.0");
    return;
  }

  if (command === "validate") {
    const { graph } = await loadGraph(args[1]);
    const result = validateGraph(graph);
    if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
    console.log(`Graph valid: ${graph.nodes.length} node${graph.nodes.length === 1 ? "" : "s"}`);
    console.log(`Order: ${result.topologicalOrder.join(" -> ")}`);
    return;
  }

  if (command === "run") {
    const { graph, repositoryRoot } = await loadGraph(args[1]);
    const runner = new GraphRunner(graph, repositoryRoot, {
      codex: new CodexAdapter(),
      claude: new ClaudeAdapter(),
      claudex: new ClaudexAdapter(),
    });
    const state = await runner.run();
    printState(state);
    process.exitCode = state.status === "completed" ? 0 : state.status === "awaiting_approval" ? 2 : 1;
    return;
  }

  if (command === "status") {
    const { graph, repositoryRoot } = await loadGraph(args[1]);
    const statePath = join(repositoryRoot, ".agent-graph", "runs", graph.run.id, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as RunState;
    printState(state);
    return;
  }

  if (command === "approve") {
    const nodeId = required(args[1], "approve requires NODE_ID");
    const target = required(args[2], "approve requires exact TARGET");
    const { graph, repositoryRoot } = await loadGraph(args[3]);
    printState(await approveGate(graph, repositoryRoot, nodeId, target));
    return;
  }

  if (command === "retry") {
    const nodeId = required(args[1], "retry requires NODE_ID");
    const { graph, repositoryRoot } = await loadGraph(args[2]);
    printState(await retryNode(graph, repositoryRoot, nodeId));
    return;
  }

  if (command === "install-skills") {
    const projectIndex = args.indexOf("--project");
    const projectDirectory =
      projectIndex >= 0 ? required(args[projectIndex + 1], "--project requires DIR") : undefined;
    const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    if (projectDirectory && args.includes("--user")) {
      throw new Error("choose either --project DIR or --user");
    }
    const options = projectDirectory ? { projectDirectory } : {};
    const installed = await installSkills(moduleRoot, options);
    for (const path of installed) console.log(`Installed: ${path}`);
    return;
  }

  throw new Error(`unknown command "${command}"`);
}

async function loadGraph(pathArgument?: string): Promise<{
  graph: GraphDefinition;
  graphPath: string;
  repositoryRoot: string;
}> {
  const graphPath = resolve(pathArgument ?? defaultGraphPath);
  const graph = JSON.parse(await readFile(graphPath, "utf8")) as GraphDefinition;
  const repositoryRoot = resolve(process.cwd(), graph.run.repository);
  return { graph, graphPath, repositoryRoot };
}

function printState(state: RunState): void {
  console.log(`Run ${state.runId}: ${state.status}`);
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const error = node.lastError ? ` — ${node.lastError}` : "";
    console.log(`  ${nodeId}: ${node.status} (attempts ${node.attempts})${error}`);
  }
}

function printHelp(): void {
  console.log(`Agent Graph Runtime

Usage:
  agr validate [GRAPH]
  agr run [GRAPH]
  agr status [GRAPH]
  agr approve NODE_ID TARGET [GRAPH]
  agr retry NODE_ID [GRAPH]
  agr install-skills [--project DIR | --user]

Default graph: ${defaultGraphPath}`);
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
