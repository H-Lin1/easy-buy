import assert from "node:assert/strict";
import test from "node:test";

import { classifyGarmentCategory, getGarmentEvidenceRole } from "./category.ts";

test("resolves overlapping garment names by specific category precedence", () => {
  assert.equal(classifyGarmentCategory("西装裤"), "bottom");
  assert.equal(classifyGarmentCategory("西装外套"), "outerwear");
  assert.equal(classifyGarmentCategory("连体裤"), "onepiece");
  assert.equal(classifyGarmentCategory("西装套装"), "onepiece");
  assert.equal(getGarmentEvidenceRole("西装裤"), "可搭裤装");
  assert.equal(getGarmentEvidenceRole("西装外套"), "可搭外套");
});

test("uses an explicit retrieval slot for new evidence labels", () => {
  assert.equal(getGarmentEvidenceRole("西装裤", undefined, "bottom"), "可搭裤装");
  assert.equal(getGarmentEvidenceRole("T恤", undefined, "inner_top"), "可搭内搭");
  assert.equal(getGarmentEvidenceRole("西装裤", undefined, "outerwear"), "可搭裤装");
});
