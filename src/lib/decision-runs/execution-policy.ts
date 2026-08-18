import type { DecisionRunStatus } from "./model";

export type TryOnExecutionSummary = {
  attempted: number;
  ready: number;
  failed: number;
};

export function getDecisionRunCompletionStatus(
  summary: TryOnExecutionSummary,
): Extract<DecisionRunStatus, "completed" | "completed_with_errors"> {
  return summary.failed > 0 || summary.ready < summary.attempted
    ? "completed_with_errors"
    : "completed";
}
