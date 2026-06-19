import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { FashionKnowledgeSnippet, PurchaseCandidateAIProfile } from "@/lib/ai/types";
import { toPgVector } from "@/lib/ai/providers";
import { appEnv } from "@/lib/env";

import knowledgeDeck from "../../../knowledge/fashion-knowledge.cards.v1.json";

type KnowledgeCard = {
  card_id: string;
  topic: string;
  knowledge_type: string;
  tags?: string[];
  content: string;
  taxonomy_version: string;
  category_tags?: string[];
  color_tags?: string[];
  style_tags?: string[];
  scenario_tags?: string[];
  fit_tags?: string[];
  fabric_tags?: string[];
  risk_tags?: string[];
  value_tags?: string[];
  applicable_items?: string[];
  decision_points?: string[];
  outfit_suggestions?: string[];
  risk_signals?: string[];
  decision_bias?: Record<string, string>;
  source_refs?: string[];
  priority?: number;
};

type RetrievalOptions = {
  topK?: number;
  tags?: string[];
  candidate?: PurchaseCandidateAIProfile;
  embedding?: number[];
};

type FashionKnowledgeRow = {
  card_id: string | null;
  topic: string;
  knowledge_type: string | null;
  tags: string[] | null;
  content: string;
  category_tags: string[] | null;
  color_tags: string[] | null;
  style_tags: string[] | null;
  scenario_tags: string[] | null;
  fit_tags: string[] | null;
  fabric_tags: string[] | null;
  risk_tags: string[] | null;
  value_tags: string[] | null;
  applicable_items: string[] | null;
  decision_points: string[] | null;
  outfit_suggestions: string[] | null;
  risk_signals: string[] | null;
  decision_bias: Record<string, string> | null;
  source_refs: string[] | null;
  priority: number | null;
  similarity?: number | null;
};

export const builtinFashionKnowledge: FashionKnowledgeSnippet[] = [
  {
    topic: "长期主义消费",
    tags: ["long-term", "cost-per-wear"],
    content: "购买前优先判断未来 30 天是否存在真实穿着场景，以及是否能和已有衣橱搭出至少 2 套。",
  },
  {
    topic: "重复购买",
    tags: ["duplicate", "wardrobe"],
    content: "同品类、同颜色、同场景的单品已有 2 件以上时，应重点比较版型、材质和使用场景差异。",
  },
  {
    topic: "版型平衡",
    tags: ["fit", "silhouette"],
    content: "贴身上装可搭配更利落或有空间感的下装；宽松上装需要注意下装线条，避免整体比例过于松散。",
  },
  {
    topic: "通勤场景",
    tags: ["commute", "work"],
    content: "通勤单品优先考虑舒适、耐穿、易打理和正式度适中，而不只是上镜效果。",
  },
  {
    topic: "价格判断",
    tags: ["price", "value"],
    content: "价格是否合理应结合穿着频率、搭配数量和替代单品判断，而不是只看折扣幅度。",
  },
  {
    topic: "灵感边界",
    tags: ["inspiration", "honesty"],
    content: "提供搭配灵感时必须区分用户已有衣橱单品和未来可补充方向，不能暗示用户已拥有不存在的单品。",
  },
];

let cachedDatabaseKnowledge: Promise<FashionKnowledgeSnippet[]> | null = null;

export async function retrieveFashionKnowledge(query: string, options: RetrievalOptions = {}) {
  const topK = options.topK ?? 6;
  const queryTerms = extractTerms(query);
  const candidateTerms = extractCandidateTerms(options.candidate);
  const requestedTerms = unique([...queryTerms, ...candidateTerms, ...(options.tags ?? [])]);

  const databaseKnowledge = await loadDatabaseKnowledge(options.embedding).catch((error) => {
    console.warn("[fashion-knowledge] database retrieval skipped", {
      message: error instanceof Error ? error.message : "Unknown retrieval error.",
    });
    return [];
  });

  const source = databaseKnowledge.length ? databaseKnowledge : retrieveLocalKnowledgeCards();
  const scored = source
    .map((snippet) => ({
      ...snippet,
      score: scoreKnowledgeSnippet(snippet, requestedTerms, options.candidate),
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const ranked = selectCoreDecisionKnowledge(scored, requestedTerms, topK);

  if (ranked.length) return ranked;

  return retrieveBuiltinKnowledge(query, topK);
}

export function retrieveBuiltinKnowledge(query: string, topK = 4) {
  const normalizedQuery = normalizeText(query);
  const tokens = extractTerms(normalizedQuery);

  return builtinFashionKnowledge
    .map((snippet) => {
      const haystack = normalizeText(`${snippet.topic} ${snippet.tags.join(" ")} ${snippet.content}`);
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);

      return { ...snippet, score };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topK);
}

async function loadDatabaseKnowledge(queryEmbedding?: number[]) {
  if (!appEnv.supabaseUrl || !appEnv.supabaseServiceRoleKey) return [];

  const supabase = createKnowledgeClient();
  const fullKnowledgePromise = loadAllDatabaseKnowledge(supabase);
  let vectorKnowledge: FashionKnowledgeSnippet[] = [];

  if (queryEmbedding?.length) {
    const { data, error } = await supabase.rpc("match_fashion_knowledge", {
      query_embedding: toPgVector(queryEmbedding),
      match_count: 80,
    });

    if (!error && data?.length) {
      vectorKnowledge = (data as FashionKnowledgeRow[]).map(mapDatabaseRowToSnippet);
    }

    if (error) {
      console.warn("[fashion-knowledge] vector retrieval skipped", {
        message: error.message,
      });
    }
  }

  const fullKnowledge = await fullKnowledgePromise;
  if (vectorKnowledge.length) {
    return mergeKnowledgeSnippets([...vectorKnowledge, ...fullKnowledge]);
  }

  return fullKnowledge;
}

async function loadAllDatabaseKnowledge(supabase: ReturnType<typeof createKnowledgeClient>) {
  cachedDatabaseKnowledge ??= (async () => {
    const { data, error } = await supabase
      .from("fashion_knowledge")
      .select(
        "card_id,topic,knowledge_type,tags,content,category_tags,color_tags,style_tags,scenario_tags,fit_tags,fabric_tags,risk_tags,value_tags,applicable_items,decision_points,outfit_suggestions,risk_signals,decision_bias,source_refs,priority",
      )
      .eq("status", "active")
      .eq("taxonomy_version", "v1")
      .order("priority", { ascending: true })
      .limit(300);

    if (error) throw error;

    return ((data ?? []) as FashionKnowledgeRow[]).map(mapDatabaseRowToSnippet);
  })();

  return cachedDatabaseKnowledge;
}

function createKnowledgeClient() {
  return createClient(appEnv.supabaseUrl!, appEnv.supabaseServiceRoleKey!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function retrieveLocalKnowledgeCards() {
  const cards = (knowledgeDeck as { cards: KnowledgeCard[] }).cards ?? [];
  return cards.map(mapCardToSnippet);
}

function mapDatabaseRowToSnippet(row: FashionKnowledgeRow): FashionKnowledgeSnippet {
  return {
    cardId: row.card_id ?? undefined,
    topic: row.topic,
    knowledgeType: row.knowledge_type ?? undefined,
    tags: unique([
      ...(row.tags ?? []),
      ...(row.category_tags ?? []),
      ...(row.color_tags ?? []),
      ...(row.style_tags ?? []),
      ...(row.scenario_tags ?? []),
      ...(row.fit_tags ?? []),
      ...(row.fabric_tags ?? []),
      ...(row.risk_tags ?? []),
      ...(row.value_tags ?? []),
      ...(row.applicable_items ?? []),
    ]),
    content: row.content,
    decisionPoints: row.decision_points ?? [],
    outfitSuggestions: row.outfit_suggestions ?? [],
    riskSignals: row.risk_signals ?? [],
    decisionBias: row.decision_bias ?? undefined,
    sourceRefs: row.source_refs ?? [],
    score: typeof row.similarity === "number" ? Math.round(row.similarity * 50) : undefined,
  };
}

function mapCardToSnippet(card: KnowledgeCard): FashionKnowledgeSnippet {
  return {
    cardId: card.card_id,
    topic: card.topic,
    knowledgeType: card.knowledge_type,
    tags: unique([
      ...(card.tags ?? []),
      ...(card.category_tags ?? []),
      ...(card.color_tags ?? []),
      ...(card.style_tags ?? []),
      ...(card.scenario_tags ?? []),
      ...(card.fit_tags ?? []),
      ...(card.fabric_tags ?? []),
      ...(card.risk_tags ?? []),
      ...(card.value_tags ?? []),
      ...(card.applicable_items ?? []),
    ]),
    content: card.content,
    decisionPoints: card.decision_points ?? [],
    outfitSuggestions: card.outfit_suggestions ?? [],
    riskSignals: card.risk_signals ?? [],
    decisionBias: card.decision_bias,
    sourceRefs: card.source_refs ?? [],
  };
}

function scoreKnowledgeSnippet(
  snippet: FashionKnowledgeSnippet,
  requestedTerms: string[],
  candidate?: PurchaseCandidateAIProfile,
) {
  const normalizedTags = snippet.tags.map(normalizeText);
  const haystack = normalizeText(
    [
      snippet.topic,
      snippet.content,
      ...(snippet.decisionPoints ?? []),
      ...(snippet.outfitSuggestions ?? []),
      ...(snippet.riskSignals ?? []),
      ...snippet.tags,
    ].join(" "),
  );
  const wantsLongTerm = requestedTerms.some((term) =>
    /长期|冲动|复用|利用率|真实场景|适合我/.test(term),
  );
  const wantsDuplicateCheck = requestedTerms.some((term) => /重复|相似|替代|已有/.test(term));
  let score = snippet.score ?? 0;

  if (snippet.knowledgeType === "long_term_purchase") {
    score += wantsLongTerm ? 28 : 8;
  }
  if (snippet.knowledgeType === "wardrobe_utilization") {
    score += wantsLongTerm ? 18 : 6;
  }
  if (wantsDuplicateCheck && `${snippet.topic} ${snippet.tags.join(" ")}`.includes("重复")) {
    score += 18;
  }

  for (const term of requestedTerms.map(normalizeText).filter(Boolean)) {
    if (normalizedTags.includes(term)) score += 14;
    else if (normalizedTags.some((tag) => tag.includes(term) || term.includes(tag))) score += 8;
    if (haystack.includes(term)) score += 3;
  }

  if (candidate) {
    score += candidate.category && haystack.includes(normalizeText(candidate.category)) ? 10 : 0;
    score += candidate.color && haystack.includes(normalizeText(candidate.color)) ? 6 : 0;
    score += candidate.possibleScenarios.some((scenario) =>
      normalizedTags.includes(normalizeText(scenario)),
    )
      ? 8
      : 0;
    score += candidate.styleTags.some((style) => normalizedTags.includes(normalizeText(style))) ? 8 : 0;
  }

  return score;
}

function selectCoreDecisionKnowledge(
  scored: FashionKnowledgeSnippet[],
  requestedTerms: string[],
  topK: number,
) {
  const wantsLongTerm = requestedTerms.some((term) =>
    /长期|冲动|复用|利用率|真实场景|适合我|搭配/.test(term),
  );
  const wantsDuplicateCheck = requestedTerms.some((term) => /重复|相似|替代|已有/.test(term));
  const selected: FashionKnowledgeSnippet[] = [];

  if (wantsLongTerm) {
    pushFirstMatch(selected, scored, (snippet) => snippet.knowledgeType === "long_term_purchase");
    pushFirstMatch(selected, scored, (snippet) => snippet.knowledgeType === "wardrobe_utilization");
  }

  if (wantsDuplicateCheck) {
    pushFirstMatch(selected, scored, (snippet) =>
      `${snippet.topic} ${snippet.tags.join(" ")} ${(snippet.riskSignals ?? []).join(" ")}`.includes("重复"),
    );
  }

  const selectedKeys = new Set(selected.map(getSnippetKey));
  selected.push(...scored.filter((snippet) => !selectedKeys.has(getSnippetKey(snippet))));

  return selected.slice(0, topK);
}

function pushFirstMatch(
  selected: FashionKnowledgeSnippet[],
  scored: FashionKnowledgeSnippet[],
  predicate: (snippet: FashionKnowledgeSnippet) => boolean,
) {
  const selectedKeys = new Set(selected.map(getSnippetKey));
  const match = scored.find((snippet) => predicate(snippet) && !selectedKeys.has(getSnippetKey(snippet)));
  if (match) selected.push(match);
}

function getSnippetKey(snippet: FashionKnowledgeSnippet) {
  return snippet.cardId ?? snippet.topic;
}

function extractCandidateTerms(candidate?: PurchaseCandidateAIProfile) {
  if (!candidate) return [];

  return unique([
    candidate.productName,
    candidate.category,
    candidate.color,
    candidate.fit,
    ...(candidate.secondaryColors ?? []),
    ...candidate.styleTags,
    ...candidate.possibleScenarios,
    ...candidate.sellingPoints,
    candidate.summary,
    candidate.embeddingText ?? "",
  ]).flatMap(extractTerms);
}

function extractTerms(input: string) {
  return normalizeText(input)
    .split(/[\s,，、。；;:：/|]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== "unknown" && token !== "待确认");
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique<T>(values: T[]) {
  return [...new Set(values.filter(Boolean))];
}

function mergeKnowledgeSnippets(snippets: FashionKnowledgeSnippet[]) {
  const byKey = new Map<string, FashionKnowledgeSnippet>();

  for (const snippet of snippets) {
    const key = snippet.cardId ?? snippet.topic;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, snippet);
      continue;
    }

    byKey.set(key, {
      ...existing,
      ...snippet,
      tags: unique([...(existing.tags ?? []), ...(snippet.tags ?? [])]),
      decisionPoints: unique([...(existing.decisionPoints ?? []), ...(snippet.decisionPoints ?? [])]),
      outfitSuggestions: unique([
        ...(existing.outfitSuggestions ?? []),
        ...(snippet.outfitSuggestions ?? []),
      ]),
      riskSignals: unique([...(existing.riskSignals ?? []), ...(snippet.riskSignals ?? [])]),
      sourceRefs: unique([...(existing.sourceRefs ?? []), ...(snippet.sourceRefs ?? [])]),
      score: Math.max(existing.score ?? 0, snippet.score ?? 0),
    });
  }

  return [...byKey.values()];
}
