import assert from "node:assert/strict";
import test from "node:test";

import { filterClosetItems } from "./filter-items.ts";

const items = [
  {
    id: "shirt-1",
    name: "Oxford Shirt",
    category: "shirt",
    color: "White",
    styleTags: ["minimal"],
    scenarioTags: ["commute"],
    seasonTags: ["spring"],
  },
  {
    id: "coat-1",
    name: "Wool Coat",
    category: "outerwear",
    color: "Camel",
    styleTags: ["classic"],
    scenarioTags: ["weekend"],
    seasonTags: ["winter"],
  },
];

test("returns the original list for empty or whitespace-only queries", () => {
  assert.equal(filterClosetItems(items, ""), items);
  assert.equal(filterClosetItems(items, "   "), items);
});

test("matches names, attributes, and every supported tag group", () => {
  const cases = [
    ["Oxford", "shirt-1"],
    ["outer", "coat-1"],
    ["camel", "coat-1"],
    ["minimal", "shirt-1"],
    ["weekend", "coat-1"],
    ["winter", "coat-1"],
  ];

  for (const [query, expectedId] of cases) {
    assert.deepEqual(
      filterClosetItems(items, query).map((item) => item.id),
      [expectedId],
    );
  }
});

test("trims queries and ignores English letter case", () => {
  assert.deepEqual(
    filterClosetItems(items, "  oXfOrD  ").map((item) => item.id),
    ["shirt-1"],
  );
});

test("returns no items when nothing matches", () => {
  assert.deepEqual(filterClosetItems(items, "denim"), []);
});
