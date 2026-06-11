import { z } from "zod";

export const purchaseAnalysisSchema = z.object({
  productName: z.string().optional(),
  category: z.string().optional(),
  color: z.string().optional(),
  secondaryColors: z.array(z.string()).optional(),
  fit: z.enum(["slim", "regular", "oversized", "unknown"]).optional(),
  styleTags: z.array(z.string()).optional(),
  possibleScenarios: z.array(z.string()).optional(),
  estimatedPrice: z.number().optional(),
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
${options.userIntent?.trim() || "用户未补充，需基于截图谨慎识别。"}

识别原则：
- 只识别截图中用户最可能想购买的主要商品。
- 不要臆测品牌、真实价格或用户身份。价格只能来自截图文字或用户补充。
- 如果截图文字不清晰，价格和品类不确定时使用 unknown 或省略。
- 结果用于和用户真实衣橱做 RAG 检索，所以 embeddingText 必须包含品类、颜色、版型、风格、场景、价格信息和卖点。
- 输出建议要服务长期主义：能否复用、是否重复、是否有真实场景。

只输出严格 JSON，不要输出 Markdown。字段如下：
{
  "productName": "商品短名称，例如 米色宽松西装外套",
  "category": "品类，例如 西装外套/衬衫/连衣裙/半身裙/牛仔裤/长裤/运动鞋/包",
  "color": "主色，例如 白色/黑色/灰色/蓝色/米色，不确定用 unknown",
  "secondaryColors": ["辅助色"],
  "fit": "slim | regular | oversized | unknown",
  "styleTags": ["简约", "通勤", "休闲", "运动", "温柔", "复古", "正式"],
  "possibleScenarios": ["通勤", "日常", "约会", "面试", "旅行", "运动", "居家"],
  "estimatedPrice": 399,
  "detectedText": "截图中和商品相关的关键文字",
  "sellingPoints": ["卖点或可见特征"],
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
    possibleScenarios: possibleScenarios.length ? possibleScenarios : ["日常"],
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
