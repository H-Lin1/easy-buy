import assert from "node:assert/strict";
import test from "node:test";

import {
  applyClosetAnalysisResult,
  applyClosetConfirmationResult,
  applyClosetDisplayPatch,
  applyClosetReanalysisResult,
  claimableDisplayImageStatuses,
  filterLegacyDisplayImageFlags,
  formatDisplayCompletionNoticeSummary,
  mergeDisplayCompletionNotices,
} from "./display-workflow.ts";

function createItem(overrides = {}) {
  return {
    id: "item-1",
    name: "旧名称",
    category: "shirt",
    color: "white",
    fit: "regular",
    styleTags: ["minimal"],
    seasonTags: ["spring"],
    scenarioTags: ["commute"],
    wearFrequency: "often",
    status: "active",
    palette: "old-palette",
    imagePath: "original/item-1.jpg",
    displayImagePath: "display/current.png",
    displayImageStatus: "ready",
    displayImageModel: "current-model",
    displayImagePromptVersion: "current-v2",
    displayImageUrl: "https://example.com/current.png",
    originalImageUrl: "https://example.com/original.jpg",
    imageQualityFlags: ["original_saved", "ai_label_ready"],
    aiConfidence: 0.72,
    userCorrected: false,
    embeddingText: "old embedding text",
    summary: "旧名称",
    ...overrides,
  };
}

test("analysis applies only analysis-owned fields and ignores stale display fields", () => {
  const current = createItem();
  const result = {
    ...createItem({
      name: "浅灰蓝运动短袖T恤",
      category: "t-shirt",
      color: "gray-blue",
      wearFrequency: "rarely",
      palette: "new-palette",
      imageQualityFlags: ["ai_label_ready", "display_image_processing"],
      displayImagePath: undefined,
      displayImageStatus: "processing",
      displayImageModel: "stale-model",
      displayImagePromptVersion: "stale-v1",
      displayImageUrl: undefined,
    }),
  };

  const updated = applyClosetAnalysisResult(current, result);

  assert.equal(updated.name, "浅灰蓝运动短袖T恤");
  assert.equal(updated.category, "t-shirt");
  assert.equal(updated.color, "gray-blue");
  assert.equal(updated.wearFrequency, current.wearFrequency);
  assert.equal(updated.palette, "new-palette");
  assert.deepEqual(updated.imageQualityFlags, ["ai_label_ready"]);
  assert.equal(updated.displayImagePath, current.displayImagePath);
  assert.equal(updated.displayImageStatus, current.displayImageStatus);
  assert.equal(updated.displayImageModel, current.displayImageModel);
  assert.equal(updated.displayImagePromptVersion, current.displayImagePromptVersion);
  assert.equal(updated.displayImageUrl, current.displayImageUrl);
});

test("confirmation after display completion preserves every display-owned field", () => {
  const displayed = createItem();
  const staleConfirmationResponse = createItem({
    name: "用户确认名称",
    category: "tee",
    color: "blue",
    styleTags: ["sport"],
    seasonTags: ["summer"],
    scenarioTags: ["fitness"],
    imageQualityFlags: ["original_saved", "display_image_processing"],
    userCorrected: true,
    embeddingText: "confirmed embedding text",
    summary: "用户确认名称",
    displayImagePath: undefined,
    displayImageStatus: "processing",
    displayImageModel: "stale-model",
    displayImagePromptVersion: "stale-v1",
    displayImageUrl: undefined,
  });

  const updated = applyClosetConfirmationResult(displayed, staleConfirmationResponse);

  assert.equal(updated.name, "用户确认名称");
  assert.equal(updated.userCorrected, true);
  assert.equal(updated.embeddingText, "confirmed embedding text");
  assert.deepEqual(updated.imageQualityFlags, ["original_saved"]);
  assert.equal(updated.displayImagePath, displayed.displayImagePath);
  assert.equal(updated.displayImageStatus, "ready");
  assert.equal(updated.displayImageModel, displayed.displayImageModel);
  assert.equal(updated.displayImagePromptVersion, displayed.displayImagePromptVersion);
  assert.equal(updated.displayImageUrl, displayed.displayImageUrl);
});

test("display completion after confirmation preserves user-owned fields", () => {
  const confirmed = createItem({
    name: "用户确认名称",
    category: "tee",
    color: "blue",
    styleTags: ["sport"],
    userCorrected: true,
    embeddingText: "confirmed embedding text",
    embedding: [0.1, 0.2],
    displayImagePath: undefined,
    displayImageStatus: "processing",
    displayImageUrl: undefined,
  });
  const displayResponseWithStaleUserData = {
    ...createItem({
      name: "旧 AI 名称",
      userCorrected: false,
      embeddingText: "stale embedding text",
      displayImagePath: "display/new.png",
      displayImageStatus: "ready",
      displayImageModel: "new-model",
      displayImagePromptVersion: "new-v3",
      displayImageUrl: "https://example.com/new.png",
      imageUrl: "https://example.com/new.png",
    }),
  };

  const updated = applyClosetDisplayPatch(confirmed, displayResponseWithStaleUserData);

  assert.equal(updated.displayImagePath, "display/new.png");
  assert.equal(updated.displayImageStatus, "ready");
  assert.equal(updated.displayImageModel, "new-model");
  assert.equal(updated.displayImagePromptVersion, "new-v3");
  assert.equal(updated.displayImageUrl, "https://example.com/new.png");
  assert.equal(updated.imageUrl, "https://example.com/new.png");
  assert.equal(updated.name, "用户确认名称");
  assert.equal(updated.category, "tee");
  assert.equal(updated.userCorrected, true);
  assert.equal(updated.embeddingText, "confirmed embedding text");
  assert.deepEqual(updated.embedding, [0.1, 0.2]);
});

test("display failure updates only status and keeps the previous image and confirmed data", () => {
  const current = createItem({ userCorrected: true });
  const updated = applyClosetDisplayPatch(current, { displayImageStatus: "failed" });

  assert.equal(updated.displayImageStatus, "failed");
  assert.equal(updated.displayImagePath, current.displayImagePath);
  assert.equal(updated.displayImageUrl, current.displayImageUrl);
  assert.equal(updated.name, current.name);
  assert.equal(updated.userCorrected, true);
});

test("confirmation-first and display-first response orders converge on the same item", () => {
  const initial = createItem({
    displayImagePath: undefined,
    displayImageStatus: "processing",
    displayImageUrl: undefined,
  });
  const confirmation = {
    name: "最终名称",
    category: "tee",
    color: "navy",
    userCorrected: true,
    embeddingText: "final embedding",
    summary: "最终名称",
  };
  const display = {
    displayImagePath: "display/final.png",
    displayImageStatus: "ready",
    displayImageModel: "final-model",
    displayImagePromptVersion: "final-v4",
    displayImageUrl: "https://example.com/final.png",
  };

  const confirmationFirst = applyClosetDisplayPatch(
    applyClosetConfirmationResult(initial, confirmation),
    display,
  );
  const displayFirst = applyClosetConfirmationResult(
    applyClosetDisplayPatch(initial, display),
    confirmation,
  );

  assert.deepEqual(confirmationFirst, displayFirst);
});

test("a late analysis result cannot overwrite user-confirmed fields", () => {
  const confirmed = createItem({
    name: "用户确认名称",
    category: "tee",
    color: "navy",
    styleTags: ["sport"],
    userCorrected: true,
    embeddingText: "confirmed embedding",
    imageQualityFlags: ["original_saved"],
  });
  const staleAnalysis = {
    name: "迟到的 AI 名称",
    category: "shirt",
    color: "white",
    styleTags: ["minimal"],
    userCorrected: false,
    embeddingText: "stale embedding",
    imageQualityFlags: ["ai_label_ready", "needs_ai_label_confirmation"],
  };

  assert.deepEqual(applyClosetAnalysisResult(confirmed, staleAnalysis), confirmed);
});

test("an explicit user reanalysis can replace confirmed fields with a pending draft", () => {
  const confirmed = createItem({
    name: "用户确认名称",
    category: "tee",
    color: "navy",
    styleTags: ["sport"],
    userCorrected: true,
    embeddingText: "confirmed embedding",
  });
  const reanalysisDraft = {
    name: "重新识别名称",
    category: "shirt",
    color: "white",
    styleTags: ["minimal"],
    userCorrected: false,
    embeddingText: "reanalysis draft",
    imageQualityFlags: ["ai_label_ready", "needs_ai_label_confirmation"],
  };

  const updated = applyClosetReanalysisResult(confirmed, reanalysisDraft);

  assert.equal(updated.name, "重新识别名称");
  assert.equal(updated.category, "shirt");
  assert.equal(updated.userCorrected, false);
  assert.equal(updated.embeddingText, "reanalysis draft");
  assert.equal(updated.displayImagePath, confirmed.displayImagePath);
  assert.equal(updated.displayImageStatus, confirmed.displayImageStatus);
});

test("a failed explicit reanalysis can restore the original confirmed fields", () => {
  const confirmed = createItem({
    name: "用户确认名称",
    category: "tee",
    color: "navy",
    styleTags: ["sport"],
    userCorrected: true,
    embeddingText: "confirmed embedding",
  });
  const localProcessingState = {
    ...confirmed,
    styleTags: ["AI 识别中"],
    imageQualityFlags: ["closet_analysis_processing", "needs_ai_label_confirmation"],
  };

  const restored = applyClosetReanalysisResult(localProcessingState, confirmed);

  assert.equal(restored.name, "用户确认名称");
  assert.equal(restored.category, "tee");
  assert.deepEqual(restored.styleTags, ["sport"]);
  assert.equal(restored.userCorrected, true);
  assert.equal(restored.embeddingText, "confirmed embedding");
  assert.equal(restored.displayImagePath, confirmed.displayImagePath);
});

test("filters every legacy display workflow flag without changing other flags", () => {
  assert.deepEqual(
    filterLegacyDisplayImageFlags([
      "original_saved",
      "display_image_queued",
      "ai_label_ready",
      "display_image_processing",
      "display_image_ready",
      "display_image_failed",
      "closet_analysis_owner:00000000-0000-4000-8000-000000000000",
    ]),
    ["original_saved", "ai_label_ready"],
  );
  assert.deepEqual(filterLegacyDisplayImageFlags(undefined), []);
  assert.deepEqual(filterLegacyDisplayImageFlags(null), []);
});

test("exports the exact statuses that may claim display generation ownership", () => {
  assert.deepEqual(claimableDisplayImageStatuses, [
    "not_started",
    "queued",
    "failed",
    "ready",
  ]);
  assert.equal(claimableDisplayImageStatuses.includes("processing"), false);
});

test("merges active notices without mutation and keeps only the newest result per item", () => {
  const current = [
    { itemId: "item-1", outcome: "success" },
    { itemId: "item-2", outcome: "failure" },
  ];
  const incoming = [
    { itemId: "item-1", outcome: "failure" },
    { itemId: "item-3", outcome: "success" },
    { itemId: "item-3", outcome: "failure" },
  ];

  const merged = mergeDisplayCompletionNotices(current, incoming);

  assert.deepEqual(merged, [
    { itemId: "item-1", outcome: "failure" },
    { itemId: "item-2", outcome: "failure" },
    { itemId: "item-3", outcome: "failure" },
  ]);
  assert.deepEqual(current, [
    { itemId: "item-1", outcome: "success" },
    { itemId: "item-2", outcome: "failure" },
  ]);
  assert.deepEqual(incoming, [
    { itemId: "item-1", outcome: "failure" },
    { itemId: "item-3", outcome: "success" },
    { itemId: "item-3", outcome: "failure" },
  ]);
});

test("formats single notices with the item's current name and a safe fallback", () => {
  assert.deepEqual(
    formatDisplayCompletionNoticeSummary(
      [{ itemId: "item-1", outcome: "success" }],
      [{ id: "item-1", name: "用户刚修改的名称" }],
    ),
    {
      outcome: "success",
      message: "「用户刚修改的名称」的展示图已生成",
      successCount: 1,
      failureCount: 0,
      warningCount: 0,
    },
  );
  assert.deepEqual(
    formatDisplayCompletionNoticeSummary(
      [{ itemId: "missing", outcome: "failure" }],
      [],
    ),
    {
      outcome: "failure",
      message: "「这件衣服」的展示图生成失败",
      successCount: 0,
      failureCount: 1,
      warningCount: 0,
    },
  );
  assert.deepEqual(
    formatDisplayCompletionNoticeSummary(
      [{ itemId: "item-1", outcome: "warning" }],
      [{ id: "item-1", name: "预览待刷新" }],
    ),
    {
      outcome: "warning",
      message: "「预览待刷新」的展示图状态待刷新确认",
      successCount: 0,
      failureCount: 0,
      warningCount: 1,
    },
  );
});

test("formats all-success, all-failure, and mixed batch summaries", () => {
  assert.deepEqual(
    formatDisplayCompletionNoticeSummary(
      [
        { itemId: "item-1", outcome: "success" },
        { itemId: "item-2", outcome: "success" },
      ],
      [],
    ),
    {
      outcome: "success",
      message: "2 件衣服的展示图已生成",
      successCount: 2,
      failureCount: 0,
      warningCount: 0,
    },
  );
  assert.deepEqual(
    formatDisplayCompletionNoticeSummary(
      [
        { itemId: "item-1", outcome: "failure" },
        { itemId: "item-2", outcome: "failure" },
      ],
      [],
    ),
    {
      outcome: "failure",
      message: "2 件衣服的展示图生成失败",
      successCount: 0,
      failureCount: 2,
      warningCount: 0,
    },
  );
  assert.deepEqual(
    formatDisplayCompletionNoticeSummary(
      [
        { itemId: "item-1", outcome: "success" },
        { itemId: "item-2", outcome: "failure" },
        { itemId: "item-3", outcome: "success" },
      ],
      [],
    ),
    {
      outcome: "mixed",
      message: "展示图处理完成：2 件成功，1 件失败",
      successCount: 2,
      failureCount: 1,
      warningCount: 0,
    },
  );
  assert.deepEqual(
    formatDisplayCompletionNoticeSummary(
      [
        { itemId: "item-1", outcome: "success" },
        { itemId: "item-2", outcome: "failure" },
        { itemId: "item-3", outcome: "warning" },
      ],
      [],
    ),
    {
      outcome: "mixed",
      message: "展示图处理完成：1 件成功，1 件失败，1 件待刷新确认",
      successCount: 1,
      failureCount: 1,
      warningCount: 1,
    },
  );
  assert.equal(formatDisplayCompletionNoticeSummary([], []), null);
});
