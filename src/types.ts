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
  baseCommit?: string;
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
  generation: number;
  generationAttempts: number;
  currentAttemptId?: string;
  acceptedAttemptId?: string;
  retryBlocked?: boolean;
  approvedTarget?: string;
  lastError?: string;
  evidenceFiles: string[];
}

export type AttemptStatus =
  | "running"
  | "accepted"
  | "failed"
  | "superseded";

export interface ArtifactRef {
  schemaVersion: 1;
  artifactId: string;
  kind: string;
  sha256: string;
  size: number;
  producerAttemptId: string;
  localPath: string;
}

export interface AttemptRecord {
  schemaVersion: 1;
  attemptId: string;
  nodeId: string;
  planRevisionId: string;
  generation: number;
  ordinal: number;
  status: AttemptStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  evidence: ArtifactRef[];
}

export interface ApprovalReceipt {
  schemaVersion: 1;
  approvalId: string;
  issuedBy: "human";
  gateNodeId: string;
  actionNodeId: string;
  target: string;
  actionParametersHash: string;
  planRevisionId: string;
  repositoryFingerprint: string;
  dependencyEvidenceDigest: string;
  policyHash: string;
  issuedAt: string;
  expiresAt?: string;
}

export interface ApprovalReservation {
  schemaVersion: 1;
  reservationId: string;
  approvalId: string;
  attemptId: string;
  actionParametersHash: string;
  reservedAt: string;
}

export interface ApprovalConsumption {
  schemaVersion: 1;
  reservationId: string;
  consumedAt: string;
}

export interface ReconciliationRecord {
  schemaVersion: 1;
  reconciliationId: string;
  attemptId: string;
  sha256: string;
  size: number;
  localPath: string;
  recordedAt: string;
}

export interface RunMandate {
  schemaVersion: 1;
  mandateId: string;
  issuedBy: "human";
  planRevisionId: string;
  allowedActions: NodeType[];
  allowedTargets: string[];
  maxNodes: number;
  maxDepth: number;
  maxDurationMs: number;
  policyHash: string;
  issuedAt: string;
}

export interface PolicyDecision {
  schemaVersion: 1;
  decisionId: string;
  mandateId: string;
  actionNodeId: string;
  outcome: "allow" | "deny";
  reason: string;
  policyHash: string;
  decidedAt: string;
}

export interface AuthorityState {
  schemaVersion: 1;
  mandate: RunMandate;
  policyDecisions: PolicyDecision[];
  receipts: ApprovalReceipt[];
  reservations: ApprovalReservation[];
  consumptions: ApprovalConsumption[];
  reconciliations: ReconciliationRecord[];
}

export interface RepositorySnapshot {
  repositoryId: string;
  root: string;
  baseCommit: string;
  worktreePath?: string;
  runBranch?: string;
}

export interface CheckpointRecord {
  schemaVersion: 1;
  checkpointId: string;
  commit: string;
  planRevisionId: string;
  acceptedAttemptIds: string[];
  evidenceDigest: string;
  createdAt: string;
}

export interface GitTransactionState {
  schemaVersion: 1;
  baseCommit: string;
  runBranch: string;
  worktreePath: string;
  checkpoints: CheckpointRecord[];
  resultId?: string;
  resultCommit?: string;
}

export interface RunResult {
  schemaVersion: 1;
  resultId: string;
  runId: string;
  repositoryId: string;
  baseCommit: string;
  resultCommit: string;
  planRevisionId: string;
  checkpoints: CheckpointRecord[];
  evidenceDigest: string;
  completedAt: string;
}

export interface PlanRevisionRecord {
  schemaVersion: 1;
  revisionId: string;
  runId: string;
  graphHash: string;
  createdAt: string;
}

export type RunStatus = "running" | "completed" | "failed" | "needs_attention" | "awaiting_approval" | "cancelled";

export interface RunState {
  schemaVersion: 2;
  revision: number;
  lastAppliedEventSeq: number;
  runId: string;
  graphHash: string;
  activePlanRevisionId: string;
  repository: RepositorySnapshot;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  baselineChangedFiles: string[];
  nodes: Record<string, NodeRunState>;
  attempts: Record<string, AttemptRecord>;
  authority: AuthorityState;
  git?: GitTransactionState;
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
  schemaVersion?: 2;
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
  | "approval_reserved"
  | "approval_consumed"
  | "reconciliation_recorded"
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
