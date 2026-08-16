import assert from "node:assert/strict";
import test from "node:test";

import type { ClosetMatch, RetrievalSlot } from "./types.ts";
import {
  buildDecisionImageEvidence,
  buildDecisionMessageContent,
  DECISION_OUTFIT_SELECTION_RULES,
  groupDecisionClosetMatches,
  normalizeDecisionTextArray,
  serializeIndependentDecisionPrompt,
  validateDecisionOutfitCombinations,
} from "./decision-evidence.ts";

function createMatch(
  index: number,
  slot: RetrievalSlot,
  originalImageUrl = `https://images.example/${index}.jpg`,
): ClosetMatch {
  return {
    matchType: "outfit",
    score: 90 - index,
    slot,
    role: slot,
    reason: `reason-${index}`,
    item: {
      id: `closet-${index}`,
      name: `单品 ${index}`,
      category: slot === "bottom" ? "长裤" : slot === "outerwear" ? "外套" : "上衣",
      color: "灰色",
      fit: "regular",
      styleTags: ["简约"],
      scenarioTags: ["日常"],
      wearFrequency: "often",
      status: "active",
      palette: "from-white to-gray",
      originalImageUrl: originalImageUrl || undefined,
    },
  };
}

test("keeps every per-slot candidate and builds deterministic image evidence", () => {
  const matches = [
    createMatch(1, "inner_top"),
    createMatch(2, "top"),
    createMatch(3, "bottom"),
    createMatch(4, "bottom"),
    createMatch(5, "bottom"),
    createMatch(6, "bottom"),
    createMatch(7, "outerwear"),
    createMatch(8, "onepiece", ""),
  ];

  const grouped = groupDecisionClosetMatches(matches);
  assert.equal(Object.values(grouped).flat().length, 8);
  assert.equal(grouped.bottom.length, 4);

  const evidence = buildDecisionImageEvidence("data:image/jpeg;base64,candidate", matches);
  assert.equal(evidence.length, 8);
  assert.match(evidence[0].label, /待买商品原图/);
  assert.match(evidence[1].label, /slot=inner_top.*closetItemId=closet-1/);
  assert.match(evidence[2].label, /slot=top.*closetItemId=closet-2/);
  assert.match(evidence.at(-1)?.label ?? "", /slot=outerwear.*closetItemId=closet-7/);
  assert.equal(evidence.some((entry) => entry.label.includes("closet-8")), false);
  assert.deepEqual(buildDecisionImageEvidence(undefined, matches), []);

  const content = buildDecisionMessageContent("prompt", evidence);
  assert.equal(content.length, 1 + evidence.length * 2);
  assert.deepEqual(content.slice(0, 3), [
    { type: "text", text: "prompt" },
    { type: "text", text: `Image 1：${evidence[0].label}` },
    { type: "image_url", image_url: { url: evidence[0].url, detail: "high" } },
  ]);
});

test("enforces the outfit whitelist, limits, and distinct combinations", () => {
  const matches = Array.from({ length: 7 }, (_, index) => createMatch(index + 1, "bottom"));
  const outfits = validateDecisionOutfitCombinations(
    [
      {
        title: "第一套",
        scenario: "通勤",
        summary: "可靠方案",
        items: ["单品 1", "单品 2"],
        closetItemIds: ["closet-1", "closet-2", "closet-3", "closet-4", "closet-5"],
      },
      {
        title: "重复方案",
        scenario: "通勤",
        summary: "顺序不同但集合相同",
        closetItemIds: ["closet-4", "closet-3", "closet-2", "closet-1"],
      },
      {
        title: "含越界 ID",
        scenario: "日常",
        summary: "只保留白名单内 ID",
        closetItemIds: ["invented-id", "closet-5"],
      },
      {
        title: "第三套",
        scenario: "旅行",
        summary: "不同核心单品",
        closetItemIds: ["closet-6"],
      },
      {
        title: "超过三套",
        scenario: "约会",
        summary: "不应进入结果",
        closetItemIds: ["closet-7"],
      },
    ],
    matches,
  );

  assert.equal(outfits.length, 3);
  assert.deepEqual(outfits[0].closetItemIds, ["closet-1", "closet-2", "closet-3", "closet-4"]);
  assert.deepEqual(outfits[1].closetItemIds, ["closet-5"]);
  assert.deepEqual(outfits[2].closetItemIds, ["closet-6"]);
  assert.equal(JSON.stringify(outfits).includes("invented-id"), false);
});

test("normalizes multimodal model object fields into readable strings", () => {
  assert.deepEqual(
    normalizeDecisionTextArray([
      { reason: "颜色协调", evidence: "图片中明度接近" },
      { risk: "衣长偏长", impact: "可能压低重心" },
    ]),
    ["颜色协调；图片中明度接近", "衣长偏长；可能压低重心"],
  );
});

test("keeps rule drafts out of the independent Terra prompt", () => {
  const prompt = serializeIndependentDecisionPrompt({
    task: "独立判断",
    outfitBoardRules: DECISION_OUTFIT_SELECTION_RULES,
    draftReport: { decision: "buy" },
    fallbackDraft: { decision: "save" },
  });
  const payload = JSON.parse(prompt) as Record<string, unknown>;

  assert.equal("draftReport" in payload, false);
  assert.equal("fallbackDraft" in payload, false);
  assert.match(String(payload.outfitBoardRules), /美观、协调和可穿性为首要目标/);
  assert.match(String(payload.outfitBoardRules), /不强制凑满/);
  assert.match(String(payload.outfitBoardRules), /效果不佳的方案必须舍弃/);
});

test("does not treat an optional outerwear-only change as a distinct core outfit", () => {
  const matches = [
    createMatch(1, "bottom"),
    createMatch(2, "outerwear"),
    createMatch(3, "bottom"),
  ];
  const outfits = validateDecisionOutfitCombinations(
    [
      { title: "基础套装", closetItemIds: ["closet-1"] },
      { title: "只增加外套", closetItemIds: ["closet-1", "closet-2"] },
      { title: "更换核心下装", closetItemIds: ["closet-3"] },
    ],
    matches,
  );

  assert.deepEqual(outfits.map((outfit) => outfit.title), ["基础套装", "更换核心下装"]);
});
