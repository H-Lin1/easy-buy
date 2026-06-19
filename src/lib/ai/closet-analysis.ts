import { z } from "zod";

import { buildTaxonomyPromptBlock } from "@/lib/ai/taxonomy";

const fitSchema = z.preprocess(
  (value) => normalizeFitValue(value),
  z.enum(["slim", "regular", "oversized", "unknown"]),
);

export const closetAnalysisSchema = z.object({
  itemName: z.string().optional(),
  category: z.string().optional(),
  color: z.string().optional(),
  secondaryColors: z.array(z.string()).optional(),
  fit: fitSchema.optional(),
  length: z.string().optional(),
  sleeveLength: z.string().optional(),
  materialGuess: z.string().optional(),
  styleTags: z.array(z.string()).optional(),
  season: z.array(z.string()).optional(),
  formality: z.number().min(1).max(5).optional(),
  scenarioTags: z.array(z.string()).optional(),
  imageQualityFlags: z.array(z.string()).optional(),
  needsUserReview: z.boolean().optional(),
  reviewReasons: z.array(z.string()).optional(),
  summary: z.string().optional(),
  embeddingText: z.string().optional(),
  aiConfidence: z.number().min(0).max(1).optional(),
});

export type ClosetAnalysisResult = z.infer<typeof closetAnalysisSchema>;

export function buildClosetAnalysisPrompt(options: {
  fileName?: string;
  hasDisplayImage?: boolean;
  userFeedback?: string;
}) {
  const userFeedback = options.userFeedback?.trim();

  return `
请识别用户真实衣橱照片中的主要衣服，并把它转成衣橱 App 可用的结构化标签。

图片输入说明：
- 第一张图片是用户上传的原图，是主要事实来源。
- ${
    options.hasDisplayImage
      ? "第二张图片是 Qwen-Edit 生成的展示图，只能辅助观察轮廓、颜色和细节，不能覆盖原图事实。"
      : "当前只有原图，请基于原图谨慎识别。"
  }
- 如果原图和展示图不一致，必须以原图为准，并在 reviewReasons 里说明需要用户确认。

${buildTaxonomyPromptBlock()}

识别原则：
- 只识别图片中最主要的一件衣服。
- 不猜测品牌、真实价格、购买渠道、用户身份或用户身材。
- 不使用淘宝/电商同款图作为事实依据。
- 如果背景复杂、衣服折叠、遮挡、偏色、低光、只拍到局部或衣服不完整，请在 imageQualityFlags 和 reviewReasons 中标记。
- 如果品类、版型、材质、长度无法确定，写 unknown 或待确认，不要强行判断。
- fit 只能输出 slim、regular、oversized、unknown。修身/紧身对应 slim；合体/直筒/常规对应 regular；宽松/廓形/落肩对应 oversized。
- styleTags、scenarioTags、materialGuess 优先使用上面的标签体系。

图片文件名：${options.fileName ?? "unknown"}
${
  userFeedback
    ? `
用户对上一次识别的反馈：
${userFeedback}
请优先检查反馈提到的问题，并在不违背原图事实的前提下修正结构化标签。
`
    : ""
}

只输出严格 JSON，不要输出 Markdown 或解释文字。字段如下：
{
  "itemName": "适合展示给用户看的短名称，例如 白色宽松阔腿裤",
  "category": "品类，优先使用 taxonomy 里的中文品类，例如 Polo衫/防晒衣/冲锋衣/西装外套/背心/直筒裤/连衣裙",
  "color": "主色，例如 白色/黑色/灰色/牛仔蓝/米白/卡其色，不确定用 unknown",
  "secondaryColors": ["辅助色"],
  "fit": "slim | regular | oversized | unknown",
  "length": "cropped | regular | long | unknown",
  "sleeveLength": "sleeveless | short | long | unknown",
  "materialGuess": "视觉可见的可能材质或功能观感，例如 棉感/牛仔/雪纺/防晒面料/户外功能面料，不确定用 unknown",
  "styleTags": ["极简", "通勤", "休闲"],
  "season": ["spring", "summer", "autumn", "winter", "all-season"],
  "formality": 1,
  "scenarioTags": ["通勤", "日常出街", "旅行"],
  "imageQualityFlags": ["background_complex", "folded", "occluded", "partial_view", "low_light", "color_cast", "low_confidence"],
  "needsUserReview": true,
  "reviewReasons": ["需要用户确认的原因"],
  "summary": "一句话描述这件衣服，说明可见信息和不确定信息",
  "embeddingText": "用于衣橱 RAG 的自然语言摘要，包含品类、颜色、版型、风格、场景、季节、材质/功能观感和搭配价值",
  "aiConfidence": 0.0
}

评分要求：
- formality 为 1-5，1 最休闲，5 最正式。
- aiConfidence 为 0-1。
- 如果衣服主体清晰但背景复杂，imageQualityFlags 应包含 background_complex，但不一定 low_confidence。
- 如果 aiConfidence 低于 0.7，needsUserReview 必须为 true。
`.trim();
}

export function parseClosetAnalysisJson(content: string) {
  const cleaned = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch?.[0] ?? cleaned);

  return normalizeClosetAnalysis(closetAnalysisSchema.parse(parsed));
}

export function normalizeClosetAnalysis(result: ClosetAnalysisResult) {
  const category = cleanText(result.category) || "待确认品类";
  const color = cleanText(result.color) || "unknown";
  const itemName = cleanText(result.itemName) || buildItemName(color, category);
  const styleTags = uniqueNonEmpty(result.styleTags).slice(0, 6);
  const scenarioTags = uniqueNonEmpty(result.scenarioTags).slice(0, 6);
  const season = uniqueNonEmpty(result.season).slice(0, 5);
  const secondaryColors = uniqueNonEmpty(result.secondaryColors).slice(0, 4);
  const imageQualityFlags = uniqueNonEmpty(result.imageQualityFlags);
  const reviewReasons = uniqueNonEmpty(result.reviewReasons);
  const aiConfidence = clamp(result.aiConfidence ?? 0.65, 0, 1);
  const needsUserReview =
    result.needsUserReview ?? (aiConfidence < 0.8 || imageQualityFlags.includes("low_confidence"));
  const summary =
    cleanText(result.summary) ||
    `${itemName}，偏${fitLabel(result.fit ?? "unknown")}版型，适合${scenarioTags[0] ?? "日常"}场景。`;
  const embeddingText =
    cleanText(result.embeddingText) ||
    [
      itemName,
      `品类：${category}`,
      `颜色：${color}`,
      `版型：${fitLabel(result.fit ?? "unknown")}`,
      `风格：${styleTags.join("、") || "待确认"}`,
      `场景：${scenarioTags.join("、") || "待确认"}`,
      `季节：${season.join("、") || "待确认"}`,
      result.materialGuess ? `可能材质/功能：${result.materialGuess}` : "",
    ]
      .filter(Boolean)
      .join("；");

  return {
    itemName,
    category,
    color,
    secondaryColors,
    fit: result.fit ?? "unknown",
    length: cleanText(result.length) || "unknown",
    sleeveLength: cleanText(result.sleeveLength) || "unknown",
    materialGuess: cleanText(result.materialGuess) || "unknown",
    styleTags: styleTags.length ? styleTags : ["待确认"],
    season,
    formality: result.formality ? Math.round(clamp(result.formality, 1, 5)) : null,
    scenarioTags,
    imageQualityFlags,
    needsUserReview,
    reviewReasons,
    summary,
    embeddingText,
    aiConfidence,
  };
}

function buildItemName(color: string, category: string) {
  return `${color === "unknown" ? "" : color}${category}` || "待确认衣服";
}

function normalizeFitValue(value: unknown) {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["slim", "tight", "skinny", "修身", "紧身", "贴身"].includes(normalized)) return "slim";
  if (["oversized", "loose", "relaxed", "wide", "宽松", "廓形", "落肩"].includes(normalized)) {
    return "oversized";
  }
  if (["regular", "straight", "normal", "合体", "常规", "直筒", "正常"].includes(normalized)) {
    return "regular";
  }
  return normalized || "unknown";
}

function fitLabel(fit: NonNullable<ClosetAnalysisResult["fit"]>) {
  if (fit === "slim") return "修身";
  if (fit === "regular") return "常规";
  if (fit === "oversized") return "宽松";
  return "待确认";
}

function uniqueNonEmpty(values?: string[]) {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value && value.toLowerCase() !== "unknown"),
    ),
  );
}

function cleanText(value?: string) {
  const cleaned = value?.trim();
  return cleaned && cleaned.toLowerCase() !== "unknown" ? cleaned : undefined;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
