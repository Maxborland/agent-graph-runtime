export const executorNames = ["codex", "claude", "claudex", "shell"] as const;
export type ExecutorName = (typeof executorNames)[number];
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
  advisor?: AdvisorDefinition;
}

export interface AdvisorDefinition {
  executor: Exclude<ExecutorName, "shell">;
  model?: string;
  instructions?: string;
  stopOnBlocker?: boolean;
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
  requiredModelUsage?: RequiredModelUsage[];
  context?: {
    symbols?: string[];
    impact?: string[];
    affectedFiles?: string[];
  };
}

export interface RequiredModelUsage {
  model: string;
  provider: string;
  contextWindow: number;
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
  retryBlocked?: boolean;
  approvedTarget?: string;
  lastError?: string;
  evidenceFiles: string[];
}

export type RunStatus = "running" | "completed" | "failed" | "needs_attention" | "awaiting_approval" | "cancelled";

export interface RunState {
  runId: string;
  graphHash: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  baselineChangedFiles: string[];
  nodes: Record<string, NodeRunState>;
  advisor?: AdvisorRunState;
}

export type AdvisorSeverity = "note" | "concern" | "blocker";

export interface AdvisorObservation {
  id: string;
  wave: number;
  at: string;
  severity: AdvisorSeverity;
  summary: string;
  evidenceFile: string;
}

export interface AdvisorRunState {
  lastSequence?: number;
  latest?: AdvisorObservation;
  blocker?: AdvisorObservation;
}

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  nodeId?: string;
  detail?: string;
  phase?: string;
  percent?: number;
  severity?: AdvisorSeverity;
  evidenceFile?: string;
}

export type RunEventType =
  | "state_saved"
  | "node_interrupted"
  | "run_started"
  | "approval_required"
  | "node_started"
  | "node_activity"
  | "node_progress"
  | "node_accepted"
  | "node_failed"
  | "run_completed"
  | "run_failed"
  | "run_needs_attention"
  | "run_cancelled"
  | "approval_recorded"
  | "node_invalidated"
  | "advisor_note"
  | "advisor_failed"
  | "advisor_acknowledged";

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
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  activityVerbosity?: "normal" | "verbose";
  onActivity?: (summary: string) => void;
}

export interface AdapterResult {
  handoff: AgentHandoff;
  stdout: string;
  stderr: string;
  exitCode: number;
  modelUsage?: Record<string, ModelUsageEvidence>;
}

export interface ModelUsageEvidence {
  canonicalModel?: string;
  provider?: string;
  contextWindow?: number;
}
