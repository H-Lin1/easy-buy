import { z } from "zod";

import { buildTaxonomyPromptBlock } from "@/lib/ai/taxonomy";
import type {
  CandidateCategoryGroup,
  CandidateWearRole,
  RetrievalSlot,
} from "@/lib/ai/types";

const fitSchema = z.preprocess(
  (value) => normalizeFitValue(value),
  z.enum(["slim", "regular", "oversized", "unknown"]),
);
const categoryGroupSchema = z.enum(["top", "outerwear", "bottom", "onepiece", "unknown"]);
const wearRoleSchema = z.enum([
  "standalone_top",
  "layerable_top",
  "inner_layer",
  "outer_layer",
  "functional_outer",
  "bottom",
  "onepiece",
  "set",
  "unknown",
]);
const retrievalSlotSchema = z.enum(["top", "inner_top", "outerwear", "bottom", "onepiece"]);

export const purchaseAnalysisSchema = z.object({
  productName: z.string().optional(),
  category: z.string().optional(),
  categoryGroup: categoryGroupSchema.optional(),
  itemCategoryId: z.string().optional(),
  color: z.string().optional(),
  secondaryColors: z.array(z.string()).optional(),
  fit: fitSchema.optional(),
  styleTags: z.array(z.string()).optional(),
  possibleScenarios: z.array(z.string()).optional(),
  estimatedPrice: z.preprocess((value) => {
    if (value === null || value === undefined || value === "") return undefined;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^\d.]/g, ""));
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return value;
  }, z.number().optional()),
  detectedText: z.string().optional(),
  sellingPoints: z.array(z.string()).optional(),
  wearRole: wearRoleSchema.optional(),
  retrievalSlots: z.array(retrievalSlotSchema).optional(),
  retrievalSlotReason: z.string().optional(),
  avoidSlots: z.array(retrievalSlotSchema).optional(),
  ambiguityFlags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  embeddingText: z.string().optional(),
  aiConfidence: z.number().min(0).max(1).optional(),
});

export type PurchaseAnalysisResult = z.infer<typeof purchaseAnalysisSchema>;

export function buildPurchaseAnalysisPrompt(options: { userIntent?: string }) {
  return `
请识别用户上传的待买服装商品截图，并转换成购买决策助手可用的结构化信息。

用户购买意图或提问：
${options.userIntent?.trim() || "用户未补充，请基于截图谨慎识别。"}

${buildTaxonomyPromptBlock()}

你需要完成 3 层判断：

1. 识别商品事实
- 识别截图中用户最可能想购买的主要服装商品。
- 只关注 MVP 范围：上衣、外套、下装、连衣裙/套装。
- 如果主体是鞋、包、配饰，请说明暂不属于 MVP 主范围，并降低 aiConfidence。
- 不要猜测品牌、真实价格或用户身份。
- 价格只能来自截图文字或用户补充；如果没有明确价格，不要输出 estimatedPrice。

2. 映射到知识库品类
- 请优先使用 taxonomy 中已有的中文品类名称，例如：
  T恤、Polo衫、衬衫、女式衬衫/罩衫、针织衫、毛衣、卫衣、连帽卫衣、背心、吊带、打底衫、防晒衫；
  西装外套、开衫、风衣、大衣、夹克、牛仔外套、皮衣、羽绒服、马甲/外穿背心、防晒衣、冲锋衣、软壳衣、抓绒衣、雨衣/雨壳、棒球夹克、工装外套、小香风外套、棉服；
  直筒裤、阔腿裤、牛仔裤、西装裤、休闲裤、工装裤、户外裤、运动裤、瑜伽裤、鲨鱼裤、打底裤、短裤、半身裙、A字裙、铅笔裙、百褶裙、裙裤；
  连衣裙、吊带连衣裙、西装连衣裙、旗袍、西装套装。

3. 判断穿搭角色和召回槽位
你需要判断这件待买衣服在一套穿搭中更像什么角色。

wearRole 可选值：
- standalone_top：可单穿上衣，例如 T恤、Polo衫、普通针织衫、普通卫衣
- layerable_top：可单穿也可外搭的上衣，例如宽松衬衫、防晒衫、开衫式上衣
- inner_layer：更适合作为内搭，例如打底衫、吊带、基础背心
- outer_layer：外套或外搭层，例如西装外套、风衣、夹克、开衫、防晒衣
- functional_outer：功能外套，例如冲锋衣、防晒衣、雨壳、软壳衣、抓绒衣
- bottom：下装，例如裤子、半身裙、短裤
- onepiece：一件式，例如连衣裙、旗袍
- set：套装，例如西装套装

retrievalSlots 可选值：
- top：召回普通上衣
- inner_top：召回内搭上衣
- outerwear：召回外套
- bottom：召回裤装/裙装
- onepiece：召回连衣裙/套装

召回槽位判断原则：
- 普通 T恤、Polo衫、卫衣、普通针织衫：优先召回 bottom，可选 outerwear；不要召回 inner_top。
- 普通衬衫：优先召回 bottom，可选 outerwear。
- 宽松外穿衬衫、防晒衫、开衫式上衣：可以召回 inner_top + bottom。
- 外套：召回 inner_top + bottom；也可以召回 onepiece。
- 功能外套：召回 inner_top + bottom，但要标记功能场景和日常化风险。
- 下装：召回 top，可选 outerwear。
- 普通连衣裙：召回 outerwear。
- 吊带连衣裙/背心裙：召回 outerwear，可选 inner_top。
- 套装：不要强行拆成上下装搭配；如果无法形成额外搭配，降低搭配扩展结论的确定性。

通用识别原则：
- fit 只能输出 slim、regular、oversized、unknown。修身/紧身对应 slim；合体/直筒/常规对应 regular；宽松/廓形/落肩对应 oversized。
- styleTags、possibleScenarios、sellingPoints、embeddingText 优先使用上面的标签体系。
- embeddingText 必须包含品类、颜色、版型、风格、场景、价格信息、卖点、潜在风险、穿搭角色和建议召回槽位，方便后续和真实衣橱做 RAG 检索。
- 识别结果服务长期主义购买判断：能否和真实衣橱形成稳定搭配，而不是只看商品图是否好看。

只输出严格 JSON，不要输出 Markdown。字段如下：
{
  "productName": "商品短名称，例如 灰蓝格纹短袖衬衫",
  "category": "taxonomy 中文品类，例如 衬衫",
  "categoryGroup": "top | outerwear | bottom | onepiece | unknown",
  "itemCategoryId": "taxonomy 英文 id，例如 shirt / polo / hardshell-jacket，不确定用 unknown",
  "color": "主色，例如 白色/黑色/灰色/牛仔蓝/米白/卡其色，不确定用 unknown",
  "secondaryColors": ["辅助色"],
  "fit": "slim | regular | oversized | unknown",
  "styleTags": ["极简", "通勤", "休闲"],
  "possibleScenarios": ["通勤", "日常出街", "旅行"],
  "estimatedPrice": 399,
  "detectedText": "截图中和商品相关的关键文字",
  "sellingPoints": ["卖点或可见特征，例如 防晒面料、宽松版型、易打理"],
  "wearRole": "standalone_top | layerable_top | inner_layer | outer_layer | functional_outer | bottom | onepiece | set | unknown",
  "retrievalSlots": ["bottom", "outerwear"],
  "retrievalSlotReason": "一句话说明为什么应该召回这些槽位，例如：这是一件可单穿短袖衬衫，优先用裤装或半身裙验证真实搭配，不需要额外内搭。",
  "avoidSlots": ["inner_top"],
  "ambiguityFlags": ["category_uncertain", "role_uncertain", "price_missing", "image_text_unclear"],
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
  const categoryGroup = normalizeCategoryGroup(result.categoryGroup, category);
  const wearRole = normalizeWearRole(result.wearRole, category, categoryGroup);
  const retrievalSlots = normalizeRetrievalSlots(result.retrievalSlots);
  const avoidSlots = normalizeRetrievalSlots(result.avoidSlots);
  const styleTags = uniqueNonEmpty(result.styleTags).slice(0, 8);
  const possibleScenarios = uniqueNonEmpty(result.possibleScenarios).slice(0, 8);
  const secondaryColors = uniqueNonEmpty(result.secondaryColors).slice(0, 4);
  const sellingPoints = uniqueNonEmpty(result.sellingPoints).slice(0, 8);
  const ambiguityFlags = uniqueNonEmpty(result.ambiguityFlags).slice(0, 8);
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
      categoryGroup,
      styleTags,
      possibleScenarios,
      estimatedPrice,
      sellingPoints,
      wearRole,
      retrievalSlots,
      retrievalSlotReason: cleanText(result.retrievalSlotReason),
      summary,
    });

  return {
    productName,
    category,
    categoryGroup,
    itemCategoryId: cleanText(result.itemCategoryId),
    color,
    secondaryColors,
    fit,
    styleTags: styleTags.length ? styleTags : ["待确认"],
    possibleScenarios: possibleScenarios.length ? possibleScenarios : ["日常出街"],
    estimatedPrice,
    detectedText,
    sellingPoints,
    wearRole,
    retrievalSlots,
    retrievalSlotReason: cleanText(result.retrievalSlotReason),
    avoidSlots,
    ambiguityFlags,
    summary,
    embeddingText,
    aiConfidence: clamp(result.aiConfidence ?? 0.7, 0, 1),
  };
}

export function buildPurchaseEmbeddingText(input: {
  productName: string;
  category: string;
  categoryGroup?: CandidateCategoryGroup;
  color: string;
  fit: "slim" | "regular" | "oversized" | "unknown";
  styleTags: string[];
  possibleScenarios: string[];
  estimatedPrice?: number;
  sellingPoints: string[];
  wearRole?: CandidateWearRole;
  retrievalSlots?: RetrievalSlot[];
  retrievalSlotReason?: string;
  summary: string;
}) {
  return [
    input.productName,
    `品类：${input.category}`,
    input.categoryGroup ? `品类大类：${input.categoryGroup}` : "",
    `颜色：${input.color}`,
    `版型：${fitLabel(input.fit)}`,
    `风格：${input.styleTags.join("、") || "待确认"}`,
    `场景：${input.possibleScenarios.join("、") || "待确认"}`,
    input.estimatedPrice ? `价格：${input.estimatedPrice}` : "价格：未知",
    `卖点：${input.sellingPoints.join("、") || "待确认"}`,
    input.wearRole ? `穿搭角色：${input.wearRole}` : "",
    input.retrievalSlots?.length ? `建议召回槽位：${input.retrievalSlots.join("、")}` : "",
    input.retrievalSlotReason ? `召回理由：${input.retrievalSlotReason}` : "",
    `摘要：${input.summary}`,
  ].filter(Boolean).join("；");
}

function buildProductName(color: string, category: string) {
  return `${color === "unknown" ? "" : color}${category}` || "待买商品";
}

function normalizeCategoryGroup(
  value: CandidateCategoryGroup | undefined,
  category: string,
): CandidateCategoryGroup {
  if (value && value !== "unknown") return value;
  if (/西装|外套|开衫|夹克|大衣|风衣|马甲|防晒衣|冲锋衣|软壳|硬壳|抓绒|雨衣|雨壳|棒球|工装外套|牛仔外套|皮衣|羽绒|棉服|小香风/.test(category)) {
    return "outerwear";
  }
  if (/衬衫|上衣|T恤|针织|卫衣|毛衣|背心|吊带|短上衣|Polo|POLO|polo|打底|防晒衫|雪纺|羊毛衫|羊绒|运动内衣/.test(category)) {
    return "top";
  }
  if (/裤|半身裙|短裙|长裙|牛仔裤|长裤|短裤|直筒|阔腿|西装裤|休闲裤|工装裤|户外裤|运动裤|卫裤|瑜伽裤|鲨鱼裤|打底裤|皮裤|裙裤|百褶裙|铅笔裙|A字裙/.test(category)) {
    return "bottom";
  }
  if (/连衣裙|套装|连体裤|旗袍/.test(category)) return "onepiece";
  return "unknown";
}

function normalizeWearRole(
  value: CandidateWearRole | undefined,
  category: string,
  categoryGroup: CandidateCategoryGroup,
): CandidateWearRole {
  if (value && value !== "unknown") return value;
  if (categoryGroup === "outerwear") {
    return /冲锋衣|防晒衣|雨衣|雨壳|软壳|硬壳|抓绒|风壳/.test(category)
      ? "functional_outer"
      : "outer_layer";
  }
  if (categoryGroup === "bottom") return "bottom";
  if (categoryGroup === "onepiece") return /套装/.test(category) ? "set" : "onepiece";
  if (/打底|吊带|运动内衣/.test(category)) return "inner_layer";
  if (/衬衫|开衫|防晒衫|马甲/.test(category)) return "layerable_top";
  if (categoryGroup === "top") return "standalone_top";
  return "unknown";
}

function normalizeRetrievalSlots(values?: RetrievalSlot[]) {
  return Array.from(new Set(values ?? []));
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
