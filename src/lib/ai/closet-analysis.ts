import { z } from "zod";

export const closetAnalysisSchema = z.object({
  itemName: z.string().optional(),
  category: z.string().optional(),
  color: z.string().optional(),
  secondaryColors: z.array(z.string()).optional(),
  fit: z.enum(["slim", "regular", "oversized", "unknown"]).optional(),
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
  return `
请识别用户真实衣橱照片中的主要衣服，并把它转成衣橱 App 可用的结构化标签。

图片输入说明：
- 第一张图片是用户上传的原图，是主要事实来源。
- ${options.hasDisplayImage ? "第二张图片是 Qwen-Edit 生成的展示图，只能作为辅助观察衣服轮廓和细节，不能覆盖原图事实。" : "当前只有原图，请基于原图谨慎识别。"}
- 如果原图和展示图不一致，必须以原图为准，并在 reviewReasons 中说明需要用户确认。

识别原则：
- 只识别图片中最主要的单件衣服。
- 不猜测品牌、价格、购买渠道、用户身份、用户身材。
- 不使用淘宝/电商同款图作为依据。
- 如果背景复杂、衣服折叠、遮挡、光线偏色或不完整，请在 imageQualityFlags 和 reviewReasons 中标记。
- 如果版型、材质、长度无法确定，请写 unknown 或保守表达，不要强行判断。

图片文件名：${options.fileName ?? "unknown"}
${options.userFeedback?.trim() ? `\n用户对上一次识别的反馈：${options.userFeedback.trim()}\n请优先检查这条反馈提到的问题，并在不违背原图事实的前提下修正结构化标签。` : ""}

只输出严格 JSON，不要输出 Markdown 或解释文本。字段如下：
{
  "itemName": "适合展示给用户看的短名称，例如 白色宽松阔腿裤",
  "category": "品类，例如 衬衫/西装外套/连衣裙/半身裙/牛仔裤/长裤/运动鞋/包",
  "color": "主色，例如 白色/黑色/灰色/蓝色/米色，不确定用 unknown",
  "secondaryColors": ["辅助色"],
  "fit": "slim | regular | oversized | unknown",
  "length": "cropped | regular | long | unknown",
  "sleeveLength": "sleeveless | short | long | unknown",
  "materialGuess": "只能写视觉可见的可能材质，不确定用 unknown",
  "styleTags": ["简约", "通勤", "休闲", "运动", "温柔", "复古", "正式"],
  "season": ["spring", "summer", "autumn", "winter", "all-season"],
  "formality": 1,
  "scenarioTags": ["通勤", "日常", "约会", "面试", "旅行", "运动", "居家"],
  "imageQualityFlags": ["background_complex", "folded", "occluded", "partial_view", "low_light", "color_cast", "low_confidence"],
  "needsUserReview": true,
  "reviewReasons": ["需要用户确认的原因"],
  "summary": "一句话描述这件衣服，说明可见信息和不确定信息",
  "embeddingText": "用于衣橱 RAG 的自然语言摘要，包含品类、颜色、风格、场景、版型、季节和可见材质",
  "aiConfidence": 0.0
}

评分要求：
- formality 为 1-5，1 最休闲，5 最正式。
- aiConfidence 为 0-1。
- 如果衣服主体清楚但背景复杂，imageQualityFlags 应包含 background_complex，但不一定 low_confidence。
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
      result.materialGuess ? `可能材质：${result.materialGuess}` : "",
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
