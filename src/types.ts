export type ExecutorName = "codex" | "claude" | "shell";
export type NodeType =
  | "agent"
  | "verify"
  | "review"
  | "human_gate"
  | "external_action";

export interface GraphRunDefinition {
  id: string;
  objective: string;
  repository: string;
  maxConcurrency: number;
  allowExternalActions?: boolean;
  codeGraph?: boolean;
}

export interface GraphNodeDefinition {
  id: string;
  type: NodeType;
  executor?: ExecutorName;
  prompt?: string;
  target?: string;
  needs: string[];
  owns: string[];
  implicitOutputs?: string[];
  checks: string[];
  maxAttempts: number;
  timeoutMs?: number;
  model?: string;
  context?: {
    symbols?: string[];
    impact?: string[];
    affectedFiles?: string[];
  };
}

export interface GraphDefinition {
  version: 1;
  run: GraphRunDefinition;
  nodes: GraphNodeDefinition[];
}

export interface GraphValidationResult {
  errors: string[];
  topologicalOrder: string[];
}

export type NodeStatus =
  | "pending"
  | "running"
  | "accepted"
  | "failed"
  | "blocked"
  | "awaiting_approval";

export interface NodeRunState {
  status: NodeStatus;
  attempts: number;
  approvedTarget?: string;
  lastError?: string;
  evidenceFiles: string[];
}

export type RunStatus = "running" | "completed" | "failed" | "awaiting_approval";

export interface RunState {
  runId: string;
  graphHash: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  baselineChangedFiles: string[];
  nodes: Record<string, NodeRunState>;
}

export interface AgentHandoff {
  status: "complete" | "partial" | "blocked";
  summary: string;
  changedFiles: string[];
  verification: string[];
  gaps: string[];
}

export interface AdapterRequest {
  node: GraphNodeDefinition;
  repositoryRoot: string;
  prompt: string;
  artifactsDirectory: string;
  timeoutMs: number;
}

export interface AdapterResult {
  handoff: AgentHandoff;
  stdout: string;
  stderr: string;
  exitCode: number;
}
