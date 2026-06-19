import { z } from "zod";

import { buildTaxonomyPromptBlock } from "@/lib/ai/taxonomy";

const fitSchema = z.preprocess(
  (value) => normalizeFitValue(value),
  z.enum(["slim", "regular", "oversized", "unknown"]),
);

export const purchaseAnalysisSchema = z.object({
  productName: z.string().optional(),
  category: z.string().optional(),
  color: z.string().optional(),
  secondaryColors: z.array(z.string()).optional(),
  fit: fitSchema.optional(),
  styleTags: z.array(z.string()).optional(),
  possibleScenarios: z.array(z.string()).optional(),
  estimatedPrice: z.preprocess((value) => {
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^\d.]/g, ""));
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return value;
  }, z.number().optional()),
  detectedText: z.string().optional(),
  sellingPoints: z.array(z.string()).optional(),
  summary: z.string().optional(),
  embeddingText: z.string().optional(),
  aiConfidence: z.number().min(0).max(1).optional(),
});

export type PurchaseAnalysisResult = z.infer<typeof purchaseAnalysisSchema>;

export function buildPurchaseAnalysisPrompt(options: { userIntent?: string }) {
  return `
请识别用户上传的待买衣服商品截图，并转成购买决策助手可用的结构化信息。

用户购买意图或提问：
${options.userIntent?.trim() || "用户未补充，请基于截图谨慎识别。"}

${buildTaxonomyPromptBlock()}

识别原则：
- 只识别截图中用户最可能想购买的主要服饰商品。
- MVP 只关注衣服、外套、裤装、裙装、套装；如果截图主体是鞋、包、配饰，请在 summary 中说明暂不属于 MVP 主范围，并降低 aiConfidence。
- 不要臆测品牌、真实价格或用户身份。价格只能来自截图文字或用户补充。
- 如果截图文字不清晰，价格和品类不确定时使用 unknown 或省略。
- fit 只能输出 slim、regular、oversized、unknown。修身/紧身对应 slim；合体/直筒/常规对应 regular；宽松/廓形/落肩对应 oversized。
- styleTags、possibleScenarios、sellingPoints、embeddingText 优先使用上面的标签体系。
- embeddingText 必须包含品类、颜色、版型、风格、场景、价格信息、卖点、潜在风险，方便后续和真实衣橱做 RAG 检索。
- 识别结果服务长期主义购买判断：能否复用、是否重复、是否有真实场景，而不是只看商品图是否好看。

只输出严格 JSON，不要输出 Markdown。字段如下：
{
  "productName": "商品短名称，例如 米色宽松西装外套",
  "category": "品类，优先使用 taxonomy 中文品类，例如 Polo衫/防晒衣/冲锋衣/西装外套/背心/直筒裤/连衣裙",
  "color": "主色，例如 白色/黑色/灰色/牛仔蓝/米白/卡其色，不确定用 unknown",
  "secondaryColors": ["辅助色"],
  "fit": "slim | regular | oversized | unknown",
  "styleTags": ["极简", "通勤", "休闲"],
  "possibleScenarios": ["通勤", "日常出街", "旅行"],
  "estimatedPrice": 399,
  "detectedText": "截图中和商品相关的关键文字",
  "sellingPoints": ["卖点或可见特征，例如 防晒面料、宽松版型、易打理"],
  "summary": "一句话描述这个待买商品",
  "embeddingText": "用于购买决策 RAG 的自然语言摘要",
  "aiConfidence": 0.0
}
`.trim();
}

export function parsePurchaseAnalysisJson(content: string) {
  const cleaned = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch?.[0] ?? cleaned);

  return normalizePurchaseAnalysis(purchaseAnalysisSchema.parse(parsed));
}

export function normalizePurchaseAnalysis(result: PurchaseAnalysisResult) {
  const category = cleanText(result.category) || "待确认品类";
  const color = cleanText(result.color) || "unknown";
  const productName = cleanText(result.productName) || buildProductName(color, category);
  const fit = result.fit ?? "unknown";
  const styleTags = uniqueNonEmpty(result.styleTags).slice(0, 8);
  const possibleScenarios = uniqueNonEmpty(result.possibleScenarios).slice(0, 8);
  const secondaryColors = uniqueNonEmpty(result.secondaryColors).slice(0, 4);
  const sellingPoints = uniqueNonEmpty(result.sellingPoints).slice(0, 8);
  const detectedText = cleanText(result.detectedText);
  const estimatedPrice =
    typeof result.estimatedPrice === "number" && Number.isFinite(result.estimatedPrice)
      ? result.estimatedPrice
      : undefined;
  const summary =
    cleanText(result.summary) ||
    `${productName}，偏${fitLabel(fit)}版型，适合${possibleScenarios[0] ?? "日常"}场景。`;
  const embeddingText =
    cleanText(result.embeddingText) ||
    buildPurchaseEmbeddingText({
      productName,
      category,
      color,
      fit,
      styleTags,
      possibleScenarios,
      estimatedPrice,
      sellingPoints,
      summary,
    });

  return {
    productName,
    category,
    color,
    secondaryColors,
    fit,
    styleTags: styleTags.length ? styleTags : ["待确认"],
    possibleScenarios: possibleScenarios.length ? possibleScenarios : ["日常出街"],
    estimatedPrice,
    detectedText,
    sellingPoints,
    summary,
    embeddingText,
    aiConfidence: clamp(result.aiConfidence ?? 0.7, 0, 1),
  };
}

export function buildPurchaseEmbeddingText(input: {
  productName: string;
  category: string;
  color: string;
  fit: "slim" | "regular" | "oversized" | "unknown";
  styleTags: string[];
  possibleScenarios: string[];
  estimatedPrice?: number;
  sellingPoints: string[];
  summary: string;
}) {
  return [
    input.productName,
    `品类：${input.category}`,
    `颜色：${input.color}`,
    `版型：${fitLabel(input.fit)}`,
    `风格：${input.styleTags.join("、") || "待确认"}`,
    `场景：${input.possibleScenarios.join("、") || "待确认"}`,
    input.estimatedPrice ? `价格：${input.estimatedPrice}` : "价格：未知",
    `卖点：${input.sellingPoints.join("、") || "待确认"}`,
    `摘要：${input.summary}`,
  ].join("；");
}

function buildProductName(color: string, category: string) {
  return `${color === "unknown" ? "" : color}${category}` || "待买商品";
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

function fitLabel(fit: "slim" | "regular" | "oversized" | "unknown") {
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
