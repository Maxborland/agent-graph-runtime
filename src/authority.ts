import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { sha256 } from "./persistence.js";
import { gitChangeSnapshot } from "./repository.js";
import type {
  ApprovalConsumption,
  ApprovalReceipt,
  ApprovalReservation,
  GraphDefinition,
  GraphNodeDefinition,
  PolicyDecision,
  RunState,
} from "./types.js";

const exec = promisify(execFile);
const explicitHumanPolicyHash = sha256("explicit-human-authority-v1");

export async function repositoryFingerprint(repositoryRoot: string): Promise<string> {
  const commonRaw = await git(repositoryRoot, ["rev-parse", "--git-common-dir"]);
  const commonCanonical = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(repositoryRoot, commonRaw));
  const commonDirectory = process.platform === "win32" ? commonCanonical.toLowerCase() : commonCanonical;
  const [head, snapshot] = await Promise.all([
    gitHead(repositoryRoot),
    gitChangeSnapshot(repositoryRoot),
  ]);
  const productChanges = Object.fromEntries(
    Object.entries(snapshot)
      .filter(([path]) => path !== ".agent-graph" && !path.startsWith(".agent-graph/"))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return sha256(JSON.stringify({ repositoryIdentity: commonDirectory, head, productChanges }));
}

export function issueApprovalReceipt(
  graph: GraphDefinition,
  state: RunState,
  gateNodeId: string,
  target: string,
  fingerprint: string,
  now = new Date().toISOString(),
): ApprovalReceipt {
  const gate = requireNode(graph, gateNodeId);
  const actions = graph.nodes.filter(
    (node) => node.type === "external_action" && node.needs.includes(gateNodeId) && node.target === target,
  );
  if (actions.length > 1) {
    throw new Error(`human gate "${gateNodeId}" ambiguously authorizes multiple external actions`);
  }
  const action = actions[0] ?? gate;
  return {
    schemaVersion: 1,
    approvalId: randomUUID(),
    issuedBy: "human",
    gateNodeId,
    actionNodeId: action.id,
    target,
    actionParametersHash: actionParametersHash(action),
    planRevisionId: state.activePlanRevisionId,
    repositoryFingerprint: fingerprint,
    dependencyEvidenceDigest: dependencyEvidenceDigest(graph, state, action),
    policyHash: explicitHumanPolicyHash,
    issuedAt: now,
  };
}

export function tryIssuePolicyApprovalReceipt(
  graph: GraphDefinition,
  state: RunState,
  gateNodeId: string,
  fingerprint: string,
  now = new Date().toISOString(),
): ApprovalReceipt | undefined {
  const gate = requireNode(graph, gateNodeId);
  if (!policyApprovalEligible(graph, gateNodeId) || !gate.target) return undefined;
  const action = graph.nodes.find((node) => node.type === "external_action" && node.needs.includes(gateNodeId) && node.target === gate.target)!;
  evaluateMandate(graph, state, action.id, now);
  return {
    schemaVersion: 1,
    approvalId: randomUUID(),
    issuedBy: "policy",
    gateNodeId,
    actionNodeId: action.id,
    target: gate.target,
    actionParametersHash: actionParametersHash(action),
    planRevisionId: state.activePlanRevisionId,
    repositoryFingerprint: fingerprint,
    dependencyEvidenceDigest: dependencyEvidenceDigest(graph, state, action),
    policyHash: automaticPolicyHash(graph, state),
    issuedAt: now,
  };
}

export function policyApprovalEligible(graph: GraphDefinition, gateNodeId: string): boolean {
  const gate = graph.nodes.find((node) => node.id === gateNodeId);
  if (gate?.type !== "human_gate" || !gate.target) return false;
  const action = graph.nodes.find((node) => node.type === "external_action" && node.needs.includes(gateNodeId) && node.target === gate.target);
  return action?.reversible === true && graph.run.automaticPolicy?.allowedActionTypes?.includes(action.type) === true;
}

export function requireUsableReceipt(
  graph: GraphDefinition,
  state: RunState,
  actionNodeId: string,
  fingerprint: string,
  now = Date.now(),
): ApprovalReceipt {
  const action = requireNode(graph, actionNodeId);
  const candidates = [...state.authority.receipts]
    .filter((receipt) => receipt.actionNodeId === actionNodeId)
    .reverse();
  for (const receipt of candidates) {
    if (state.authority.reservations.some((reservation) => reservation.approvalId === receipt.approvalId)) continue;
    if (receipt.expiresAt && Date.parse(receipt.expiresAt) <= now) continue;
    if (receipt.target !== action.target) continue;
    if (receipt.planRevisionId !== state.activePlanRevisionId) continue;
    if (receipt.actionParametersHash !== actionParametersHash(action)) continue;
    if (receipt.dependencyEvidenceDigest !== dependencyEvidenceDigest(graph, state, action)) continue;
    if (receipt.repositoryFingerprint !== fingerprint) {
      throw new Error("approval repository fingerprint changed; issue a new approval for the current repository state");
    }
    const validPolicy = receipt.issuedBy === "human"
      ? receipt.policyHash === explicitHumanPolicyHash
      : action.reversible === true && graph.run.automaticPolicy?.allowedActionTypes?.includes(action.type) === true && receipt.policyHash === automaticPolicyHash(graph, state);
    if (!validPolicy) continue;
    return receipt;
  }
  throw new Error(`external action "${actionNodeId}" has no current unused approval receipt`);
}

export function reserveApproval(
  state: RunState,
  receipt: ApprovalReceipt,
  attemptId: string,
  now = new Date().toISOString(),
): ApprovalReservation {
  if (state.authority.reservations.some((reservation) => reservation.approvalId === receipt.approvalId)) {
    throw new Error(`approval receipt ${receipt.approvalId} is already reserved`);
  }
  const reservation: ApprovalReservation = {
    schemaVersion: 1,
    reservationId: randomUUID(),
    approvalId: receipt.approvalId,
    attemptId,
    actionParametersHash: receipt.actionParametersHash,
    reservedAt: now,
  };
  state.authority.reservations.push(reservation);
  return reservation;
}

export function evaluateMandate(
  graph: GraphDefinition,
  state: RunState,
  actionNodeId: string,
  now = new Date().toISOString(),
): PolicyDecision {
  const action = requireNode(graph, actionNodeId);
  const mandate = state.authority.mandate;
  const allowed =
    mandate.planRevisionId === state.activePlanRevisionId &&
    mandate.policyHash === state.graphHash &&
    mandate.allowedActions.includes(action.type) &&
    (!action.target || mandate.allowedTargets.includes(action.target)) &&
    graph.nodes.length <= mandate.maxNodes &&
    nodeDepth(graph, actionNodeId) <= mandate.maxDepth &&
    Number.isFinite(Date.parse(mandate.issuedAt)) &&
    Date.parse(now) - Date.parse(mandate.issuedAt) <= mandate.maxDurationMs;
  const decision: PolicyDecision = {
    schemaVersion: 1,
    decisionId: randomUUID(),
    mandateId: mandate.mandateId,
    actionNodeId,
    outcome: allowed ? "allow" : "deny",
    reason: allowed ? "action is within the human-issued run mandate" : "action exceeds the human-issued run mandate",
    policyHash: mandate.policyHash,
    decidedAt: now,
  };
  state.authority.policyDecisions.push(decision);
  if (!allowed) throw new Error(`external action "${actionNodeId}" exceeds the human-issued run mandate`);
  return decision;
}

function nodeDepth(graph: GraphDefinition, nodeId: string, seen = new Map<string, number>()): number {
  const cached = seen.get(nodeId);
  if (cached !== undefined) return cached;
  const node = requireNode(graph, nodeId);
  const depth = 1 + Math.max(0, ...node.needs.map((dependency) => nodeDepth(graph, dependency, seen)));
  seen.set(nodeId, depth);
  return depth;
}

export function consumeReservation(
  state: RunState,
  reservation: ApprovalReservation,
  now = new Date().toISOString(),
): ApprovalConsumption {
  if (state.authority.consumptions.some((item) => item.reservationId === reservation.reservationId)) {
    throw new Error(`approval reservation ${reservation.reservationId} is already consumed`);
  }
  const consumption: ApprovalConsumption = {
    schemaVersion: 1,
    reservationId: reservation.reservationId,
    consumedAt: now,
  };
  state.authority.consumptions.push(consumption);
  return consumption;
}

export function hasUnusedReceipt(graph: GraphDefinition, state: RunState, actionNodeId: string): boolean {
  const action = requireNode(graph, actionNodeId);
  return state.authority.receipts.some((receipt) =>
    receipt.actionNodeId === actionNodeId &&
    receipt.target === action.target &&
    receipt.planRevisionId === state.activePlanRevisionId &&
    receipt.actionParametersHash === actionParametersHash(action) &&
    !state.authority.reservations.some((reservation) => reservation.approvalId === receipt.approvalId));
}

function actionParametersHash(node: GraphNodeDefinition): string {
  return sha256(JSON.stringify({
    nodeId: node.id,
    type: node.type,
    executor: node.executor ?? null,
    target: node.target ?? null,
    prompt: node.prompt ?? null,
    checks: node.checks,
  }));
}

function automaticPolicyHash(graph: GraphDefinition, state: RunState): string {
  return sha256(JSON.stringify({ mandateId: state.authority.mandate.mandateId, policy: graph.run.automaticPolicy ?? null }));
}

function dependencyEvidenceDigest(
  graph: GraphDefinition,
  state: RunState,
  node: GraphNodeDefinition,
): string {
  const dependencies = node.needs
    .filter((nodeId) => graph.nodes.find((candidate) => candidate.id === nodeId)?.type !== "human_gate")
    .map((nodeId) => {
      const nodeState = state.nodes[nodeId];
      const attempt = nodeState?.acceptedAttemptId ? state.attempts[nodeState.acceptedAttemptId] : undefined;
      return {
        nodeId,
        acceptedAttemptId: nodeState?.acceptedAttemptId ?? null,
        evidence: attempt?.evidence.map((item) => item.sha256).sort() ?? [],
      };
    })
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return sha256(JSON.stringify(dependencies));
}

function requireNode(graph: GraphDefinition, nodeId: string): GraphNodeDefinition {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`node "${nodeId}" does not exist`);
  return node;
}

async function gitHead(repositoryRoot: string): Promise<string> {
  try {
    return (await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
  } catch {
    return "unborn";
  }
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: repositoryRoot, encoding: "utf8" })).stdout.trim();
}
