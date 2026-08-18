import type { DecisionRun } from "./model";

export type PendingDecisionSubmission = {
  sessionId: string;
  message: string;
  imageDataUrl: string;
  imageName?: string;
  clientRequestId: string;
};

export type DecisionSubmissionInput = Omit<
  PendingDecisionSubmission,
  "clientRequestId"
>;

export function mergeDecisionRun(
  current: Record<string, DecisionRun>,
  nextRun: DecisionRun,
) {
  const existing = current[nextRun.sessionId];
  if (existing) {
    if (existing.id !== nextRun.id) {
      const existingCreatedAt = new Date(existing.createdAt).getTime();
      const nextCreatedAt = new Date(nextRun.createdAt).getTime();
      if (
        existingCreatedAt > nextCreatedAt ||
        (existingCreatedAt === nextCreatedAt && existing.id > nextRun.id)
      ) {
        return current;
      }
    } else if (
      new Date(existing.updatedAt).getTime() >= new Date(nextRun.updatedAt).getTime()
    ) {
      return current;
    }
  }

  return {
    ...current,
    [nextRun.sessionId]: nextRun,
  };
}

export function mergeDecisionRuns(
  current: Record<string, DecisionRun>,
  runs: DecisionRun[],
) {
  return runs.reduce(mergeDecisionRun, current);
}

export function indexLatestDecisionRuns(runs: DecisionRun[]) {
  return mergeDecisionRuns({}, runs);
}

export function getStableDecisionSubmission(
  previous: PendingDecisionSubmission | null,
  input: DecisionSubmissionInput,
  createRequestId: () => string = () => crypto.randomUUID(),
): PendingDecisionSubmission {
  if (
    previous?.sessionId === input.sessionId &&
    previous.message === input.message &&
    previous.imageDataUrl === input.imageDataUrl &&
    previous.imageName === input.imageName
  ) {
    return previous;
  }

  return {
    ...input,
    clientRequestId: createRequestId(),
  };
}
