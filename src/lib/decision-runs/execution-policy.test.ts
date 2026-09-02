import assert from "node:assert/strict";
import test from "node:test";

import { getDecisionRunCompletionStatus } from "./execution-policy.ts";
import { shouldRetryTryOn } from "../ai/outfit-try-on.ts";

test("a text-only result completes when no try-on is eligible", () => {
  assert.equal(
    getDecisionRunCompletionStatus({ attempted: 0, ready: 0, failed: 0 }),
    "completed",
  );
});

test("a fully generated try-on batch completes", () => {
  assert.equal(
    getDecisionRunCompletionStatus({ attempted: 3, ready: 3, failed: 0 }),
    "completed",
  );
});

test("a partial try-on failure preserves the decision as completed with errors", () => {
  assert.equal(
    getDecisionRunCompletionStatus({ attempted: 3, ready: 2, failed: 1 }),
    "completed_with_errors",
  );
});

test("a failed try-on can be retried once while successful results remain final", () => {
  assert.equal(shouldRetryTryOn(0, { status: "failed" }), true);
  assert.equal(shouldRetryTryOn(1, { status: "failed" }), false);
  assert.equal(shouldRetryTryOn(0, { status: "ready", imagePath: "ready.png" }), false);
});
