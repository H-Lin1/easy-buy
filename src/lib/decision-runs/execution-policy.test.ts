import assert from "node:assert/strict";
import test from "node:test";

import { getDecisionRunCompletionStatus } from "./execution-policy.ts";

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
