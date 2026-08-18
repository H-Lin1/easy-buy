import assert from "node:assert/strict";
import test from "node:test";

import {
  DECISION_RUN_POLL_INTERVAL_MS,
  deriveDecisionRunStatus,
  getDecisionRunPollingInterval,
  getDecisionRunStageLabel,
  getDecisionRunStageProgressIndex,
  isDecisionRunActive,
  isDecisionRunTerminal,
} from "./model.ts";

test("only queued and running decision runs are active", () => {
  assert.equal(isDecisionRunActive("queued"), true);
  assert.equal(isDecisionRunActive("running"), true);

  for (const status of [
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
  ] as const) {
    assert.equal(isDecisionRunTerminal(status), true);
    assert.equal(isDecisionRunActive(status), false);
  }
});

test("running stages derive user-visible decision and try-on states", () => {
  assert.equal(
    deriveDecisionRunStatus({ status: "running", stage: "retrieving_context" }),
    "working",
  );
  assert.equal(
    deriveDecisionRunStatus({ status: "running", stage: "decision_ready" }),
    "decision_ready",
  );
  assert.equal(
    deriveDecisionRunStatus({ status: "running", stage: "generating_try_ons" }),
    "generating_try_ons",
  );
});

test("database terminal states remain authoritative over a stale stage", () => {
  assert.equal(
    deriveDecisionRunStatus({ status: "cancelled", stage: "generating_try_ons" }),
    "cancelled",
  );
  assert.equal(
    deriveDecisionRunStatus({ status: "completed_with_errors", stage: "completed" }),
    "completed_with_errors",
  );
});

test("stage progress and labels follow the persisted stage order", () => {
  assert.equal(getDecisionRunStageProgressIndex("queued"), 0);
  assert.ok(
    getDecisionRunStageProgressIndex("decision_ready") <
      getDecisionRunStageProgressIndex("generating_try_ons"),
  );
  assert.equal(getDecisionRunStageProgressIndex("completed"), 6);
  assert.equal(getDecisionRunStageLabel("analyzing_candidate"), "识别待买商品截图");
});

test("five-second polling runs only while at least one run is active", () => {
  assert.equal(getDecisionRunPollingInterval([]), null);
  assert.equal(
    getDecisionRunPollingInterval([
      { status: "completed" },
      { status: "completed_with_errors" },
    ]),
    null,
  );
  assert.equal(
    getDecisionRunPollingInterval([{ status: "completed" }, { status: "queued" }]),
    DECISION_RUN_POLL_INTERVAL_MS,
  );
  assert.equal(
    getDecisionRunPollingInterval([{ status: "running" }]),
    5_000,
  );
});
