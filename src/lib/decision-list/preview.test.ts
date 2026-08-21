import assert from "node:assert/strict";
import test from "node:test";

import { hasDecisionTryOnImage, selectDecisionTryOnResult } from "./preview.ts";

test("selects a persisted try-on by outfit id before using position fallback", () => {
  const results = [
    { outfitId: "outfit-2", position: 1, status: "ready" as const, imageUrl: "two.jpg" },
    { outfitId: "outfit-1", position: 0, status: "failed" as const },
  ];

  assert.equal(selectDecisionTryOnResult(results, "outfit-1", 0)?.status, "failed");
  assert.equal(selectDecisionTryOnResult(results, "missing", 0)?.outfitId, "outfit-2");
});

test("only a ready result with an image counts as a visible preview", () => {
  assert.equal(hasDecisionTryOnImage({ outfitId: "a", position: 0, status: "ready", imageUrl: "a.jpg" }), true);
  assert.equal(hasDecisionTryOnImage({ outfitId: "b", position: 1, status: "ready" }), false);
  assert.equal(hasDecisionTryOnImage(undefined), false);
});
