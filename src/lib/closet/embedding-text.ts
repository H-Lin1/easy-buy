export type ClosetEmbeddingDraft = {
  name: string;
  category: string;
  color: string;
  fit: "slim" | "regular" | "oversized" | "unknown";
  styleTags: string[];
  scenarioTags: string[];
  seasonTags: string[];
  wearFrequency: "often" | "sometimes" | "rarely" | "unknown";
};

const fitLabels: Record<ClosetEmbeddingDraft["fit"], string> = {
  slim: "修身",
  regular: "常规",
  oversized: "宽松",
  unknown: "待确认",
};

const wearFrequencyLabels: Record<ClosetEmbeddingDraft["wearFrequency"], string> = {
  often: "常穿",
  sometimes: "偶尔穿",
  rarely: "闲置",
  unknown: "待确认",
};

export function buildClosetEmbeddingText(draft: ClosetEmbeddingDraft) {
  return [
    draft.name,
    `品类：${draft.category}`,
    `颜色：${draft.color}`,
    `版型：${fitLabels[draft.fit]}`,
    `风格：${draft.styleTags.join("、") || "待确认"}`,
    `场景：${draft.scenarioTags.join("、") || "待确认"}`,
    `季节：${draft.seasonTags.join("、") || "待确认"}`,
    `穿着频率：${wearFrequencyLabels[draft.wearFrequency]}`,
  ].join("；");
}

export function removeClosetConfirmationFlags(flags?: string[]) {
  const removable = new Set([
    "needs_ai_label_confirmation",
    "closet_analysis_queued",
    "closet_analysis_processing",
    "closet_analysis_failed",
  ]);

  return (flags ?? []).filter((flag) => !removable.has(flag));
}
