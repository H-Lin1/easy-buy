import assert from "node:assert/strict";
import test from "node:test";

import {
  closetSeasonOptions,
  closetSeasonValues,
  normalizeClosetSeason,
  normalizeClosetSeasons,
} from "./season.ts";

test("defines the five Chinese canonical season values and matching options", () => {
  assert.deepEqual(closetSeasonValues, ["春季", "夏季", "秋季", "冬季", "四季"]);
  assert.deepEqual(
    closetSeasonOptions,
    closetSeasonValues.map((season) => ({ value: season, label: season })),
  );
});

test("normalizes English variants and common Chinese aliases", () => {
  const cases = [
    [" SPRING ", "春季"],
    ["spring-season", "春季"],
    ["夏天", "夏季"],
    ["Fall", "秋季"],
    ["fall season", "秋季"],
    ["冬", "冬季"],
    ["all-season", "四季"],
    ["ALL SEASONS", "四季"],
    ["year_round", "四季"],
    ["全年可穿", "四季"],
    ["四季皆宜", "四季"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeClosetSeason(input), expected);
  }
});

test("filters unknown values while preserving first-seen order and removing duplicates", () => {
  assert.deepEqual(
    normalizeClosetSeasons([
      "summer",
      "unsupported",
      "春季",
      "SUMMER",
      "fall",
      "秋天",
      null,
      "",
      "all seasons",
    ]),
    ["夏季", "春季", "秋季", "四季"],
  );
  assert.deepEqual(normalizeClosetSeasons(undefined), []);
});

test("normalizing canonical season values is idempotent", () => {
  const canonical = ["冬季", "春季", "四季"];

  assert.deepEqual(normalizeClosetSeasons(canonical), canonical);
  assert.deepEqual(normalizeClosetSeasons(normalizeClosetSeasons(canonical)), canonical);
});
