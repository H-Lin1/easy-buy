import type { DecisionRun, DecisionRunRow } from "./model";

export function toPublicDecisionRun(row: DecisionRunRow): DecisionRun {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    clientRequestId: row.client_request_id,
    inputText: row.input_text,
    screenshotPath: row.screenshot_path,
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
    stageData: pickPublicStageData(row.stage_data),
  };
}

function pickPublicStageData(stageData: Record<string, unknown>) {
  return Object.fromEntries(
    ["closetItemCount", "decisionElapsedSeconds", "tryOnSummary"].flatMap((key) =>
      stageData[key] === undefined ? [] : [[key, stageData[key]]],
    ),
  );
}
