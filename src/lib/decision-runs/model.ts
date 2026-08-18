export const DECISION_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
] as const;

export type DecisionRunStatus = (typeof DECISION_RUN_STATUSES)[number];

export const DECISION_RUN_STAGES = [
  "queued",
  "analyzing_candidate",
  "retrieving_context",
  "deciding",
  "decision_ready",
  "generating_try_ons",
  "completed",
] as const;

export type DecisionRunStage = (typeof DECISION_RUN_STAGES)[number];

export type DecisionRunPresentationStatus =
  | "queued"
  | "working"
  | "decision_ready"
  | "generating_try_ons"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

export type DecisionRunRow = {
  id: string;
  user_id: string;
  session_id: string;
  client_request_id: string;
  input_text: string;
  screenshot_path: string;
  screenshot_mime_type: string | null;
  profile_snapshot: Record<string, unknown>;
  stage_data: Record<string, unknown>;
  status: DecisionRunStatus;
  stage: DecisionRunStage;
  user_message_id: string | null;
  assistant_message_id: string | null;
  candidate_id: string | null;
  report_id: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  recovery_count: number;
  available_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_claimed_at: string | null;
  last_heartbeat_at: string | null;
  last_recovered_at: string | null;
  started_at: string | null;
  decision_ready_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DecisionRun = {
  id: string;
  userId: string;
  sessionId: string;
  clientRequestId: string;
  inputText: string;
  screenshotPath: string;
  stageData: Record<string, unknown>;
  status: DecisionRunStatus;
  stage: DecisionRunStage;
  userMessageId: string | null;
  assistantMessageId: string | null;
  candidateId: string | null;
  reportId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  startedAt: string | null;
  decisionReadyAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const DECISION_RUN_STAGE_LABELS: Record<DecisionRunStage, string> = {
  queued: "排队中",
  analyzing_candidate: "识别待买商品截图",
  retrieving_context: "检索你的衣橱",
  deciding: "生成搭配和购买建议",
  decision_ready: "文字建议已完成",
  generating_try_ons: "生成真实搭配",
  completed: "已完成",
};

export const DECISION_RUN_POLL_INTERVAL_MS = 5_000;

const terminalStatuses = new Set<DecisionRunStatus>([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
]);

export function isDecisionRunTerminal(status: DecisionRunStatus): boolean {
  return terminalStatuses.has(status);
}

export function isDecisionRunActive(status: DecisionRunStatus): boolean {
  return !isDecisionRunTerminal(status);
}

export function deriveDecisionRunStatus(
  run: Pick<DecisionRunRow, "status" | "stage">,
): DecisionRunPresentationStatus {
  if (run.status !== "running") {
    return run.status;
  }

  if (run.stage === "decision_ready") {
    return "decision_ready";
  }

  if (run.stage === "generating_try_ons") {
    return "generating_try_ons";
  }

  return "working";
}

export function getDecisionRunStageLabel(stage: DecisionRunStage): string {
  return DECISION_RUN_STAGE_LABELS[stage];
}

export function getDecisionRunStageProgressIndex(stage: DecisionRunStage): number {
  return DECISION_RUN_STAGES.indexOf(stage);
}

export function hasActiveDecisionRuns(
  runs: ReadonlyArray<Pick<DecisionRunRow, "status">>,
): boolean {
  return runs.some((run) => isDecisionRunActive(run.status));
}

export function getDecisionRunPollingInterval(
  runs: ReadonlyArray<Pick<DecisionRunRow, "status">>,
): number | null {
  return hasActiveDecisionRuns(runs) ? DECISION_RUN_POLL_INTERVAL_MS : null;
}

export function mapDecisionRunRow(row: DecisionRunRow): DecisionRun {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    clientRequestId: row.client_request_id,
    inputText: row.input_text,
    screenshotPath: row.screenshot_path,
    stageData: row.stage_data,
    status: row.status,
    stage: row.stage,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    candidateId: row.candidate_id,
    reportId: row.report_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attemptCount: row.attempt_count,
    startedAt: row.started_at,
    decisionReadyAt: row.decision_ready_at,
    finishedAt: row.finished_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
