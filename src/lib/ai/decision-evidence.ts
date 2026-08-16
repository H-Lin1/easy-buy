import type { ClosetMatch, OutfitCombination, RetrievalSlot } from "./types.ts";

export const DECISION_SLOT_ORDER: readonly RetrievalSlot[] = [
  "inner_top",
  "top",
  "bottom",
  "outerwear",
  "onepiece",
];

export const DECISION_OUTFIT_SELECTION_RULES =
  "本版本只评估可搭配组合。closetEvidenceBySlot 是每个槽位各自的完整 Top K 候选，不代表一定真的能搭。你必须结合商品和衣橱图片进行二次筛选，以整体搭配的美观、协调和可穿性为首要目标；最多返回 3 套并按可靠程度排序，不强制凑满，不够自然或效果不佳的方案必须舍弃。每套最多使用 4 件衣橱单品；不同方案至少有一个核心衣橱单品不同。closetItemIds 只能引用 candidateWhitelist 中的真实 ID，禁止虚构 ID。不是每套都需要内搭；可单穿上衣优先搭配下装，必要时再加外套，不要强行加入另一件主要上衣。强搭配证据不足时可以返回更少方案或空数组。";

export type DecisionImageEvidence = {
  label: string;
  url: string;
};

export type DecisionMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

export function groupDecisionClosetMatches(matches: ClosetMatch[]) {
  const grouped: Record<RetrievalSlot, ClosetMatch[]> = {
    inner_top: [],
    top: [],
    bottom: [],
    outerwear: [],
    onepiece: [],
  };

  for (const match of matches) {
    if (match.slot) grouped[match.slot].push(match);
  }

  return grouped;
}

export function buildDecisionImageEvidence(
  candidateImageUrl: string | undefined,
  matches: ClosetMatch[],
) {
  const evidence: DecisionImageEvidence[] = [];

  if (!candidateImageUrl) return evidence;

  evidence.push({
    label: "待买商品原图：用于核对候选商品的颜色、材质观感、纹理、廓形和结构",
    url: candidateImageUrl,
  });

  const grouped = groupDecisionClosetMatches(matches);
  for (const slot of DECISION_SLOT_ORDER) {
    for (const match of grouped[slot]) {
      if (!match.item.originalImageUrl) continue;
      evidence.push({
        label: `衣橱候选：slot=${slot}；closetItemId=${match.item.id}；名称=${match.item.name}；品类=${match.item.category}；颜色=${match.item.color}`,
        url: match.item.originalImageUrl,
      });
    }
  }

  return evidence;
}

export function buildDecisionMessageContent(
  prompt: string,
  evidence: DecisionImageEvidence[],
): DecisionMessagePart[] {
  const content: DecisionMessagePart[] = [{ type: "text", text: prompt }];

  evidence.forEach((entry, index) => {
    content.push({
      type: "text",
      text: `Image ${index + 1}：${entry.label}`,
    });
    content.push({
      type: "image_url",
      image_url: {
        url: entry.url,
        detail: "high",
      },
    });
  });

  return content;
}

export function serializeIndependentDecisionPrompt(payload: Record<string, unknown>) {
  const independentPayload = { ...payload };
  delete independentPayload.draftReport;
  delete independentPayload.fallbackDraft;
  return JSON.stringify(independentPayload);
}

export function validateDecisionOutfitCombinations(
  value: unknown,
  matches: ClosetMatch[],
): OutfitCombination[] {
  if (!Array.isArray(value)) return [];

  const allowedIds = new Set(matches.map((match) => match.item.id));
  const slotById = new Map(matches.map((match) => [match.item.id, match.slot]));
  const seenCoreCombinations = new Set<string>();
  const validated: OutfitCombination[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) continue;

    const closetItemIds = uniqueStrings(entry.closetItemIds)
      .filter((id) => allowedIds.has(id))
      .slice(0, 4);
    if (!closetItemIds.length) continue;

    const coreItemIds = closetItemIds.filter((id) => slotById.get(id) !== "outerwear");
    const coreCombinationKey = [...(coreItemIds.length ? coreItemIds : closetItemIds)]
      .sort()
      .join("|");
    if (seenCoreCombinations.has(coreCombinationKey)) continue;
    seenCoreCombinations.add(coreCombinationKey);

    validated.push({
      title: normalizeDecisionText(entry.title) || `可靠搭配 ${validated.length + 1}`,
      scenario: normalizeDecisionText(entry.scenario) || "日常",
      items: normalizeDecisionTextArray(entry.items) ?? [],
      closetItemIds,
      summary:
        normalizeDecisionText(entry.summary) ||
        "该方案只保留本次衣橱候选白名单中可确认的真实单品。",
      visualIntent: "outfit",
    });

    if (validated.length === 3) break;
  }

  return validated;
}

export function normalizeDecisionTextArray(value: unknown): string[] | undefined {
  const source = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const normalized = source.map(normalizeDecisionText).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

export function normalizeDecisionText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isRecord(value)) return "";

  const primaryKeys = ["reason", "risk", "note", "text", "summary", "action"];
  const detailKeys = ["evidence", "impact", "details"];
  const parts = [...primaryKeys, ...detailKeys]
    .flatMap((key) => {
      const field = value[key];
      if (Array.isArray(field)) return field.map(normalizeDecisionText);
      return [normalizeDecisionText(field)];
    })
    .filter(Boolean);

  return [...new Set(parts)].join("；");
}

function uniqueStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
