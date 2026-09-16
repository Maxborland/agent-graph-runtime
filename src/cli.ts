#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClaudeAdapter, ClaudexAdapter, CodexAdapter } from "./adapters.js";
import { CliError } from "./cli-error.js";
import {
  completionScript,
  diagnoseEnvironment,
  explainNode,
  graphSchema,
  graphToMermaid,
  initializeGraph,
  listRuns,
  readRunEvents,
  readRunLogs,
  readRunState,
  runDirectory,
} from "./cli-tools.js";
import { validateGraph } from "./graph.js";
import { OperatorControl } from "./operator-control.js";
import { buildExecutionPlan } from "./planner.js";
import { GraphRunner, type RunProgressEvent } from "./runner.js";
import { acquireRunLock, inspectRunLock, recoverRunLock } from "./run-lock.js";
import { installSkills } from "./skill-installer.js";
import { sendNodeProgress } from "./node-progress.js";
import { RunObserver } from "./observation.js";
import type { GraphDefinition, RunState } from "./types.js";

const defaultGraphPath = ".agent-graph/graph.json";

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  const json = args.includes("--json");
  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }
  if (args.slice(1).some((argument) => ["--help", "-h"].includes(argument))) {
    printHelp();
    return;
  }
  assertCommandOptions(command, args.slice(1));
  if (["--version", "-V"].includes(command)) {
    console.log("0.6.0");
    return;
  }

  if (command === "progress") {
    const endpoint = process.env.AGR_PROGRESS_ENDPOINT;
    const token = process.env.AGR_PROGRESS_TOKEN;
    const runId = process.env.AGR_RUN_ID;
    const nodeId = process.env.AGR_NODE_ID;
    if (!endpoint || !token || !runId || !nodeId) {
      throw new CliError(
        "agr progress is available only inside an active agent node",
        3,
        "PROGRESS_CHANNEL_MISSING",
      );
    }
    const phase = required(optionValue(args, "--phase"), "progress requires --phase PHASE");
    const message = required(optionValue(args, "--message"), "progress requires --message MESSAGE");
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(phase)) {
      throw new CliError("progress phase must match [a-z][a-z0-9_-] and be at most 32 characters", 3, "INVALID_PROGRESS");
    }
    if (message.length > 240 || /[\r\n\u0000-\u001f\u007f]/.test(message)) {
      throw new CliError("progress message must be one line of at most 240 characters", 3, "INVALID_PROGRESS");
    }
    const rawPercent = optionValue(args, "--percent");
    const percent = rawPercent === undefined ? undefined : Number(rawPercent);
    if (percent !== undefined && (!Number.isInteger(percent) || percent < 0 || percent > 100)) {
      throw new CliError("progress percent must be an integer from 0 to 100", 3, "INVALID_PROGRESS");
    }
    await sendNodeProgress(endpoint, {
      token,
      runId,
      nodeId,
      phase,
      message,
      ...(percent === undefined ? {} : { percent }),
    });
    if (json) console.log(JSON.stringify({ reported: true }));
    else console.log(`Progress reported: ${phase}${percent === undefined ? "" : ` ${percent}%`} — ${message}`);
    return;
  }

  if (command === "validate") {
    const { graph } = await loadGraph(positional(args.slice(1))[0]);
    const result = validateGraph(graph);
    if (result.errors.length > 0) throw new CliError(result.errors.join("\n"), 3, "INVALID_GRAPH");
    if (json) {
      console.log(JSON.stringify({ valid: true, nodeCount: graph.nodes.length, order: result.topologicalOrder }, null, 2));
      return;
    }
    console.log(`Graph valid: ${graph.nodes.length} node${graph.nodes.length === 1 ? "" : "s"}`);
    console.log(`Order: ${result.topologicalOrder.join(" -> ")}`);
    return;
  }

  if (command === "init") {
    const pathArgument = positional(args.slice(1))[0];
    const graphPath = resolve(pathArgument ?? defaultGraphPath);
    const template = optionValue(args, "--template") ?? "minimal";
    if (!(["minimal", "codex-claudex", "astra-luna"] as string[]).includes(template)) {
      throw new CliError(`unknown template "${template}"`, 3, "INVALID_ARGUMENT");
    }
    const graph = await initializeGraph(graphPath, template as "minimal" | "codex-claudex" | "astra-luna", process.cwd()).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CliError(`refusing to overwrite ${graphPath}`, 3, "FILE_EXISTS");
      }
      throw error;
    });
    if (json) console.log(JSON.stringify({ graphPath, graph }, null, 2));
    else console.log(`Created ${graphPath}`);
    return;
  }

  if (command === "plan") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const result = validateGraph(graph);
    if (result.errors.length > 0) throw new CliError(result.errors.join("\n"), 3, "INVALID_GRAPH");
    const plan = buildExecutionPlan(graph, repositoryRoot);
    if (args.includes("--json")) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`Run ${plan.runId}: ${plan.objective}`);
      console.log(`Repository: ${plan.repositoryRoot}`);
      console.log(`External actions: ${plan.allowExternalActions ? "enabled with exact gate" : "disabled"}`);
      if (plan.semanticFailurePolicy) console.log(`Semantic failure policy: ${plan.semanticFailurePolicy}`);
      if (plan.advisor) console.log(`Advisor: ${plan.advisor.executor}${plan.advisor.model ? `/${plan.advisor.model}` : ""}${plan.advisor.reasoningEffort ? ` effort=${plan.advisor.reasoningEffort}` : ""}${plan.advisor.stopOnBlocker === false ? " (non-blocking)" : " (stops on blocker)"}`);
      for (const wave of plan.waves) {
        console.log(`  wave ${wave.index}`);
        for (const node of wave.nodes) {
          console.log(`    ${node.id} [${node.type}${node.executor ? `/${node.executor}` : ""}]`);
          console.log(`      needs: ${node.needs.join(", ") || "none"}`);
          console.log(`      owns: ${[...node.owns, ...node.implicitOutputs].join(", ") || "read-only"}`);
          console.log(`      checks: ${node.checks.join(" | ") || "none"}`);
          if (node.target) console.log(`      target: ${node.target}`);
          if (node.model) console.log(`      model: ${node.model}`);
          if (node.reasoningEffort) console.log(`      reasoning effort: ${node.reasoningEffort}`);
          if (node.requiredModelUsage) {
            console.log(`      model evidence: ${node.requiredModelUsage.map((usage) => `${usage.model}@${usage.provider}/${usage.contextWindow}`).join(", ")}`);
          }
        }
      }
    }
    return;
  }

  if (command === "run") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const validation = validateGraph(graph);
    if (validation.errors.length > 0) {
      throw new CliError(validation.errors.join("\n"), 3, "INVALID_GRAPH");
    }
    const heartbeatIndex = args.indexOf("--heartbeat-ms");
    const heartbeatMs =
      heartbeatIndex === -1
        ? undefined
        : Number(required(args[heartbeatIndex + 1], "--heartbeat-ms requires MS"));
    if (heartbeatMs !== undefined && (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0)) {
      throw new CliError("--heartbeat-ms must be a positive number", 3, "INVALID_ARGUMENT");
    }
    const lock = await acquireRunLock(repositoryRoot, graph.run.id);
    const cancellationPath = join(repositoryRoot, ".agent-graph", "runs", graph.run.id, `cancel.${lock.record.token}.requested`);
    const controller = new AbortController();
    const onInterrupt = (): void => controller.abort();
    process.once("SIGINT", onInterrupt);
    const cancellationPoll = setInterval(() => {
      void readFile(cancellationPath).then(() => controller.abort(), () => undefined);
    }, 200);
    try {
      const runner = new GraphRunner(graph, repositoryRoot, {
        codex: new CodexAdapter(),
        claude: new ClaudeAdapter(),
        claudex: new ClaudexAdapter(),
      }, {
        ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
        verbose: args.includes("--verbose"),
        onProgress: printProgress,
        signal: controller.signal,
      });
      const state = await runner.run();
      if (json) console.log(JSON.stringify(state, null, 2));
      else printState(state);
      process.exitCode = state.status === "completed" ? 0 : state.status === "awaiting_approval" ? 2 : state.status === "needs_attention" ? 5 : state.status === "cancelled" ? 130 : 1;
    } finally {
      clearInterval(cancellationPoll);
      process.removeListener("SIGINT", onInterrupt);
      await rm(cancellationPath, { force: true });
      await lock.release();
    }
    return;
  }

  if (command === "cancel") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const inspection = await inspectRunLock(repositoryRoot, graph.run.id);
    if (!inspection.record || !["live", "foreign"].includes(inspection.status)) {
      throw new CliError(`run ${graph.run.id} has no live owner to cancel`, 3, "RUN_NOT_ACTIVE");
    }
    const cancellationPath = join(repositoryRoot, ".agent-graph", "runs", graph.run.id, `cancel.${inspection.record.token}.requested`);
    await writeFile(cancellationPath, `${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    if (json) console.log(JSON.stringify({ runId: graph.run.id, cancellationRequested: true }, null, 2));
    else console.log(`Cancellation requested for run ${graph.run.id}`);
    return;
  }

  if (command === "unlock") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const recovered = await recoverRunLock(repositoryRoot, graph.run.id, args.includes("--force"));
    if (json) console.log(JSON.stringify({ runId: graph.run.id, unlocked: true, previousOwner: recovered }, null, 2));
    else if (recovered) console.log(`Recovered lock for run ${graph.run.id} previously owned by PID ${recovered.pid} on ${recovered.host}`);
    else console.log(`Recovered abandoned initializing lock for run ${graph.run.id}`);
    return;
  }

  if (command === "advisor") {
    const action = args[1];
    if (!["status", "acknowledge"].includes(action ?? "")) {
      throw new CliError("advisor requires status or acknowledge", 3, "INVALID_ARGUMENT");
    }
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(2))[0]);
    if (action === "status") {
      const current = await readRunState(repositoryRoot, graph.run.id);
      const result = {
        enabled: Boolean(graph.run.advisor),
        ...(graph.run.advisor ?? {}),
        latest: current.advisor?.latest ?? null,
        blocker: current.advisor?.blocker ?? null,
      };
      if (json) console.log(JSON.stringify(result, null, 2));
      else if (!result.enabled) console.log(`Advisor is not configured for run ${graph.run.id}.`);
      else {
        console.log(`Advisor: ${result.executor}${result.model ? `/${result.model}` : ""}`);
        if (result.latest) console.log(`  latest ${result.latest.severity}: ${result.latest.summary}`);
        if (result.blocker) console.log("  acknowledgement required before the next wave");
      }
      return;
    }
    const state = await new OperatorControl(graph, repositoryRoot).acknowledgeAdvisor();
    if (json) console.log(JSON.stringify(state, null, 2));
    else console.log(`Advisor blocker acknowledged for run ${graph.run.id}; resume with agr run.`);
    return;
  }

  if (command === "status") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const watch = args.includes("--watch");
    const intervalMs = numberOption(args, "--interval-ms", 1_000);
    let previous = "";
    do {
      const state = await readRunState(repositoryRoot, graph.run.id);
      if (state.updatedAt !== previous) {
        if (!json) printState(state);
        previous = state.updatedAt;
      }
      if (!watch || state.status !== "running") {
        if (json) console.log(JSON.stringify(state, null, 2));
        break;
      }
      const owner = await inspectRunLock(repositoryRoot, graph.run.id);
      if (!["live", "foreign", "initializing"].includes(owner.status)) {
        throw new CliError(
          `run ${graph.run.id} is recorded as running but has no live owner; resume it with agr run`,
          1,
          "RUN_OWNER_MISSING",
        );
      }
      await delay(intervalMs);
    } while (true);
    return;
  }

  if (command === "runs") {
    const { repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const states = await listRuns(repositoryRoot);
    if (json) console.log(JSON.stringify(states, null, 2));
    else if (states.length === 0) console.log("No runs found.");
    else for (const state of states) console.log(`${state.runId}\t${state.status}\t${state.updatedAt}`);
    return;
  }

  if (command === "events") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const events = await readRunEvents(repositoryRoot, graph.run.id);
    if (json) console.log(JSON.stringify(events, null, 2));
    else for (const event of events) console.log(JSON.stringify(event));
    return;
  }

  if (command === "follow") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const cursor = nonNegativeIntegerOption(args, "--after", 0);
    const intervalMs = numberOption(args, "--interval-ms", 1_000);
    const format = optionValue(args, "--format") ?? "human";
    if (!(["human", "jsonl"] as string[]).includes(format)) {
      throw new CliError(`unsupported follow format "${format}"`, 3, "INVALID_ARGUMENT");
    }
    for await (const item of new RunObserver(repositoryRoot, graph.run.id).follow(cursor, intervalMs)) {
      if (format === "jsonl") console.log(JSON.stringify(item));
      else if (item.type === "observer_heartbeat") {
        console.log(`[${item.cursor}] ${item.at} heartbeat — ${item.activeNodeIds.join(", ") || "runtime"} active`);
      } else {
        console.log(`[${item.seq}] ${item.at} ${item.type}${item.nodeId ? ` ${item.nodeId}` : ""}${item.detail ? ` — ${item.detail}` : ""}`);
      }
    }
    return;
  }

  if (command === "wait") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const after = nonNegativeIntegerOption(args, "--after", 0);
    const timeoutMs = nonNegativeIntegerOption(args, "--timeout-ms", 60_000);
    const observation = await new RunObserver(repositoryRoot, graph.run.id).wait(after, timeoutMs);
    if (json) console.log(JSON.stringify(observation, null, 2));
    else {
      for (const event of observation.events) console.log(`[${event.seq}] ${event.type}${event.nodeId ? ` ${event.nodeId}` : ""}${event.detail ? ` — ${event.detail}` : ""}`);
      console.log(`${observation.runId}: ${observation.status}${observation.timedOut ? " (observation timeout)" : ""}; cursor ${observation.cursor}`);
    }
    return;
  }

  if (command === "inspect") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const inspection = await new RunObserver(repositoryRoot, graph.run.id).inspect();
    if (json) console.log(JSON.stringify(inspection, null, 2));
    else {
      console.log(`${inspection.runId}: ${inspection.status} · cursor ${inspection.cursor}`);
      for (const node of inspection.activeNodes) {
        const milestone = node.latestMilestone
          ? ` · ${node.latestMilestone.phase ?? "progress"}${node.latestMilestone.percent === undefined ? "" : ` ${node.latestMilestone.percent}%`}: ${node.latestMilestone.message ?? "milestone"}`
          : "";
        console.log(`  ${node.id}: active ${Math.floor(node.elapsedMs / 1_000)}s · silent ${Math.floor(node.silentForMs / 1_000)}s${milestone}`);
      }
      for (const node of inspection.attentionNodes) console.log(`  ${node.id}: attention${node.error ? ` — ${node.error}` : ""}`);
    }
    return;
  }

  if (command === "why") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const explanation = await new RunObserver(repositoryRoot, graph.run.id).explain();
    if (json) console.log(JSON.stringify(explanation, null, 2));
    else {
      console.log(`${explanation.runId}: ${explanation.status}`);
      if (explanation.issues.length === 0) console.log("  No active issue recorded.");
      for (const issue of explanation.issues) {
        console.log(`  ${issue.code}${issue.nodeId ? ` [${issue.nodeId}]` : ""}: ${issue.detail ?? issue.nextAction}`);
        if (issue.detail) console.log(`    next: ${issue.nextAction}`);
      }
    }
    return;
  }

  if (command === "logs") {
    const values = positional(args.slice(1));
    const singleLooksLikeGraph = values.length === 1 && /[\\/]|\.json$/i.test(values[0]!);
    const nodeId = values.length > 1 || (values.length === 1 && !singleLooksLikeGraph) ? values[0] : undefined;
    const graphPath = values.length > 1 ? values[1] : singleLooksLikeGraph ? values[0] : undefined;
    const { graph, repositoryRoot } = await loadGraph(graphPath);
    const logs = await readRunLogs(repositoryRoot, graph.run.id, nodeId);
    if (json) console.log(JSON.stringify(logs, null, 2));
    else if (logs.length === 0) console.log("No agent logs found.");
    else for (const log of logs) console.log(`==> ${log.path} <==\n${log.content}`);
    return;
  }

  if (command === "report") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const path = join(runDirectory(repositoryRoot, graph.run.id), "report.md");
    const content = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CliError(`run ${graph.run.id} has no report yet; start it with agr run`, 3, "RUN_NOT_FOUND");
      }
      throw error;
    });
    if (json) console.log(JSON.stringify({ path, content }, null, 2));
    else console.log(content);
    return;
  }

  if (command === "approve") {
    const values = positional(args.slice(1));
    const nodeId = required(values[0], "approve requires NODE_ID");
    const target = required(values[1], "approve requires exact TARGET");
    const { graph, repositoryRoot } = await loadGraph(values[2]);
    const state = await new OperatorControl(graph, repositoryRoot).approve(nodeId, target);
    if (json) console.log(JSON.stringify(state, null, 2));
    else printState(state);
    return;
  }

  if (command === "retry") {
    const values = positional(args.slice(1));
    const nodeId = required(values[0], "retry requires NODE_ID");
    const { graph, repositoryRoot } = await loadGraph(values[1]);
    const state = await new OperatorControl(graph, repositoryRoot).retry(nodeId);
    if (json) console.log(JSON.stringify(state, null, 2));
    else printState(state);
    return;
  }

  if (command === "doctor") {
    const { graph, repositoryRoot } = await loadGraph(positional(args.slice(1))[0]);
    const result = await diagnoseEnvironment(graph, repositoryRoot);
    if (json) console.log(JSON.stringify(result, null, 2));
    else for (const check of result.checks) console.log(`${check.ok ? "OK" : "FAIL"}\t${check.name}\t${check.detail}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "schema") {
    console.log(JSON.stringify(graphSchema, null, 2));
    return;
  }

  if (command === "node" && args[1] === "explain") {
    const values = positional(args.slice(2));
    const nodeId = required(values[0], "node explain requires NODE_ID");
    const { graph } = await loadGraph(values[1]);
    const explanation = explainNode(graph, nodeId);
    if (json) console.log(JSON.stringify(explanation, null, 2));
    else console.log(JSON.stringify(explanation, null, 2));
    return;
  }

  if (command === "graph") {
    const { graph } = await loadGraph(positional(args.slice(1))[0]);
    const format = optionValue(args, "--format") ?? "mermaid";
    if (format !== "mermaid") throw new CliError(`unsupported graph format "${format}"`, 3, "INVALID_ARGUMENT");
    const content = graphToMermaid(graph);
    if (json) console.log(JSON.stringify({ format: "mermaid", content }, null, 2));
    else console.log(content);
    return;
  }

  if (command === "completion") {
    const shell = required(args[1], "completion requires powershell, bash, or zsh");
    if (!(["powershell", "bash", "zsh"] as string[]).includes(shell)) {
      throw new CliError(`unsupported shell "${shell}"`, 3, "INVALID_ARGUMENT");
    }
    console.log(completionScript(shell as "powershell" | "bash" | "zsh"));
    return;
  }

  if (command === "install-skills") {
    const projectIndex = args.indexOf("--project");
    const projectDirectory =
      projectIndex >= 0 ? required(args[projectIndex + 1], "--project requires DIR") : undefined;
    const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    if (projectDirectory && args.includes("--user")) {
      throw new CliError("choose either --project DIR or --user", 3, "INVALID_ARGUMENT");
    }
    const options = {
      ...(projectDirectory ? { projectDirectory } : {}),
      ...(args.includes("--dry-run") ? { dryRun: true } : {}),
    };
    const installed = await installSkills(moduleRoot, options);
    if (json) console.log(JSON.stringify(installed, null, 2));
    else for (const result of installed) console.log(`${result.status}: ${result.path} (${result.hash.slice(0, 12)})`);
    return;
  }

  throw new CliError(`unknown command "${command}"`, 3, "UNKNOWN_COMMAND");
}

async function loadGraph(pathArgument?: string): Promise<{
  graph: GraphDefinition;
  graphPath: string;
  repositoryRoot: string;
}> {
  const graphPath = resolve(pathArgument ?? defaultGraphPath);
  let graph: GraphDefinition;
  try {
    graph = JSON.parse(await readFile(graphPath, "utf8")) as GraphDefinition;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`graph not found at ${graphPath}; run agr init`, 3, "GRAPH_NOT_FOUND");
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`invalid JSON in ${graphPath}: ${error.message}`, 3, "INVALID_GRAPH_JSON");
    }
    throw error;
  }
  if (!graph || typeof graph !== "object" || !graph.run || typeof graph.run.repository !== "string") {
    throw new CliError("graph requires run.repository", 3, "INVALID_GRAPH");
  }
  const conventionalRootAlias =
    basename(dirname(graphPath)) === ".agent-graph" &&
    basename(graphPath).toLowerCase() === "graph.json" &&
    graph.run.repository === ".";
  const graphBase = conventionalRootAlias ? dirname(dirname(graphPath)) : dirname(graphPath);
  const repositoryRoot = resolve(graphBase, graph.run.repository);
  return { graph, graphPath, repositoryRoot };
}

function printState(state: RunState): void {
  console.log(`Run ${state.runId}: ${state.status}`);
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const error = node.lastError ? ` — ${node.lastError}` : "";
    console.log(`  ${nodeId}: ${node.status} (attempts ${node.attempts})${error}`);
  }
}

function printProgress(event: RunProgressEvent): void {
  const timestamp = event.at.slice(11, 19);
  let message: string;
  switch (event.type) {
    case "run_started":
      message = `run ${event.runId} started`;
      break;
    case "node_started":
      message = `${event.nodeId ?? "node"} started${event.detail ? ` (${event.detail})` : ""}`;
      break;
    case "node_activity":
      message = `${event.nodeId ?? "node"}: ${event.detail ?? "provider activity"}`;
      break;
    case "node_progress":
      message = `${event.nodeId ?? "node"} ${event.phase ?? "progress"}${event.percent === undefined ? "" : ` ${event.percent}%`}: ${event.detail ?? "milestone reported"}`;
      break;
    case "heartbeat":
      message = `heartbeat: ${(event.activeNodeIds ?? []).map((nodeId) => {
        const latest = event.latestNodeProgress?.[nodeId];
        return latest
          ? `${nodeId}[${latest.phase}${latest.percent === undefined ? "" : ` ${latest.percent}%`}: ${latest.message}]`
          : nodeId;
      }).join(", ") || "runtime"} active for ${Math.floor((event.elapsedMs ?? 0) / 1_000)}s`;
      break;
    case "node_accepted":
      message = `${event.nodeId ?? "node"} accepted`;
      break;
    case "node_failed":
      message = `${event.nodeId ?? "node"} failed${event.detail ? ` — ${event.detail}` : ""}`;
      break;
    case "advisor_note":
      message = `${event.nodeId ?? "advisor"} ${event.severity ?? "note"}${event.detail ? ` — ${event.detail}` : ""}`;
      break;
    case "advisor_failed":
      message = `${event.nodeId ?? "advisor"} unavailable${event.detail ? ` — ${event.detail}` : ""}; primary run continues unless safety is uncertain`;
      break;
    case "approval_required":
      message = `${event.nodeId ?? "gate"} awaiting approval${event.detail ? ` — ${event.detail}` : ""}`;
      break;
    case "run_completed":
      message = `run ${event.runId} completed`;
      break;
    case "run_failed":
      message = `run ${event.runId} failed`;
      break;
    case "run_needs_attention":
      message = `run ${event.runId} needs operator attention; inspect evidence, then use agr retry explicitly`;
      break;
    case "run_cancelled":
      message = `run ${event.runId} cancelled`;
      break;
  }
  process.stderr.write(`[${timestamp}] ${message}\n`);
}

function printHelp(): void {
  console.log(`Agent Graph Runtime

Usage:
  agr init [GRAPH] [--template minimal|codex-claudex|astra-luna]
  agr validate [GRAPH]
  agr plan [GRAPH] [--json]
  agr doctor [GRAPH]
  agr run [GRAPH] [--json] [--verbose]
  agr progress --phase PHASE --message MESSAGE [--percent N]
  agr cancel [GRAPH]
  agr unlock [GRAPH] [--force]
  agr advisor status|acknowledge [GRAPH] [--json]
  agr status [GRAPH] [--watch] [--json]
  agr follow [GRAPH] [--after N] [--format human|jsonl]
  agr wait [GRAPH] [--after N] [--timeout-ms N] [--json]
  agr inspect [GRAPH] [--json]
  agr why [GRAPH] [--json]
  agr runs|events|report [GRAPH] [--json]
  agr logs [NODE_ID] [GRAPH] [--json]
  agr approve NODE_ID TARGET [GRAPH]
  agr retry NODE_ID [GRAPH]
  agr schema
  agr node explain NODE_ID [GRAPH]
  agr graph [GRAPH] [--format mermaid]
  agr completion powershell|bash|zsh
  agr install-skills [--project DIR | --user] [--dry-run]

Default graph: ${defaultGraphPath}`);
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new CliError(message, 3, "INVALID_ARGUMENT");
  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : required(args[index + 1], `${name} requires a value`);
}

function numberOption(args: string[], name: string, fallback: number): number {
  const raw = optionValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new CliError(`${name} must be positive`, 3, "INVALID_ARGUMENT");
  return value;
}

function nonNegativeIntegerOption(args: string[], name: string, fallback: number): number {
  const raw = optionValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new CliError(`${name} must be a non-negative integer`, 3, "INVALID_ARGUMENT");
  return value;
}

function positional(args: string[]): string[] {
  const valueFlags = new Set(["--heartbeat-ms", "--interval-ms", "--timeout-ms", "--after", "--template", "--format", "--project", "--phase", "--message", "--percent"]);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) values.push(argument);
  }
  return values;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assertCommandOptions(command: string, args: string[]): void {
  const common = ["--help", "-h"];
  const allowedByCommand: Record<string, string[]> = {
    validate: ["--json"], plan: ["--json"], init: ["--json", "--template"],
    run: ["--json", "--heartbeat-ms", "--verbose"], progress: ["--json", "--phase", "--message", "--percent"], cancel: ["--json"], unlock: ["--json", "--force"],
    status: ["--json", "--watch", "--interval-ms"], runs: ["--json"], events: ["--json"],
    follow: ["--after", "--format", "--interval-ms"], wait: ["--json", "--after", "--timeout-ms"], inspect: ["--json"], why: ["--json"], advisor: ["--json"],
    logs: ["--json"], report: ["--json"], approve: ["--json"], retry: ["--json"],
    doctor: ["--json"], schema: ["--json"], node: ["--json"], graph: ["--json", "--format"],
    completion: [], "install-skills": ["--json", "--project", "--user", "--dry-run"],
  };
  const known = new Set([...(allowedByCommand[command] ?? []), ...common]);
  for (const argument of args) {
    if (!argument.startsWith("-")) continue;
    if (!known.has(argument)) {
      throw new CliError(`option "${argument}" is not valid for agr ${command}; run agr help`, 3, "UNKNOWN_OPTION");
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ error: { code: error instanceof CliError ? error.code : "RUNTIME_ERROR", message } }));
  } else {
    console.error(message);
  }
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
