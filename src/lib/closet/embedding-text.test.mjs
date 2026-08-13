import assert from "node:assert/strict";
import test from "node:test";

import { buildClosetEmbeddingText, removeClosetConfirmationFlags } from "./embedding-text.ts";

test("confirmation removes analysis processing flags before committing user-owned fields", () => {
  assert.deepEqual(
    removeClosetConfirmationFlags([
      "original_saved",
      "ai_label_ready",
      "needs_ai_label_confirmation",
      "closet_analysis_processing",
      "closet_analysis_owner:00000000-0000-4000-8000-000000000000",
      "closet_analysis_failed",
    ]),
    ["original_saved", "ai_label_ready"],
  );
});

test("embedding text uses Chinese canonical season labels", () => {
  const text = buildClosetEmbeddingText({
    name: "黑色短袖T恤",
    category: "T恤",
    color: "黑色",
    fit: "regular",
    styleTags: ["休闲"],
    scenarioTags: ["日常"],
    seasonTags: ["spring", "夏天", "SPRING", "unsupported"],
    wearFrequency: "unknown",
  });

  assert.match(text, /季节：春季、夏季/);
  assert.doesNotMatch(text, /spring|unsupported/i);
});
