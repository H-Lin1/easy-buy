import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./season") {
      return nextResolve("./season.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  createEmptyClosetFilters,
  filterClosetItems,
  getClosetFilterOptions,
} = await import("./filter-items.ts");

function createItem(overrides = {}) {
  return {
    id: "item",
    name: "Oxford Shirt",
    category: "shirt",
    color: "White",
    fit: "regular",
    styleTags: ["minimal"],
    scenarioTags: ["commute"],
    seasonTags: ["春季"],
    wearFrequency: "often",
    status: "active",
    palette: "from-stone-100 to-stone-200",
    ...overrides,
  };
}

const items = [
  createItem({
    id: "shirt-1",
    name: "Oxford Shirt",
    category: " Shirt ",
    color: "White",
    styleTags: ["minimal", "commute"],
    scenarioTags: ["office"],
    seasonTags: ["春季"],
    wearFrequency: "often",
  }),
  createItem({
    id: "coat-1",
    name: "Wool Coat",
    category: "outerwear",
    color: "Camel",
    styleTags: ["classic"],
    scenarioTags: ["weekend"],
    seasonTags: ["冬季"],
    wearFrequency: "sometimes",
  }),
  createItem({
    id: "dress-1",
    name: "Black Dress",
    category: "dress",
    color: "Black",
    styleTags: ["minimal", "evening"],
    scenarioTags: ["date"],
    seasonTags: ["四季"],
    wearFrequency: "rarely",
    status: "idle",
  }),
  createItem({
    id: "pending-1",
    name: "Pending Item",
    category: "待确认",
    color: "unknown",
    styleTags: ["待识别"],
    scenarioTags: [],
    seasonTags: [],
    wearFrequency: "unknown",
  }),
];

function ids(result) {
  return result.map((item) => item.id);
}

function filters(overrides) {
  return { ...createEmptyClosetFilters(), ...overrides };
}

test("returns the original list for empty, whitespace-only, or blank-only conditions", () => {
  assert.equal(filterClosetItems(items, ""), items);
  assert.equal(filterClosetItems(items, "   "), items);
  assert.equal(filterClosetItems(items, "", filters({ categories: ["   "] })), items);
});

test("matches names, attributes, and every supported tag group", () => {
  const cases = [
    ["Oxford", "shirt-1"],
    ["outer", "coat-1"],
    ["camel", "coat-1"],
    ["minimal", "shirt-1", "dress-1"],
    ["weekend", "coat-1"],
    ["冬季", "coat-1"],
  ];

  for (const [query, ...expectedIds] of cases) {
    assert.deepEqual(ids(filterClosetItems(items, query)), expectedIds);
  }
});

test("searches seasons with Chinese canonical words instead of English storage values", () => {
  const legacyItem = createItem({ id: "legacy-spring", seasonTags: ["spring"] });

  assert.deepEqual(ids(filterClosetItems([legacyItem], "春季")), ["legacy-spring"]);
  assert.deepEqual(ids(filterClosetItems([legacyItem], "spring")), []);
});

test("trims queries and ignores English letter case", () => {
  assert.deepEqual(ids(filterClosetItems(items, "  oXfOrD  ")), ["shirt-1"]);
});

test("returns no items when nothing matches", () => {
  assert.deepEqual(filterClosetItems(items, "denim"), []);
});

test("uses OR within category, style, color, season, and status filters", () => {
  assert.deepEqual(
    ids(filterClosetItems(items, "", filters({ categories: [" SHIRT ", "outerwear"] }))),
    ["shirt-1", "coat-1"],
  );
  assert.deepEqual(
    ids(filterClosetItems(items, "", filters({ styles: ["classic", "evening"] }))),
    ["coat-1", "dress-1"],
  );
  assert.deepEqual(
    ids(filterClosetItems(items, "", filters({ colors: ["white", "black"] }))),
    ["shirt-1", "dress-1"],
  );
  assert.deepEqual(
    ids(filterClosetItems(items, "", filters({ seasons: ["冬季", "夏季"] }))),
    ["coat-1", "dress-1"],
  );
  assert.deepEqual(
    ids(filterClosetItems(items, "", filters({ statuses: ["sometimes", "unknown"] }))),
    ["coat-1", "pending-1"],
  );
});

test("uses AND across dimensions and with the keyword search", () => {
  const selected = filters({
    categories: ["shirt", "dress"],
    styles: ["minimal"],
    colors: ["white"],
  });

  assert.deepEqual(ids(filterClosetItems(items, "", selected)), ["shirt-1"]);
  assert.deepEqual(ids(filterClosetItems(items, "Oxford", selected)), ["shirt-1"]);
  assert.deepEqual(ids(filterClosetItems(items, "Dress", selected)), []);
  assert.deepEqual(ids(filterClosetItems(items, "", selected)), ["shirt-1"]);
});

test("matches all-season items for specific seasons but not the reverse", () => {
  assert.deepEqual(
    ids(filterClosetItems(items, "", filters({ seasons: ["春季"] }))),
    ["shirt-1", "dress-1"],
  );
  assert.deepEqual(
    ids(filterClosetItems(items, "", filters({ seasons: ["四季"] }))),
    ["dress-1"],
  );
});

test("normalizes legacy season values before applying Chinese filters", () => {
  const legacyItems = [
    createItem({ id: "legacy-autumn", seasonTags: ["fall"] }),
    createItem({ id: "legacy-all-season", seasonTags: ["all-season"] }),
  ];

  assert.deepEqual(
    ids(filterClosetItems(legacyItems, "", filters({ seasons: ["秋季"] }))),
    ["legacy-autumn", "legacy-all-season"],
  );
  assert.deepEqual(
    ids(filterClosetItems(legacyItems, "", filters({ seasons: ["四季"] }))),
    ["legacy-all-season"],
  );
});

test("handles missing season and wear-frequency values without using lifecycle status", () => {
  const legacyItems = [
    createItem({
      id: "legacy-1",
      seasonTags: undefined,
      wearFrequency: undefined,
      status: "idle",
    }),
  ];

  assert.deepEqual(
    ids(filterClosetItems(legacyItems, "", filters({ seasons: ["冬季"] }))),
    [],
  );
  assert.deepEqual(
    ids(filterClosetItems(legacyItems, "", filters({ statuses: ["unknown"] }))),
    ["legacy-1"],
  );
  assert.deepEqual(
    ids(filterClosetItems(legacyItems, "", filters({ statuses: ["rarely"] }))),
    [],
  );
});

test("derives stable, de-duplicated dynamic options from the full wardrobe", () => {
  const options = getClosetFilterOptions([
    createItem({
      id: "first",
      category: " Shirt ",
      color: " White ",
      styleTags: [" Minimal ", "Commute"],
    }),
    createItem({
      id: "second",
      category: "shirt",
      color: "white",
      styleTags: ["minimal", "Classic"],
    }),
    createItem({ id: "third", category: "", color: " ", styleTags: [] }),
  ]);

  assert.deepEqual(options.categories, [{ value: "shirt", label: "Shirt" }]);
  assert.deepEqual(options.colors, [{ value: "white", label: "White" }]);
  assert.deepEqual(options.styles, [
    { value: "minimal", label: "Minimal" },
    { value: "commute", label: "Commute" },
    { value: "classic", label: "Classic" },
  ]);
  assert.deepEqual(
    options.seasons,
    [
      { value: "春季", label: "春季" },
      { value: "夏季", label: "夏季" },
      { value: "秋季", label: "秋季" },
      { value: "冬季", label: "冬季" },
      { value: "四季", label: "四季" },
    ],
  );
  assert.deepEqual(
    options.statuses.map((option) => option.value),
    ["often", "sometimes", "rarely", "unknown"],
  );
});

test("does not mutate filters and preserves source item order", () => {
  const selected = filters({ categories: ["shirt", "dress"] });
  const sourceIds = ids(items);

  assert.deepEqual(ids(filterClosetItems(items, "", selected)), ["shirt-1", "dress-1"]);
  assert.deepEqual(selected.categories, ["shirt", "dress"]);
  assert.deepEqual(ids(items), sourceIds);
});
