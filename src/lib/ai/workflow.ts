import "server-only";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { closetItems as mockClosetItems } from "@/lib/mock-data";
import type { ClothingItem } from "@/lib/types";
import type {
  ClosetMatch,
  OutfitCombination,
  PurchaseAssessmentRequest,
  PurchaseCandidateAIProfile,
  PurchaseDecisionReport,
  PurchaseWorkflowState,
} from "@/lib/ai/types";
import { retrieveFashionKnowledge } from "@/lib/ai/knowledge";
import { buildPurchaseEmbeddingText } from "@/lib/ai/purchase-analysis";
import { embedText, generateDecisionJson, hasAutoDlConfig } from "@/lib/ai/providers";

const PurchaseState = Annotation.Root({
  request: Annotation<PurchaseAssessmentRequest>(),
  candidate: Annotation<PurchaseCandidateAIProfile | undefined>(),
  closetMatches: Annotation<ClosetMatch[]>({
    reducer: (_, value) => value,
    default: () => [],
  }),
  knowledgeSnippets: Annotation<PurchaseWorkflowState["knowledgeSnippets"]>({
    reducer: (_, value) => value,
    default: () => [],
  }),
  report: Annotation<PurchaseDecisionReport | undefined>(),
  errors: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

type GraphState = typeof PurchaseState.State;

export async function runPurchaseAssessment(request: PurchaseAssessmentRequest) {
  const graph = createPurchaseAssessmentGraph();
  const result = await graph.invoke({
    request,
    closetMatches: [],
    knowledgeSnippets: [],
    errors: [],
  });

  if (!result.report) {
    throw new Error("Purchase assessment workflow finished without a report.");
  }

  return result.report;
}

function createPurchaseAssessmentGraph() {
  return new StateGraph(PurchaseState)
    .addNode("understand_candidate", understandCandidate)
    .addNode("retrieve_closet", retrieveCloset)
    .addNode("retrieve_knowledge", retrieveKnowledge)
    .addNode("assess_purchase", assessPurchase)
    .addEdge(START, "understand_candidate")
    .addEdge("understand_candidate", "retrieve_closet")
    .addEdge("retrieve_closet", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "assess_purchase")
    .addEdge("assess_purchase", END)
    .compile();
}

async function understandCandidate(state: GraphState): Promise<Partial<GraphState>> {
  return {
    candidate: state.request.candidate ?? parseCandidateFromMessage(state.request.message),
  };
}

async function retrieveCloset(state: GraphState): Promise<Partial<GraphState>> {
  const candidate = state.candidate ?? state.request.candidate ?? parseCandidateFromMessage(state.request.message);
  const closetSource =
    state.request.closetItems?.length ? state.request.closetItems : mockClosetItems;
  const candidateEmbedding =
    state.request.candidateEmbedding ??
    (closetSource.some((item) => item.embedding?.length)
      ? await embedText(candidate.embeddingText ?? buildPurchaseEmbeddingText(candidate))
      : undefined);

  const matches = closetSource
    .flatMap((item) => scoreClosetItem(item, candidate, candidateEmbedding))
    .filter((match) => match.score >= 28)
    .sort((a, b) => b.score - a.score);

  const outfitMatches = uniqueByItem(matches.filter((match) => match.matchType === "outfit")).slice(0, 8);
  const duplicateMatches = uniqueByItem(matches.filter((match) => match.matchType === "duplicate")).slice(0, 5);
  const alternativeMatches = uniqueByItem(matches.filter((match) => match.matchType === "alternative")).slice(0, 3);

  return {
    closetMatches: [...outfitMatches, ...duplicateMatches, ...alternativeMatches].map(sanitizeMatch),
  };
}

async function retrieveKnowledge(state: GraphState): Promise<Partial<GraphState>> {
  const candidate = state.candidate ?? state.request.candidate ?? parseCandidateFromMessage(state.request.message);
  const query = [
    state.request.message,
    candidate.productName,
    candidate.category,
    candidate.color,
    candidate.fit,
    ...candidate.styleTags,
    ...candidate.possibleScenarios,
    ...candidate.sellingPoints,
    candidate.summary,
    candidate.embeddingText ?? "",
  ].join(" ");

  return {
    knowledgeSnippets: await retrieveFashionKnowledge(query, {
      topK: 8,
      candidate,
      embedding: state.request.candidateEmbedding,
      tags: [
        candidate.category,
        candidate.color,
        candidate.fit,
        ...candidate.styleTags,
        ...candidate.possibleScenarios,
      ],
    }),
  };
}

async function assessPurchase(state: GraphState): Promise<Partial<GraphState>> {
  const candidate = state.candidate ?? state.request.candidate ?? parseCandidateFromMessage(state.request.message);
  const fallbackReport = createFallbackReport(
    state.request,
    candidate,
    state.closetMatches,
    state.knowledgeSnippets,
  );

  if (!hasAutoDlConfig()) {
    return { report: fallbackReport };
  }

  try {
    const prompt = buildDecisionPrompt(state, fallbackReport);
    const startedAt = Date.now();
    console.info("[purchase-workflow] decision model start", {
      promptChars: prompt.length,
      closetMatches: state.closetMatches.length,
      knowledgeSnippets: state.knowledgeSnippets.length,
    });
    const json = await generateDecisionJson(prompt);
    console.info("[purchase-workflow] decision model done", {
      elapsedMs: Date.now() - startedAt,
      responseChars: json.length,
    });
    const parsed = normalizeModelReport(parseModelReport(json));

    return {
      report: {
        ...fallbackReport,
        ...parsed,
        candidate: fallbackReport.candidate,
        scores: {
          ...fallbackReport.scores,
          ...parsed.scores,
        },
        outfitCombinations: hydrateOutfitCombinations(
          fallbackReport.candidate,
          parsed.outfitCombinations ?? fallbackReport.outfitCombinations,
          fallbackReport.retrievedClosetItems,
        ),
        retrievedClosetItems: fallbackReport.retrievedClosetItems,
        knowledgeSnippets: fallbackReport.knowledgeSnippets,
        usedModel: true,
      },
    };
  } catch (error) {
    console.warn("[purchase-workflow] decision model failed, fallback used", {
      message: error instanceof Error ? error.message : "Decision model failed.",
    });
    return {
      report: fallbackReport,
      errors: [error instanceof Error ? error.message : "Decision model failed."],
    };
  }
}

function parseModelReport(content: string) {
  const cleaned = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(extractFirstJsonObject(cleaned)) as Partial<PurchaseDecisionReport>;
}

function normalizeModelReport(report: Partial<PurchaseDecisionReport>) {
  const normalized: Partial<PurchaseDecisionReport> = {
    ...report,
    outfitCombinations: Array.isArray(report.outfitCombinations)
      ? report.outfitCombinations
      : undefined,
  };
  const reasonsToBuy = toStringArray((report as { reasonsToBuy?: unknown }).reasonsToBuy);
  const reasonsToSave = toStringArray((report as { reasonsToSave?: unknown }).reasonsToSave);
  const risks = toStringArray((report as { risks?: unknown }).risks);
  const bodyFitNotes = toStringArray((report as { bodyFitNotes?: unknown }).bodyFitNotes);

  if (reasonsToBuy) normalized.reasonsToBuy = reasonsToBuy;
  if (reasonsToSave) normalized.reasonsToSave = reasonsToSave;
  if (risks) normalized.risks = risks;
  if (bodyFitNotes) normalized.bodyFitNotes = bodyFitNotes;

  return normalized;
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return undefined;
}

function extractFirstJsonObject(content: string) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return content.slice(start, index + 1);
    }
  }

  return content;
}

export function parseCandidateFromMessage(message: string): PurchaseCandidateAIProfile {
  const priceMatch = message.match(/(?:¥|￥|价格\s*)?(\d{2,5})/);
  const estimatedPrice = priceMatch ? Number(priceMatch[1]) : undefined;
  const color = inferFirst(message, ["米色", "白色", "黑色", "灰色", "蓝色", "卡其色", "棕色"], "米色");
  const category = inferFirst(
    message,
    [
      "西装外套",
      "防晒衣",
      "冲锋衣",
      "软壳衣",
      "抓绒衣",
      "风衣",
      "大衣",
      "外套",
      "Polo衫",
      "衬衫",
      "背心",
      "T恤",
      "连衣裙",
      "半身裙",
      "直筒裤",
      "阔腿裤",
      "牛仔裤",
      "长裤",
      "套装",
    ],
    "外套",
  );
  const fit = message.includes("紧身")
    ? "slim"
    : message.includes("宽松")
      ? "oversized"
      : "regular";
  const possibleScenarios = [
    ...(message.includes("通勤") || message.includes("上班") ? ["通勤"] : []),
    ...(message.includes("面试") ? ["面试"] : []),
    ...(message.includes("约会") ? ["约会"] : []),
    "日常",
  ];
  const candidate = {
    productName: `${color}${category}`,
    category,
    color,
    fit,
    styleTags: ["简约", possibleScenarios.includes("通勤") ? "通勤" : "休闲"],
    possibleScenarios: Array.from(new Set(possibleScenarios)),
    estimatedPrice,
    sellingPoints: ["基础款", "易搭配", "可覆盖多个场景"],
    summary: `候选商品是${color}${category}，偏${fit === "oversized" ? "宽松" : fit === "slim" ? "修身" : "常规"}版型。`,
  } satisfies PurchaseCandidateAIProfile;

  return {
    ...candidate,
    embeddingText: buildPurchaseEmbeddingText(candidate),
  };
}

function scoreClosetItem(
  item: ClothingItem,
  candidate: PurchaseCandidateAIProfile,
  candidateEmbedding?: number[],
): ClosetMatch[] {
  const itemGroup = classifyCategory(item.category);
  const candidateGroup = classifyCategory(candidate.category);
  const styleOverlap = overlapCount(item.styleTags, candidate.styleTags);
  const scenarioOverlap = overlapCount(item.scenarioTags, candidate.possibleScenarios);
  const seasonOverlap = overlapCount(item.seasonTags ?? [], ["all-season", "spring", "summer", "autumn", "winter"]);
  const semantic = item.embedding?.length && candidateEmbedding?.length
    ? Math.max(0, cosineSimilarity(item.embedding, candidateEmbedding))
    : 0;
  const semanticPoints = Math.round(semantic * 18);
  const sameGroup = itemGroup !== "unknown" && itemGroup === candidateGroup;
  const sameColor = normalizeColor(item.color) === normalizeColor(candidate.color);
  const categoryClose = sameGroup || textIncludesEither(item.category, candidate.category);
  const colorPoints = colorHarmonyScore(item.color, candidate.color);
  const frequencyScore =
    item.wearFrequency === "often" ? 10 : item.wearFrequency === "sometimes" ? 6 : item.wearFrequency === "rarely" ? 1 : 3;
  const userCorrectedScore = item.userCorrected === false ? -4 : 3;
  const complementScore = categoryComplementScore(candidateGroup, itemGroup);

  const outfitScore =
    34 +
    complementScore +
    colorPoints +
    styleOverlap * 8 +
    scenarioOverlap * 7 +
    Math.min(seasonOverlap * 3, 6) +
    frequencyScore +
    userCorrectedScore +
    semanticPoints -
    (sameGroup && sameColor ? 10 : 0);

  const duplicateScore =
    (categoryClose ? 28 : 0) +
    (sameColor ? 22 : 0) +
    styleOverlap * 8 +
    scenarioOverlap * 5 +
    frequencyScore +
    semanticPoints;

  const alternativeScore =
    (sameGroup ? 22 : 0) +
    (categoryClose ? 10 : 0) +
    colorPoints +
    styleOverlap * 7 +
    scenarioOverlap * 7 +
    frequencyScore +
    semanticPoints;

  return [
    {
      item,
      matchType: "outfit",
      score: clampScore(outfitScore),
      reason: buildMatchReason("outfit", item, candidate, semantic),
    },
    {
      item,
      matchType: "duplicate",
      score: clampScore(duplicateScore),
      reason: buildMatchReason("duplicate", item, candidate, semantic),
    },
    {
      item,
      matchType: "alternative",
      score: clampScore(alternativeScore),
      reason: buildMatchReason("alternative", item, candidate, semantic),
    },
  ];
}

function createFallbackReport(
  request: PurchaseAssessmentRequest,
  candidate: PurchaseCandidateAIProfile,
  matches: ClosetMatch[],
  knowledgeSnippets: PurchaseWorkflowState["knowledgeSnippets"],
): PurchaseDecisionReport {
  const outfitMatches = matches.filter((match) => match.matchType === "outfit").slice(0, 6);
  const duplicateMatches = matches.filter((match) => match.matchType === "duplicate").slice(0, 3);
  const duplicateRisk = duplicateMatches.length
    ? Math.min(95, Math.round(duplicateMatches.reduce((sum, match) => sum + match.score, 0) / duplicateMatches.length))
    : 18;
  const outfitPotential = Math.min(96, 48 + outfitMatches.length * 7);
  const styleConsistency = Math.min(96, 68 + outfitMatches.slice(0, 4).length * 5);
  const priceValue = candidate.estimatedPrice && candidate.estimatedPrice > 700 ? 65 : 82;
  const isSlimRisk = candidate.fit === "slim" && (request.userProfile?.bmi ?? 0) >= 24;
  const fitComfort = isSlimRisk ? 68 : candidate.fit === "unknown" ? 72 : 82;
  const decision = outfitPotential >= 78 && duplicateRisk < 70 ? "buy" : outfitPotential >= 62 ? "save" : "skip";

  const decisionMeta = {
    buy: {
      decisionStatus: "decided_to_buy" as const,
      decisionLabel: "建议决定买",
      nextStep: "确认尺码、面料和退换货规则后再下单。",
    },
    save: {
      decisionStatus: "saved_for_later" as const,
      decisionLabel: "建议先收藏",
      nextStep: "24 小时后再看一次，确认是否仍有真实穿着场景。",
    },
    skip: {
      decisionStatus: "not_considering" as const,
      decisionLabel: "建议暂不考虑",
      nextStep: "优先复用衣橱里已有替代单品，避免重复消费。",
    },
  }[decision];

  return {
    candidate,
    decision,
    ...decisionMeta,
    confidence: request.closetItems?.length ? 86 : 72,
    summary:
      request.closetItems?.length
        ? "从长期主义角度看，这次判断重点是它能否和你的真实衣橱产生稳定复用，而不是只看商品图是否好看。"
        : "当前真实衣橱数据不足，系统先用示例衣橱做演示判断。后续上传并确认更多衣服后，结论会更贴近你。",
    scores: {
      wardrobeFit: outfitMatches.length >= 3 ? 86 : outfitMatches.length >= 2 ? 74 : 58,
      outfitPotential,
      duplicateRisk,
      styleConsistency,
      priceValue,
      fitComfort,
      careCost: 80,
    },
    reasonsToBuy: [
      outfitMatches.length >= 2
        ? `能和已有衣橱中的「${outfitMatches.slice(0, 2).map((match) => match.item.name).join("」「")}」形成搭配证据。`
        : "如果后续能补充出至少 2 套真实搭配，再考虑购买会更稳。",
      `可覆盖${candidate.possibleScenarios.slice(0, 2).join("、")}等真实场景。`,
      "风格相对稳定，不只依赖单次折扣或模特图吸引。",
    ],
    reasonsToSave: [
      duplicateRisk >= 70
        ? "相似或同功能单品较多，建议先收藏并和已有衣服复盘。"
        : "如果只是被折扣或截图氛围吸引，建议先收藏 24 小时。",
      "需要确认面料、尺码、维护成本和退换规则是否符合日常穿着习惯。",
    ],
    risks: [
      duplicateRisk >= 70
        ? "已有相近单品较多，需要警惕重复购买。"
        : "重复购买风险目前可控，但仍需和已有替代单品比较。",
      candidate.estimatedPrice && candidate.estimatedPrice > 700
        ? "价格偏高，需要更明确的穿着频率支撑。"
        : "价格风险不高，重点看使用频率和搭配数量。",
    ],
    bodyFitNotes: [
      isSlimRisk
        ? "这件偏修身版型可能影响活动舒适度，建议优先确认弹性、肩胸围和退换货规则。"
        : "当前只基于基础档案提示版型和舒适度风险，不做身材或审美判断。",
    ],
    outfitCombinations: createOutfitCombinations(candidate, outfitMatches),
    retrievedClosetItems: matches,
    knowledgeSnippets,
    usedModel: false,
  };
}

function createOutfitCombinations(
  candidate: PurchaseCandidateAIProfile,
  matches: ClosetMatch[],
) {
  const first = matches.slice(0, 3);
  const second = matches.slice(3, 6);

  if (!first.length) {
    return [
      {
        title: "衣橱信息不足",
        scenario: candidate.possibleScenarios[0] ?? "日常",
        items: [candidate.productName],
        closetItemIds: [],
        summary: "当前可确认的衣橱单品不足，建议先补充常穿上衣、外套、下装或套装，再做更稳定的购买判断。",
        visualType: "evidence_board" as const,
        visualItems: [],
      },
    ];
  }

  return hydrateOutfitCombinations(
    candidate,
    [
      {
        title: "高复用搭配",
        scenario: candidate.possibleScenarios[0] ?? "日常",
        items: [candidate.productName, ...first.map((match) => match.item.name)],
        closetItemIds: first.map((match) => match.item.id),
        summary: "用已有高匹配单品承接候选商品，优先验证它是否能进入真实生活场景。",
      },
      {
        title: "替代灵感搭配",
        scenario: candidate.possibleScenarios[1] ?? "周末 / 日常",
        items: [candidate.productName, ...(second.length ? second : first).map((match) => match.item.name)],
        closetItemIds: (second.length ? second : first).map((match) => match.item.id),
        summary: "从不同场景检查搭配弹性，避免只为单一照片效果买单。",
      },
    ],
    matches,
  );
}

function hydrateOutfitCombinations(
  candidate: PurchaseCandidateAIProfile,
  combinations: OutfitCombination[],
  matches: ClosetMatch[],
): OutfitCombination[] {
  const outfitMatches = matches.filter((match) => match.matchType === "outfit");
  const matchById = new Map(matches.map((match) => [match.item.id, match]));
  const matchByName = new Map(matches.map((match) => [match.item.name, match]));

  return combinations.slice(0, 3).map((combination, index) => {
    const fallbackMatches = outfitMatches.slice(index * 3, index * 3 + 3);
    const namedMatches = (combination.items ?? [])
      .filter((itemName) => itemName !== candidate.productName)
      .map((itemName) => matchByName.get(itemName))
      .filter((match): match is ClosetMatch => Boolean(match));
    const idMatches = (combination.closetItemIds ?? [])
      .map((itemId) => matchById.get(itemId))
      .filter((match): match is ClosetMatch => Boolean(match));
    const selectedMatches = uniqueByItem([
      ...idMatches,
      ...namedMatches,
      ...fallbackMatches,
      ...outfitMatches,
    ]).slice(0, 4);

    return {
      ...combination,
      items: [candidate.productName, ...selectedMatches.map((match) => match.item.name)],
      closetItemIds: selectedMatches.map((match) => match.item.id),
      visualType: "evidence_board",
      visualItems: selectedMatches.map((match) => ({
        id: match.item.id,
        name: match.item.name,
        category: match.item.category,
        imageUrl: match.item.displayImageUrl ?? match.item.imageUrl ?? match.item.originalImageUrl,
        badge: match.item.wearFrequency === "often" ? "常穿" : match.matchType === "duplicate" ? "重复风险" : "已有衣橱",
        reason: match.reason,
        tags: [...match.item.styleTags, ...match.item.scenarioTags].slice(0, 4),
      })),
    };
  });
}

function buildDecisionPrompt(state: GraphState, fallbackReport: PurchaseDecisionReport) {
  return JSON.stringify({
    task: "基于长期主义输出衣服购买决策报告。请保持字段结构一致，直接输出 JSON。",
    outputSchema:
      "返回 JSON，字段包含 decision, decisionStatus, decisionLabel, confidence, summary, scores, reasonsToBuy, reasonsToSave, risks, bodyFitNotes, outfitCombinations, nextStep。",
    knowledgeUsage:
      "knowledge 是已检索的穿搭知识卡。请优先使用其中的 content、decisionPoints、riskSignals 和 outfitSuggestions 作为判断证据，并在 summary/reasons/risks/outfitCombinations 中体现具体知识，不要泛泛说百搭或好看。",
    userMessage: state.request.message,
    userProfile: state.request.userProfile,
    candidate: compactCandidate(state.candidate ?? fallbackReport.candidate),
    closetEvidence: state.closetMatches.slice(0, 6).map(compactClosetMatch),
    knowledge: state.knowledgeSnippets.slice(0, 5).map(compactKnowledgeSnippet),
    draftReport: compactDraftReport(fallbackReport),
    safety:
      "BMI 只能用于版型和舒适度风险提示，不允许身材羞辱，不允许绝对审美否定。建议必须温和，不要强硬否定用户审美。",
  });
}

function compactCandidate(candidate: PurchaseCandidateAIProfile) {
  return {
    productName: candidate.productName,
    category: candidate.category,
    color: candidate.color,
    fit: candidate.fit,
    styleTags: candidate.styleTags,
    possibleScenarios: candidate.possibleScenarios,
    estimatedPrice: candidate.estimatedPrice,
    sellingPoints: candidate.sellingPoints.slice(0, 4),
    summary: candidate.summary,
  };
}

function compactClosetMatch(match: ClosetMatch) {
  return {
    matchType: match.matchType,
    score: match.score,
    reason: match.reason,
    item: {
      id: match.item.id,
      name: match.item.name,
      category: match.item.category,
      color: match.item.color,
      fit: match.item.fit,
      styleTags: match.item.styleTags.slice(0, 3),
      scenarioTags: match.item.scenarioTags.slice(0, 3),
      wearFrequency: match.item.wearFrequency,
    },
  };
}

function compactKnowledgeSnippet(snippet: PurchaseWorkflowState["knowledgeSnippets"][number]) {
  return {
    cardId: snippet.cardId,
    topic: snippet.topic,
    knowledgeType: snippet.knowledgeType,
    tags: snippet.tags.slice(0, 6),
    decisionPoints: snippet.decisionPoints?.slice(0, 2),
    outfitSuggestions: snippet.outfitSuggestions?.slice(0, 2),
    riskSignals: snippet.riskSignals?.slice(0, 2),
  };
}

function compactDraftReport(report: PurchaseDecisionReport) {
  return {
    decision: report.decision,
    decisionStatus: report.decisionStatus,
    decisionLabel: report.decisionLabel,
    scores: report.scores,
    baseSummary: report.summary,
    outfitCombinations: report.outfitCombinations.slice(0, 3).map((combination) => ({
      title: combination.title,
      scenario: combination.scenario,
      items: combination.items.slice(0, 5),
      summary: combination.summary,
    })),
  };
}

function buildMatchReason(
  type: ClosetMatch["matchType"],
  item: ClothingItem,
  candidate: PurchaseCandidateAIProfile,
  semantic: number,
) {
  const semanticText = semantic >= 0.72 ? "，向量摘要也较接近" : "";
  if (type === "outfit") {
    return `可用于${candidate.possibleScenarios[0] ?? "日常"}搭配，和「${item.name}」在风格或场景上能互相承接${semanticText}。`;
  }
  if (type === "duplicate") {
    return `「${item.name}」在品类、颜色或使用场景上与候选商品接近，需要确认是否重复购买${semanticText}。`;
  }
  return `如果暂不购买，可优先复用「${item.name}」作为相近功能或相近风格的替代参考${semanticText}。`;
}

function classifyCategory(category: string) {
  if (/西装|外套|开衫|夹克|大衣|风衣|马甲|防晒衣|冲锋衣|软壳|硬壳|抓绒|雨衣|雨壳|棒球|工装外套|牛仔外套|皮衣|羽绒|棉服|小香风/.test(category)) return "outer";
  if (/衬衫|上衣|T恤|针织|卫衣|毛衣|背心|吊带|短上衣|Polo|POLO|polo|打底|防晒衫|雪纺|羊毛衫|羊绒|运动内衣/.test(category)) return "top";
  if (/裤|半身裙|短裙|长裙|牛仔裤|长裤|短裤|直筒|阔腿|西装裤|休闲裤|工装裤|户外裤|运动裤|卫裤|瑜伽裤|鲨鱼裤|打底裤|皮裤|裙裤|百褶裙|铅笔裙|A字裙/.test(category)) return "bottom";
  if (/连衣裙|套装|连体裤|旗袍/.test(category)) return "onepiece";
  return "unknown";
}

function categoryComplementScore(candidateGroup: string, itemGroup: string) {
  if (candidateGroup === "unknown" || itemGroup === "unknown") return 6;
  if (candidateGroup === itemGroup) return 2;
  const goodPairs = new Set([
    "outer:top",
    "outer:bottom",
    "outer:onepiece",
    "top:bottom",
    "top:outer",
    "top:onepiece",
    "bottom:top",
    "bottom:outer",
    "onepiece:outer",
    "onepiece:top",
  ]);

  return goodPairs.has(`${candidateGroup}:${itemGroup}`) ? 20 : 8;
}

function colorHarmonyScore(itemColor: string, candidateColor: string) {
  if (normalizeColor(itemColor) === normalizeColor(candidateColor)) return 8;
  if (isNeutralColor(itemColor) || isNeutralColor(candidateColor)) return 14;
  if (/蓝/.test(itemColor) && /白|米|灰|黑|棕|卡其/.test(candidateColor)) return 12;
  if (/蓝/.test(candidateColor) && /白|米|灰|黑|棕|卡其/.test(itemColor)) return 12;
  return 7;
}

function isNeutralColor(color: string) {
  return /黑|白|灰|米|卡其|棕|牛仔|蓝/.test(color);
}

function normalizeColor(color: string) {
  return color.replace(/\s/g, "").replace("浅", "").replace("深", "");
}

function overlapCount(a: string[] = [], b: string[] = []) {
  const normalizedB = new Set(b.map((item) => item.toLowerCase()));
  return a.filter((item) => normalizedB.has(item.toLowerCase())).length;
}

function textIncludesEither(a: string, b: string) {
  return a.includes(b) || b.includes(a);
}

function cosineSimilarity(a: number[], b: number[]) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  return dot / ((Math.sqrt(normA) || 1) * (Math.sqrt(normB) || 1));
}

function sanitizeMatch(match: ClosetMatch): ClosetMatch {
  return {
    ...match,
    item: {
      ...match.item,
      embedding: undefined,
    },
  };
}

function clampScore(value: number) {
  return Math.max(0, Math.min(98, Math.round(value)));
}

function inferFirst(message: string, candidates: string[], fallback: string) {
  return candidates.find((candidate) => message.includes(candidate)) ?? fallback;
}

function uniqueByItem(matches: ClosetMatch[]) {
  const seen = new Set<string>();

  return matches.filter((match) => {
    if (seen.has(match.item.id)) return false;
    seen.add(match.item.id);
    return true;
  });
}
