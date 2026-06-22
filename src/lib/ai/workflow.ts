import "server-only";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { closetItems as mockClosetItems } from "@/lib/mock-data";
import type { ClothingItem } from "@/lib/types";
import type {
  CandidateWearRole,
  ClosetMatch,
  OutfitCombination,
  PurchaseAssessmentRequest,
  PurchaseCandidateAIProfile,
  PurchaseDecisionReport,
  PurchaseWorkflowState,
  RetrievalSlot,
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
type InternalCategoryGroup = "top" | "outer" | "bottom" | "onepiece" | "unknown";
type RetrievalSlotDefinition = {
  slot: RetrievalSlot;
  role: string;
  itemGroups: InternalCategoryGroup[];
  maxItems: number;
  priority: number;
  optional?: boolean;
};
type RetrievalPlan = {
  candidateGroup: InternalCategoryGroup;
  wearRole: CandidateWearRole;
  slots: RetrievalSlotDefinition[];
  rejectedModelSlots: RetrievalSlot[];
  source: "model" | "rule" | "mixed";
  reason: string;
};

const SLOT_LABELS: Record<RetrievalSlot, string> = {
  top: "可搭上衣",
  inner_top: "可搭内搭",
  outerwear: "可搭外套",
  bottom: "可搭下装",
  onepiece: "可搭连衣裙/套装",
};

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

export async function runPurchaseAssessmentTrace(request: PurchaseAssessmentRequest) {
  const steps: Array<{
    id: string;
    title: string;
    elapsedMs: number;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }> = [];
  let state = {
    request,
    candidate: undefined,
    closetMatches: [],
    knowledgeSnippets: [],
    report: undefined,
    errors: [],
  } as unknown as GraphState;

  async function runStep(
    id: string,
    title: string,
    input: Record<string, unknown>,
    runner: () => Promise<Partial<GraphState>>,
    outputBuilder: (update: Partial<GraphState>, nextState: GraphState) => Record<string, unknown>,
  ) {
    const startedAt = Date.now();
    const update = await runner();
    const nextState = {
      ...state,
      ...update,
    } as GraphState;
    steps.push({
      id,
      title,
      elapsedMs: Date.now() - startedAt,
      input,
      output: outputBuilder(update, nextState),
    });
    state = nextState;
  }

  await runStep(
    "understand_candidate",
    "理解待买商品",
    {
      message: request.message,
      hasImage: Boolean(request.imageDataUrl),
      hasCandidateFromRoute: Boolean(request.candidate),
    },
    () => understandCandidate(state),
    (_update, nextState) => ({
      candidate: nextState.candidate ? compactCandidate(nextState.candidate) : null,
      embeddingText: nextState.candidate?.embeddingText,
    }),
  );

  await runStep(
    "retrieve_closet",
    "衣橱 RAG 检索",
    {
      candidate: state.candidate ? compactCandidate(state.candidate) : null,
      closetSourceCount: request.closetItems?.length ?? 0,
      hasCandidateEmbedding: Boolean(request.candidateEmbedding?.length),
      retrievalPlan: state.candidate ? compactRetrievalPlan(buildRetrievalPlan(state.candidate)) : null,
      retrievalRule:
        "先按待买商品的穿搭角色生成召回槽位，每个槽位分别 Top K，再交给决策模型二次筛选是否真的能成套。",
    },
    () => retrieveCloset(state),
    (_update, nextState) => ({
      totalMatches: nextState.closetMatches.length,
      byMatchType: summarizeMatchesByType(nextState.closetMatches),
      topMatches: nextState.closetMatches.slice(0, 12).map(compactClosetMatch),
    }),
  );

  await runStep(
    "retrieve_knowledge",
    "穿搭知识库 RAG 检索",
    {
      candidate: state.candidate ? compactCandidate(state.candidate) : null,
      tags: state.candidate
        ? [
            state.candidate.category,
            state.candidate.color,
            state.candidate.fit,
            ...state.candidate.styleTags,
            ...state.candidate.possibleScenarios,
          ]
        : [],
      topK: 8,
    },
    () => retrieveKnowledge(state),
    (_update, nextState) => ({
      totalSnippets: nextState.knowledgeSnippets.length,
      snippets: nextState.knowledgeSnippets.slice(0, 8).map(compactKnowledgeSnippet),
    }),
  );

  const candidate = state.candidate ?? state.request.candidate ?? parseCandidateFromMessage(state.request.message);
  const fallbackReport = createFallbackReport(
    state.request,
    candidate,
    state.closetMatches,
    state.knowledgeSnippets,
  );
  const prompt = buildDecisionPrompt(state, fallbackReport);
  const assessStartedAt = Date.now();
  let finalReport: PurchaseDecisionReport;
  let modelOutput: Record<string, unknown>;

  if (!hasAutoDlConfig()) {
    finalReport = fallbackReport;
    modelOutput = {
      usedModel: false,
      fallbackReason: "AutoDL 模型配置不存在，使用规则兜底报告。",
    };
  } else {
    try {
      console.info("[purchase-workflow] decision model start", {
        promptChars: prompt.length,
        closetMatches: state.closetMatches.length,
        knowledgeSnippets: state.knowledgeSnippets.length,
      });
      const decisionResult = await generateNormalizedDecisionReport(prompt);
      const json = decisionResult.raw;
      console.info("[purchase-workflow] decision model done", {
        elapsedMs: Date.now() - assessStartedAt,
        responseChars: json.length,
        attempts: decisionResult.attempts,
      });
      const parsed = decisionResult.parsed;
      finalReport = {
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
      };
      modelOutput = {
        usedModel: true,
        rawResponseChars: json.length,
        attempts: decisionResult.attempts,
        parsedDecision: parsed.decision,
        parsedDecisionLabel: parsed.decisionLabel,
      };
    } catch (error) {
      finalReport = fallbackReport;
      modelOutput = {
        usedModel: false,
        fallbackReason: error instanceof Error ? error.message : "Decision model failed.",
      };
    }
  }

  finalReport = sanitizeOutfitFocusReport(finalReport);

  steps.push({
    id: "assess_purchase",
    title: "长期主义购买决策",
    elapsedMs: Date.now() - assessStartedAt,
    input: {
      promptChars: prompt.length,
      prompt: JSON.parse(prompt) as Record<string, unknown>,
      fallbackDraft: compactDraftReport(fallbackReport),
    },
    output: {
      ...modelOutput,
      decision: finalReport.decision,
      decisionStatus: finalReport.decisionStatus,
      decisionLabel: finalReport.decisionLabel,
      confidence: finalReport.confidence,
      scores: finalReport.scores,
      reasonsToBuy: finalReport.reasonsToBuy,
      reasonsToSave: finalReport.reasonsToSave,
      risks: finalReport.risks,
      outfitCombinations: finalReport.outfitCombinations.map(compactOutfitCombination),
      summary: finalReport.summary,
    },
  });

  return {
    report: finalReport,
    trace: steps,
  };
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
  const retrievalPlan = buildRetrievalPlan(candidate);

  const matches = retrievalPlan.slots.flatMap((slot) => {
    const slotMatches = closetSource
      .map((item) => scoreClosetItem(item, candidate, slot, retrievalPlan, candidateEmbedding))
      .filter((match): match is ClosetMatch => Boolean(match))
      .filter((match) => match.score >= 34)
      .sort((a, b) => b.score - a.score)
      .slice(0, slot.maxItems);

    return slotMatches;
  });
  const outfitMatches = uniqueByItem(matches)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return {
    closetMatches: outfitMatches.map(sanitizeMatch),
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

  const snippets = await retrieveFashionKnowledge(query, {
    topK: 12,
    candidate,
    embedding: state.request.candidateEmbedding,
    tags: [
      candidate.category,
      candidate.color,
      candidate.fit,
      ...candidate.styleTags,
      ...candidate.possibleScenarios,
    ],
  });
  const outfitFocusedSnippets = filterOutfitFocusedKnowledge(snippets).slice(0, 8);

  return {
    knowledgeSnippets: outfitFocusedSnippets.length ? outfitFocusedSnippets : snippets.slice(0, 8),
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
    return { report: sanitizeOutfitFocusReport(fallbackReport) };
  }

  try {
    const prompt = buildDecisionPrompt(state, fallbackReport);
    const startedAt = Date.now();
    console.info("[purchase-workflow] decision model start", {
      promptChars: prompt.length,
      closetMatches: state.closetMatches.length,
      knowledgeSnippets: state.knowledgeSnippets.length,
    });
    const decisionResult = await generateNormalizedDecisionReport(prompt);
    const json = decisionResult.raw;
    console.info("[purchase-workflow] decision model done", {
      elapsedMs: Date.now() - startedAt,
      responseChars: json.length,
      attempts: decisionResult.attempts,
    });
    const parsed = decisionResult.parsed;

    const modelReport = sanitizeOutfitFocusReport({
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
      });

    return {
      report: modelReport,
    };
  } catch (error) {
    console.warn("[purchase-workflow] decision model failed, fallback used", {
      message: error instanceof Error ? error.message : "Decision model failed.",
    });
    return {
      report: sanitizeOutfitFocusReport(fallbackReport),
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

async function generateNormalizedDecisionReport(prompt: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw = "";

    try {
      raw = await generateDecisionJson(prompt);
      return {
        raw,
        attempts: attempt,
        parsed: normalizeModelReport(parseModelReport(raw)),
      };
    } catch (error) {
      lastError = error;
      console.warn("[purchase-workflow] decision JSON attempt failed", {
        attempt,
        responseChars: raw.length,
        message: error instanceof Error ? error.message : "Decision model failed.",
      });
    }
  }

  throw new Error(
    `Decision model failed after retry: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
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

function filterOutfitFocusedKnowledge(
  snippets: PurchaseWorkflowState["knowledgeSnippets"],
) {
  const blockedPattern = /重复|替代|相似|同功能|已有|同类|近似|类似|冗余|凑数/;

  return snippets.filter((snippet) => {
    const text = [
      snippet.topic,
      snippet.content,
      ...(snippet.tags ?? []),
      ...(snippet.decisionPoints ?? []),
      ...(snippet.riskSignals ?? []),
      ...(snippet.outfitSuggestions ?? []),
      JSON.stringify(snippet.decisionBias ?? {}),
    ].join(" ");

    return !blockedPattern.test(text);
  });
}

function sanitizeOutfitFocusReport(report: PurchaseDecisionReport): PurchaseDecisionReport {
  const reasonsToBuy = filterOutfitFocusTexts(report.reasonsToBuy);
  const reasonsToSave = filterOutfitFocusTexts(report.reasonsToSave);
  const risks = filterOutfitFocusTexts(report.risks);

  return {
    ...report,
    summary:
      cleanupOutfitFocusText(report.summary) ||
      "本次判断聚焦于候选商品是否能和真实衣橱形成自然、可复用的搭配组合。",
    reasonsToBuy: reasonsToBuy.length
      ? reasonsToBuy
      : ["当前可搭配候选需要结合颜色、品类、场景和版型进一步确认是否真的自然成套。"],
    reasonsToSave: reasonsToSave.length
      ? reasonsToSave
      : ["如果可确认的真实搭配少于 2 套，建议先收藏观察，不要因为单张商品图直接下单。"],
    risks: risks.length
      ? risks
      : ["Top K 只是候选召回结果，仍需要人工或模型确认是否存在颜色、版型、场景不协调的问题。"],
    nextStep:
      cleanupOutfitFocusText(report.nextStep) ||
      "优先验证能否用现有衣橱搭出 2-3 套真实场景搭配，再决定是否购买。",
    scores: {
      ...report.scores,
      duplicateRisk: 0,
    },
  };
}

function filterOutfitFocusTexts(items: string[]) {
  return items
    .map(cleanupOutfitFocusText)
    .filter((item): item is string => Boolean(item));
}

function cleanupOutfitFocusText(text?: string) {
  if (!text) return "";
  const blockedPattern = /重复|替代|相似|同功能|已有|同类|近似|类似|冗余|凑数/;
  const keptSentences = text
    .split(/(?<=[。！？；;])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !blockedPattern.test(sentence));

  return keptSentences.join("");
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
  const trimmedMessage = message.trim();
  const priceMatch = trimmedMessage.match(/(?:¥|￥|价格\s*)?(\d{2,5})/);
  const estimatedPrice = priceMatch ? Number(priceMatch[1]) : undefined;
  const color = inferFirst(trimmedMessage, ["米色", "白色", "黑色", "灰色", "蓝色", "卡其色", "棕色"], "unknown");
  const category = inferFirst(
    trimmedMessage,
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
    "待确认品类",
  );
  const fit = trimmedMessage.includes("紧身")
    ? "slim"
    : trimmedMessage.includes("宽松")
      ? "oversized"
      : "unknown";
  const possibleScenarios = [
    ...(trimmedMessage.includes("通勤") || trimmedMessage.includes("上班") ? ["通勤"] : []),
    ...(trimmedMessage.includes("面试") ? ["面试"] : []),
    ...(trimmedMessage.includes("约会") ? ["约会"] : []),
    "日常",
  ];
  const categoryGroup = toPublicCategoryGroup(classifyCategory(category));
  const wearRole = inferWearRole(
    {
      productName: "待确认商品",
      category,
      color,
      fit,
      styleTags: [],
      possibleScenarios,
      sellingPoints: [],
      summary: "",
    },
    classifyCategory(category),
  );
  const retrievalSlots = ruleSlotsForCandidate(
    {
      productName: "待确认商品",
      category,
      color,
      fit,
      styleTags: [],
      possibleScenarios,
      sellingPoints: [],
      summary: "",
      wearRole,
    },
    classifyCategory(category),
    wearRole,
  ).map((slot) => slot.slot);
  const productName =
    color !== "unknown" && category !== "待确认品类" ? `${color}${category}` : "待确认商品";
  const candidate = {
    productName,
    category,
    categoryGroup,
    color,
    fit,
    styleTags: trimmedMessage ? ["简约", possibleScenarios.includes("通勤") ? "通勤" : "休闲"] : ["待确认"],
    possibleScenarios: Array.from(new Set(possibleScenarios)),
    estimatedPrice,
    sellingPoints: trimmedMessage ? ["基础款", "易搭配", "可覆盖多个场景"] : ["截图识别失败，等待补充信息"],
    wearRole,
    retrievalSlots,
    retrievalSlotReason: "根据文字描述和保守品类规则生成召回槽位，图片识别结果不足时用于兜底判断。",
    ambiguityFlags: category === "待确认品类" ? ["category_uncertain"] : [],
    summary:
      color !== "unknown" && category !== "待确认品类"
        ? `候选商品是${color}${category}，版型${fit === "unknown" ? "待确认" : fit === "oversized" ? "偏宽松" : fit === "slim" ? "偏修身" : "常规"}。`
        : "商品截图识别暂时失败，当前缺少足够信息，建议补充品类、颜色或场景后再判断。",
    aiConfidence: color !== "unknown" || category !== "待确认品类" ? 0.45 : 0.25,
  } satisfies PurchaseCandidateAIProfile;

  return {
    ...candidate,
    embeddingText: buildPurchaseEmbeddingText(candidate),
  };
}

function scoreClosetItem(
  item: ClothingItem,
  candidate: PurchaseCandidateAIProfile,
  slot: RetrievalSlotDefinition,
  retrievalPlan: RetrievalPlan,
  candidateEmbedding?: number[],
): ClosetMatch | null {
  const itemGroup = classifyCategory(item.category);
  const candidateGroup = retrievalPlan.candidateGroup;
  const slotCompatibility = slotMatchesItem(slot, item);

  if (!slotCompatibility.compatible) {
    return null;
  }

  const styleOverlap = overlapCount(item.styleTags, candidate.styleTags);
  const scenarioOverlap = overlapCount(item.scenarioTags, candidate.possibleScenarios);
  const seasonOverlap = overlapCount(item.seasonTags ?? [], ["all-season", "spring", "summer", "autumn", "winter"]);
  const semantic = item.embedding?.length && candidateEmbedding?.length
    ? Math.max(0, cosineSimilarity(item.embedding, candidateEmbedding))
    : 0;
  const semanticPoints = Math.round(semantic * 18);
  const sameGroup = itemGroup !== "unknown" && itemGroup === candidateGroup;
  const sameColor = normalizeColor(item.color) === normalizeColor(candidate.color);
  const colorPoints = colorHarmonyScore(item.color, candidate.color);
  const frequencyScore =
    item.wearFrequency === "often" ? 10 : item.wearFrequency === "sometimes" ? 6 : item.wearFrequency === "rarely" ? 1 : 3;
  const userCorrectedScore = item.userCorrected === false ? -4 : 3;
  const complementScore = categoryComplementScore(candidateGroup, itemGroup);
  const requiredSlotScore = slot.optional ? 0 : 8;
  const roleScore = slot.priority;
  const uncertaintyPenalty = retrievalPlan.wearRole === "unknown" || candidate.category === "待确认品类" ? 8 : 0;
  const role = getSlotRoleForItem(slot, item);

  const outfitScore =
    26 +
    complementScore +
    roleScore +
    requiredSlotScore +
    colorPoints +
    styleOverlap * 8 +
    scenarioOverlap * 7 +
    Math.min(seasonOverlap * 3, 6) +
    frequencyScore +
    userCorrectedScore +
    semanticPoints -
    (sameGroup && sameColor ? 8 : 0) -
    uncertaintyPenalty;

  return {
    item,
    matchType: "outfit",
    score: clampScore(outfitScore),
    reason: buildMatchReason("outfit", item, candidate, semantic, role),
    slot: slot.slot,
    role,
  };
}

function createFallbackReport(
  request: PurchaseAssessmentRequest,
  candidate: PurchaseCandidateAIProfile,
  matches: ClosetMatch[],
  knowledgeSnippets: PurchaseWorkflowState["knowledgeSnippets"],
): PurchaseDecisionReport {
  const outfitMatches = matches.filter((match) => match.matchType === "outfit").slice(0, 6);
  const outfitPotential = Math.min(96, 48 + outfitMatches.length * 7);
  const styleConsistency = Math.min(96, 68 + outfitMatches.slice(0, 4).length * 5);
  const priceValue = candidate.estimatedPrice && candidate.estimatedPrice > 700 ? 65 : 82;
  const isSlimRisk = candidate.fit === "slim" && (request.userProfile?.bmi ?? 0) >= 24;
  const fitComfort = isSlimRisk ? 68 : candidate.fit === "unknown" ? 72 : 82;
  const strongOutfitEvidence = outfitMatches.filter((match) => match.score >= 70).length;
  const decision = strongOutfitEvidence >= 3 ? "buy" : strongOutfitEvidence >= 1 ? "save" : "skip";

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
      nextStep: "先补充或确认更多衣橱信息，再判断它能否形成稳定搭配。",
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
      duplicateRisk: 0,
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
      strongOutfitEvidence < 3
        ? "当前可确认的强搭配证据还不够多，建议先收藏并补充衣橱信息后再判断。"
        : "如果只是被折扣或截图氛围吸引，建议先收藏 24 小时。",
      "需要确认面料、尺码、维护成本和退换规则是否符合日常穿着习惯。",
    ],
    risks: [
      outfitMatches.length < 2
        ? "可形成的真实搭配证据不足，当前不应为了凑 Top K 强行推荐。"
        : "Top K 只是候选搭配，还需要确认颜色、版型和使用场景是否真的能一起成立。",
      candidate.estimatedPrice && candidate.estimatedPrice > 700
        ? "价格偏高，需要更明确的穿着频率支撑。"
        : "价格风险不高，重点看使用频率和搭配数量。",
    ],
    bodyFitNotes: [
      isSlimRisk
        ? "这件偏修身版型可能影响活动舒适度，建议优先确认弹性、肩胸围和退换货规则。"
        : "当前只基于基础档案提示版型和舒适度风险，不做身材或审美判断。",
    ],
    outfitCombinations: createOutfitCombinations(candidate, matches),
    retrievedClosetItems: matches,
    knowledgeSnippets,
    usedModel: false,
  };
}

function createOutfitCombinations(
  candidate: PurchaseCandidateAIProfile,
  matches: ClosetMatch[],
) {
  const outfitMatches = uniqueByItem(matches.filter((match) => match.matchType === "outfit")).slice(0, 4);

  if (!outfitMatches.length) {
    return [
      {
        title: "衣橱信息不足",
        scenario: candidate.possibleScenarios[0] ?? "日常",
        items: [candidate.productName],
        closetItemIds: [],
        summary: "当前可确认的衣橱单品不足，建议先补充常穿上衣、外套、下装或套装，再做更稳定的购买判断。",
        visualIntent: "outfit" as const,
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
        items: [candidate.productName, ...outfitMatches.map((match) => match.item.name)],
        closetItemIds: outfitMatches.map((match) => match.item.id),
        summary: "这些是 RAG 召回的可搭配候选，最终报告需要继续判断它们是否真的能和待买衣服形成自然搭配。",
        visualIntent: "outfit" as const,
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

  return combinations.slice(0, 3).map((combination) => {
    const visualIntent = "outfit" as const;
    const allowedFallbackMatches = outfitMatches;
    const fallbackMatches = allowedFallbackMatches.slice(0, 4);
    const namedMatches = (combination.items ?? [])
      .filter((itemName) => itemName !== candidate.productName)
      .map((itemName) => matchByName.get(itemName))
      .filter((match): match is ClosetMatch =>
        match ? match.matchType === "outfit" : false,
      )
      .slice(0, 4);
    const idMatches = (combination.closetItemIds ?? [])
      .map((itemId) => matchById.get(itemId))
      .filter((match): match is ClosetMatch =>
        match ? match.matchType === "outfit" : false,
      )
      .slice(0, 4);
    const explicitMatches = uniqueByItem([...idMatches, ...namedMatches]);
    const selectedMatches = uniqueByItem([
      ...explicitMatches,
      ...(explicitMatches.length ? [] : fallbackMatches),
    ]).slice(0, 4);

    return {
      ...combination,
      title: combination.title,
      visualIntent,
      summary: combination.summary || buildOutfitSummary(candidate, selectedMatches),
      items: [candidate.productName, ...selectedMatches.map((match) => match.item.name)],
      closetItemIds: selectedMatches.map((match) => match.item.id),
      visualType: "evidence_board",
      visualItems: selectedMatches.map((match) => ({
        id: match.item.id,
        name: match.item.name,
        category: match.item.category,
        imageUrl: match.item.displayImageUrl ?? match.item.imageUrl ?? match.item.originalImageUrl,
        matchType: match.matchType,
        role: getEvidenceRole(match, candidate),
        badge: getEvidenceRole(match, candidate),
        reason: match.reason,
        tags: [...match.item.styleTags, ...match.item.scenarioTags].slice(0, 4),
      })),
    };
  });
}

function getEvidenceRole(match: ClosetMatch, candidate: PurchaseCandidateAIProfile) {
  return match.role ?? outfitCompatibility(candidate, match.item).role;
}

function buildOutfitSummary(candidate: PurchaseCandidateAIProfile, matches: ClosetMatch[]) {
  if (!matches.length) {
    return "当前没有足够明确的衣橱单品可以组成自然搭配，建议补充更多衣橱信息后再判断。";
  }

  const itemNames = matches.slice(0, 3).map((match) => match.item.name).join("、");
  const scenario = candidate.possibleScenarios[0] ?? "日常";

  return `这组搭配以「${candidate.productName}」为核心，结合「${itemNames}」形成${scenario}场景下的可穿组合，仍建议以真实试穿和版型协调为准。`;
}

function buildDecisionPrompt(state: GraphState, fallbackReport: PurchaseDecisionReport) {
  return JSON.stringify({
    task: "基于长期主义输出衣服购买决策报告。请保持字段结构一致，直接输出 JSON。",
    outputSchema:
      "返回 JSON，字段包含 decision, decisionStatus, decisionLabel, confidence, summary, scores, reasonsToBuy, reasonsToSave, risks, bodyFitNotes, outfitCombinations, nextStep。",
    knowledgeUsage:
      "knowledge 是已检索的穿搭知识卡。请优先使用其中的 content、decisionPoints、riskSignals 和 outfitSuggestions 作为判断证据，并在 summary/reasons/risks/outfitCombinations 中体现具体知识，不要泛泛说百搭或好看。",
    outfitBoardRules:
      "本版本只评估可搭配组合。closetEvidence 是 RAG 返回的 Top K 可搭配候选，不代表一定真的能搭。你必须二次筛选：只有在品类互补、颜色协调、风格/场景自然、能形成真实穿着组合时，才允许进入 outfitCombinations；不要为了凑数量把不自然的衣服放进去。不是每套搭配都需要内搭：如果待买商品是 T恤、卫衣、针织衫、普通上衣等可单穿上衣，优先只搭配裤装/裙装，必要时再加外套，不要强行加入背心或另一件上衣。同一件衣服可以在多套搭配里复用，例如一件背心作为外套/衬衫的稳定内搭，分别连接两条不同裤装形成不同方案。如果强搭配证据不足，请明确说明证据不足并建议先收藏或暂不考虑。",
    excludedScope:
      "当前版本不要讨论重复购买、相似替代、已有同类、冗余购买或替代灵感。即使你观察到这类风险，也不要写入 summary、reasonsToBuy、reasonsToSave、risks、nextStep 或 outfitCombinations。只判断待买商品能否和真实衣橱组成自然搭配。",
    ideaMode:
      state.request.ideaMode === "more_inspiration"
        ? "更多灵感模式：请基于重新检索到的衣橱证据，优先生成 previousOutfitCombinations 之外的新搭配。只有确实能形成自然新组合时才返回 outfitCombinations；如果新组合只是重复、牵强或证据不足，可以返回空数组，并在 summary/nextStep 说明没有新的可靠灵感。"
        : "标准购买决策模式",
    previousOutfitCombinations: (state.request.previousOutfitCombinations ?? []).map(
      compactOutfitCombination,
    ),
    userMessage: state.request.message,
    userProfile: state.request.userProfile,
    candidate: compactCandidate(state.candidate ?? fallbackReport.candidate),
    retrievalPlan: compactRetrievalPlan(buildRetrievalPlan(state.candidate ?? fallbackReport.candidate)),
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
    categoryGroup: candidate.categoryGroup,
    itemCategoryId: candidate.itemCategoryId,
    color: candidate.color,
    fit: candidate.fit,
    styleTags: candidate.styleTags,
    possibleScenarios: candidate.possibleScenarios,
    estimatedPrice: candidate.estimatedPrice,
    sellingPoints: candidate.sellingPoints.slice(0, 4),
    wearRole: candidate.wearRole,
    retrievalSlots: candidate.retrievalSlots,
    retrievalSlotReason: candidate.retrievalSlotReason,
    avoidSlots: candidate.avoidSlots,
    ambiguityFlags: candidate.ambiguityFlags,
    summary: candidate.summary,
  };
}

function compactClosetMatch(match: ClosetMatch) {
  return {
    matchType: match.matchType,
    score: match.score,
    slot: match.slot,
    role: match.role,
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

function compactRetrievalPlan(plan: RetrievalPlan) {
  return {
    candidateGroup: plan.candidateGroup,
    wearRole: plan.wearRole,
    source: plan.source,
    reason: plan.reason,
    slots: plan.slots.map((slot) => ({
      slot: slot.slot,
      role: slot.role,
      maxItems: slot.maxItems,
      optional: Boolean(slot.optional),
    })),
    rejectedModelSlots: plan.rejectedModelSlots,
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
      visualIntent: combination.visualIntent,
      items: combination.items.slice(0, 5),
      summary: combination.summary,
    })),
  };
}

function compactOutfitCombination(combination: OutfitCombination) {
  return {
    title: combination.title,
    scenario: combination.scenario,
    visualIntent: combination.visualIntent,
    items: combination.items.slice(0, 5),
    summary: combination.summary,
    visualItems: combination.visualItems?.slice(0, 4).map((item) => ({
      name: item.name,
      category: item.category,
      matchType: item.matchType,
      role: item.role,
      reason: item.reason,
      tags: item.tags.slice(0, 4),
    })),
  };
}

function summarizeMatchesByType(matches: ClosetMatch[]) {
  return ["outfit"].map((matchType) => {
    const items = matches.filter((match) => match.matchType === matchType);

    return {
      matchType,
      count: items.length,
      topItems: items.slice(0, 5).map((match) => ({
        name: match.item.name,
        category: match.item.category,
        color: match.item.color,
        score: match.score,
        reason: match.reason,
      })),
    };
  });
}

function buildRetrievalPlan(candidate: PurchaseCandidateAIProfile): RetrievalPlan {
  const candidateGroup = normalizeCandidateGroup(candidate);
  const wearRole = candidate.wearRole ?? inferWearRole(candidate, candidateGroup);
  const ruleSlots = ruleSlotsForCandidate(candidate, candidateGroup, wearRole);
  const allowedSlotNames = new Set(ruleSlots.map((slot) => slot.slot));
  const avoidSlots = new Set(candidate.avoidSlots ?? []);
  const modelSlots = uniqueSlots(candidate.retrievalSlots ?? []);
  const acceptedModelSlotNames = modelSlots.filter(
    (slot) => allowedSlotNames.has(slot) && !avoidSlots.has(slot),
  );
  const rejectedModelSlots = modelSlots.filter(
    (slot) => !allowedSlotNames.has(slot) || avoidSlots.has(slot),
  );
  const selectedSlotNames = acceptedModelSlotNames.length
    ? acceptedModelSlotNames
    : ruleSlots.filter((slot) => !avoidSlots.has(slot.slot)).map((slot) => slot.slot);
  const selectedSlots = selectedSlotNames
    .map((slotName) => ruleSlots.find((slot) => slot.slot === slotName))
    .filter((slot): slot is RetrievalSlotDefinition => Boolean(slot));
  const seededByRuleFallback = candidate.retrievalSlotReason?.includes("保守品类规则");
  const source = seededByRuleFallback
    ? "rule"
    : acceptedModelSlotNames.length && rejectedModelSlots.length
      ? "mixed"
      : acceptedModelSlotNames.length
        ? "model"
        : "rule";

  return {
    candidateGroup,
    wearRole,
    slots: selectedSlots.length ? selectedSlots : ruleSlots,
    rejectedModelSlots,
    source,
    reason: candidate.retrievalSlotReason ?? describeRetrievalPlan(candidate, wearRole, selectedSlots),
  };
}

function ruleSlotsForCandidate(
  candidate: PurchaseCandidateAIProfile,
  candidateGroup: InternalCategoryGroup,
  wearRole: CandidateWearRole,
) {
  if (wearRole === "standalone_top") {
    return [
      slotDefinition("bottom", 4, 24),
      slotDefinition("outerwear", 2, 12, true),
    ];
  }

  if (wearRole === "layerable_top") {
    return [
      slotDefinition("inner_top", 3, 22),
      slotDefinition("bottom", 4, 22),
      slotDefinition("outerwear", 2, 8, true),
    ];
  }

  if (wearRole === "inner_layer") {
    return [
      slotDefinition("outerwear", 4, 24),
      slotDefinition("bottom", 3, 18),
    ];
  }

  if (wearRole === "outer_layer" || wearRole === "functional_outer") {
    return [
      slotDefinition("inner_top", 4, 24),
      slotDefinition("bottom", 4, 22),
      slotDefinition("onepiece", 2, 14, true),
    ];
  }

  if (wearRole === "bottom") {
    return [
      slotDefinition("top", 4, 24),
      slotDefinition("outerwear", 2, 12, true),
    ];
  }

  if (wearRole === "onepiece") {
    const canLayerInside = /吊带裙|吊带连衣裙|背心裙|无袖/.test(candidate.category);
    return [
      slotDefinition("outerwear", 4, 24),
      ...(canLayerInside ? [slotDefinition("inner_top", 2, 14, true)] : []),
    ];
  }

  if (wearRole === "set") {
    return [slotDefinition("outerwear", 2, 10, true)];
  }

  if (candidateGroup === "top") return ruleSlotsForCandidate(candidate, candidateGroup, "standalone_top");
  if (candidateGroup === "outer") return ruleSlotsForCandidate(candidate, candidateGroup, "outer_layer");
  if (candidateGroup === "bottom") return ruleSlotsForCandidate(candidate, candidateGroup, "bottom");
  if (candidateGroup === "onepiece") return ruleSlotsForCandidate(candidate, candidateGroup, "onepiece");
  return [];
}

function slotDefinition(
  slot: RetrievalSlot,
  maxItems: number,
  priority: number,
  optional = false,
): RetrievalSlotDefinition {
  const itemGroups: Record<RetrievalSlot, InternalCategoryGroup[]> = {
    top: ["top"],
    inner_top: ["top"],
    outerwear: ["outer"],
    bottom: ["bottom"],
    onepiece: ["onepiece"],
  };

  return {
    slot,
    role: SLOT_LABELS[slot],
    itemGroups: itemGroups[slot],
    maxItems,
    priority,
    optional,
  };
}

function slotMatchesItem(slot: RetrievalSlotDefinition, item: ClothingItem) {
  const itemGroup = classifyCategory(item.category);
  if (!slot.itemGroups.includes(itemGroup)) {
    return { compatible: false };
  }

  if (slot.slot === "inner_top") {
    const isTooOuterLike = /外套|大衣|风衣|夹克|冲锋衣|防晒衣|雨衣|雨壳|软壳|硬壳|抓绒|羽绒|棉服/.test(item.category);
    return { compatible: !isTooOuterLike };
  }

  return { compatible: true };
}

function getSlotRoleForItem(slot: RetrievalSlotDefinition, item: ClothingItem) {
  if (slot.slot === "bottom") {
    if (isSkirtCategory(item.category)) return "可搭裙装";
    if (isPantsCategory(item.category)) return "可搭裤装";
  }

  return slot.role;
}

function isSkirtCategory(category: string) {
  return /半身裙|短裙|长裙|A字裙|铅笔裙|百褶裙|伞裙|包臀裙|裙装/.test(category);
}

function isPantsCategory(category: string) {
  return /裤|长裤|短裤|牛仔裤|直筒|阔腿|西装裤|休闲裤|工装裤|户外裤|运动裤|卫裤|瑜伽裤|鲨鱼裤|打底裤|皮裤|裙裤/.test(category);
}

function normalizeCandidateGroup(candidate: PurchaseCandidateAIProfile): InternalCategoryGroup {
  if (candidate.categoryGroup === "outerwear") return "outer";
  if (candidate.categoryGroup === "top" || candidate.categoryGroup === "bottom" || candidate.categoryGroup === "onepiece") {
    return candidate.categoryGroup;
  }
  return classifyCategory(candidate.category);
}

function toPublicCategoryGroup(group: InternalCategoryGroup) {
  if (group === "outer") return "outerwear";
  return group;
}

function inferWearRole(
  candidate: PurchaseCandidateAIProfile,
  candidateGroup: InternalCategoryGroup,
): CandidateWearRole {
  const category = candidate.category;
  if (candidateGroup === "outer") {
    return /冲锋衣|防晒衣|雨衣|雨壳|软壳|硬壳|抓绒|风壳/.test(category)
      ? "functional_outer"
      : "outer_layer";
  }
  if (candidateGroup === "bottom") return "bottom";
  if (candidateGroup === "onepiece") return /套装/.test(category) ? "set" : "onepiece";
  if (/打底|吊带|运动内衣/.test(category)) return "inner_layer";
  if (/衬衫|开衫|防晒衫|马甲/.test(category)) return "layerable_top";
  if (candidateGroup === "top") return "standalone_top";
  return "unknown";
}

function uniqueSlots(slots: RetrievalSlot[]) {
  return Array.from(new Set(slots));
}

function describeRetrievalPlan(
  candidate: PurchaseCandidateAIProfile,
  wearRole: CandidateWearRole,
  slots: RetrievalSlotDefinition[],
) {
  const slotLabels = slots.map((slot) => slot.role.replace(/^可搭/, "")).join("、") || "暂无明确槽位";
  return `待买商品「${candidate.productName}」被判断为 ${wearRole}，优先召回${slotLabels}来验证真实衣橱搭配。`;
}

function buildMatchReason(
  type: ClosetMatch["matchType"],
  item: ClothingItem,
  candidate: PurchaseCandidateAIProfile,
  semantic: number,
  role?: string,
) {
  const semanticText = semantic >= 0.72 ? "，向量摘要也较接近" : "";
  if (type === "outfit") {
    const roleText = role ? `作为${role.replace(/^可搭/, "")}` : "作为搭配单品";
    return `${roleText}可用于${candidate.possibleScenarios[0] ?? "日常"}搭配，和待买衣服在风格或场景上能互相承接${semanticText}。`;
  }
  return `可作为候选搭配证据，但需要最终模型继续判断是否真的自然成套${semanticText}。`;
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

function outfitCompatibility(candidate: PurchaseCandidateAIProfile, item: ClothingItem) {
  const retrievalPlan = buildRetrievalPlan(candidate);
  const matchedSlot = retrievalPlan.slots.find((slot) => slotMatchesItem(slot, item).compatible);

  if (!matchedSlot) {
    return { compatible: false, role: "可搭单品" };
  }

  return {
    compatible: true,
    role: matchedSlot.role,
    slot: matchedSlot.slot,
  };
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
