import type { ClothingItem } from "@/lib/types";

const CLOSET_ANALYSIS_OWNER_FLAG_PREFIX = "closet_analysis_owner:";

const analysisOwnedFields = [
  "name",
  "category",
  "color",
  "fit",
  "styleTags",
  "seasonTags",
  "scenarioTags",
  "palette",
  "imageQualityFlags",
  "aiConfidence",
  "userCorrected",
  "embeddingText",
  "summary",
] as const satisfies readonly (keyof ClothingItem)[];

const confirmationOwnedFields = [
  "name",
  "category",
  "color",
  "fit",
  "styleTags",
  "seasonTags",
  "scenarioTags",
  "wearFrequency",
  "palette",
  "imageQualityFlags",
  "userCorrected",
  "embeddingText",
  "embedding",
  "summary",
] as const satisfies readonly (keyof ClothingItem)[];

const displayOwnedFields = [
  "displayImagePath",
  "displayImageStatus",
  "displayImageModel",
  "displayImagePromptVersion",
  "displayImageUrl",
  "imageUrl",
] as const satisfies readonly (keyof ClothingItem)[];

export const claimableDisplayImageStatuses = [
  "not_started",
  "queued",
  "failed",
  "ready",
] as const satisfies readonly NonNullable<ClothingItem["displayImageStatus"]>[];

export type ClaimableDisplayImageStatus = (typeof claimableDisplayImageStatuses)[number];

type AnalysisOwnedField = (typeof analysisOwnedFields)[number];
type ConfirmationOwnedField = (typeof confirmationOwnedFields)[number];
type DisplayOwnedField = (typeof displayOwnedFields)[number];

export type ClosetAnalysisResult = Readonly<
  Partial<Pick<ClothingItem, AnalysisOwnedField>>
>;

export type ClosetConfirmationResult = Readonly<
  Partial<Pick<ClothingItem, ConfirmationOwnedField>>
>;

export type ClosetDisplayPatch = Readonly<Partial<Pick<ClothingItem, DisplayOwnedField>>>;

export type DisplayCompletionOutcome = "success" | "failure" | "warning";

export type DisplayCompletionNotice = Readonly<{
  itemId: string;
  outcome: DisplayCompletionOutcome;
}>;

export type DisplayCompletionNoticeSummary = Readonly<{
  outcome: DisplayCompletionOutcome | "mixed";
  message: string;
  successCount: number;
  failureCount: number;
  warningCount: number;
}>;

function hasOwn(object: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function pickOwnedFields(
  patch: Readonly<Partial<ClothingItem>>,
  fields: readonly (keyof ClothingItem)[],
) {
  return Object.fromEntries(
    fields.flatMap((field) => (hasOwn(patch, field) ? [[field, patch[field]]] : [])),
  ) as Partial<ClothingItem>;
}

export function filterLegacyDisplayImageFlags(
  flags: readonly string[] | null | undefined,
) {
  return (flags ?? []).filter(
    (flag) =>
      !flag.startsWith("display_image_") &&
      !flag.startsWith(CLOSET_ANALYSIS_OWNER_FLAG_PREFIX),
  );
}

function applyOwnedPatch(
  current: ClothingItem,
  patch: Readonly<Partial<ClothingItem>>,
  fields: readonly (keyof ClothingItem)[],
) {
  const ownedPatch = pickOwnedFields(patch, fields);

  if (hasOwn(ownedPatch, "imageQualityFlags")) {
    ownedPatch.imageQualityFlags = filterLegacyDisplayImageFlags(ownedPatch.imageQualityFlags);
  }

  return { ...current, ...ownedPatch };
}

export function applyClosetAnalysisResult(
  current: ClothingItem,
  result: ClosetAnalysisResult,
): ClothingItem {
  if (current.userCorrected) return current;
  return applyOwnedPatch(current, result, analysisOwnedFields);
}

export function applyClosetReanalysisResult(
  current: ClothingItem,
  result: ClosetAnalysisResult,
): ClothingItem {
  return applyOwnedPatch(current, result, analysisOwnedFields);
}

export function applyClosetConfirmationResult(
  current: ClothingItem,
  result: ClosetConfirmationResult,
): ClothingItem {
  return applyOwnedPatch(current, result, confirmationOwnedFields);
}

export function applyClosetDisplayPatch(
  current: ClothingItem,
  patch: ClosetDisplayPatch,
): ClothingItem {
  return applyOwnedPatch(current, patch, displayOwnedFields);
}

export function mergeDisplayCompletionNotices(
  current: readonly DisplayCompletionNotice[],
  incoming: DisplayCompletionNotice | readonly DisplayCompletionNotice[],
) {
  const noticesByItemId = new Map(current.map((notice) => [notice.itemId, notice]));
  const nextNotices = Array.isArray(incoming) ? incoming : [incoming];

  for (const notice of nextNotices) {
    noticesByItemId.set(notice.itemId, notice);
  }

  return [...noticesByItemId.values()];
}

export function formatDisplayCompletionNoticeSummary(
  notices: readonly DisplayCompletionNotice[],
  items: readonly Pick<ClothingItem, "id" | "name">[],
): DisplayCompletionNoticeSummary | null {
  if (notices.length === 0) return null;

  const successCount = notices.filter((notice) => notice.outcome === "success").length;
  const failureCount = notices.filter((notice) => notice.outcome === "failure").length;
  const warningCount = notices.length - successCount - failureCount;

  if (notices.length === 1) {
    const notice = notices[0];
    const itemName = items.find((item) => item.id === notice.itemId)?.name.trim() || "这件衣服";

    return {
      outcome: notice.outcome,
      message:
        notice.outcome === "success"
          ? `「${itemName}」的展示图已生成`
          : notice.outcome === "failure"
            ? `「${itemName}」的展示图生成失败`
            : `「${itemName}」的展示图状态待刷新确认`,
      successCount,
      failureCount,
      warningCount,
    };
  }

  if (failureCount === 0 && warningCount === 0) {
    return {
      outcome: "success",
      message: `${successCount} 件衣服的展示图已生成`,
      successCount,
      failureCount,
      warningCount,
    };
  }

  if (successCount === 0 && warningCount === 0) {
    return {
      outcome: "failure",
      message: `${failureCount} 件衣服的展示图生成失败`,
      successCount,
      failureCount,
      warningCount,
    };
  }

  if (successCount === 0 && failureCount === 0) {
    return {
      outcome: "warning",
      message: `${warningCount} 件衣服的展示图状态待刷新确认`,
      successCount,
      failureCount,
      warningCount,
    };
  }

  const parts = [
    successCount ? `${successCount} 件成功` : "",
    failureCount ? `${failureCount} 件失败` : "",
    warningCount ? `${warningCount} 件待刷新确认` : "",
  ].filter(Boolean);

  return {
    outcome: "mixed",
    message: `展示图处理完成：${parts.join("，")}`,
    successCount,
    failureCount,
    warningCount,
  };
}
