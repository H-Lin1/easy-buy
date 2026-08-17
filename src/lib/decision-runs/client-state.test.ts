import assert from "node:assert/strict";
import test from "node:test";

import {
  getStableDecisionSubmission,
  indexLatestDecisionRuns,
  mergeDecisionRun,
} from "./client-state.ts";
import type { DecisionRun } from "./model.ts";

function createRun(
  id: string,
  sessionId: string,
  createdAt: string,
  updatedAt = createdAt,
): DecisionRun {
  return {
    id,
    userId: "user-1",
    sessionId,
    clientRequestId: `request-${id}`,
    inputText: "test",
    screenshotPath: "test.jpg",
    stageData: {},
    status: "running",
    stage: "deciding",
    userMessageId: null,
    assistantMessageId: null,
    candidateId: null,
    reportId: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 1,
    startedAt: createdAt,
    decisionReadyAt: null,
    finishedAt: null,
    cancelledAt: null,
    createdAt,
    updatedAt,
  };
}

test("a stale query cannot overwrite a newer realtime update", () => {
  const realtimeRun = createRun(
    "run-a",
    "session-a",
    "2026-08-17T10:00:00.000Z",
    "2026-08-17T10:00:10.000Z",
  );
  const staleQueryRun = {
    ...realtimeRun,
    stage: "retrieving_context" as const,
    updatedAt: "2026-08-17T10:00:05.000Z",
  };

  const current = { "session-a": realtimeRun };
  assert.equal(mergeDecisionRun(current, staleQueryRun), current);
});

test("updating session A leaves session B isolated", () => {
  const sessionA = createRun("run-a", "session-a", "2026-08-17T10:00:00.000Z");
  const sessionB = createRun("run-b", "session-b", "2026-08-17T10:00:00.000Z");
  const updatedA = {
    ...sessionA,
    status: "completed" as const,
    stage: "completed" as const,
    updatedAt: "2026-08-17T10:00:20.000Z",
  };

  const next = mergeDecisionRun(
    { "session-a": sessionA, "session-b": sessionB },
    updatedA,
  );
  assert.equal(next["session-a"], updatedA);
  assert.equal(next["session-b"], sessionB);
});

test("only the newest run in each session is indexed", () => {
  const older = createRun("run-a1", "session-a", "2026-08-17T10:00:00.000Z");
  const newer = createRun("run-a2", "session-a", "2026-08-17T10:01:00.000Z");
  assert.equal(indexLatestDecisionRuns([newer, older])["session-a"], newer);
});

test("a network retry reuses its client request id until the input changes", () => {
  let generated = 0;
  const createRequestId = () => `request-${++generated}`;
  const input = {
    sessionId: "session-a",
    message: "这件值得买吗",
    imageDataUrl: "data:image/png;base64,AAAA",
    imageName: "item.png",
  };

  const first = getStableDecisionSubmission(null, input, createRequestId);
  const retry = getStableDecisionSubmission(first, input, createRequestId);
  const changed = getStableDecisionSubmission(
    retry,
    { ...input, message: "这件适合通勤吗" },
    createRequestId,
  );

  assert.equal(retry.clientRequestId, first.clientRequestId);
  assert.notEqual(changed.clientRequestId, first.clientRequestId);
  assert.equal(generated, 2);
});
