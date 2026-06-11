import type { FashionKnowledgeSnippet } from "@/lib/ai/types";

export const builtinFashionKnowledge: FashionKnowledgeSnippet[] = [
  {
    topic: "长期主义消费",
    tags: ["long-term", "cost-per-wear"],
    content:
      "购买前优先判断未来 30 天是否存在真实穿着场景，以及是否能和已有衣橱搭出至少 2 套。",
  },
  {
    topic: "重复购买",
    tags: ["duplicate", "wardrobe"],
    content:
      "同品类、同颜色、同场景的单品已有 2 件以上时，应重点比较版型、材质和使用场景差异。",
  },
  {
    topic: "版型平衡",
    tags: ["fit", "silhouette"],
    content:
      "贴身上装可搭配更利落或有空间感的下装；宽松上装需要注意下装线条，避免整体比例过于松散。",
  },
  {
    topic: "通勤场景",
    tags: ["commute", "work"],
    content:
      "通勤单品优先考虑舒适、耐穿、易打理和正式度适中，而不仅是上镜效果。",
  },
  {
    topic: "价格判断",
    tags: ["price", "value"],
    content:
      "价格是否合理应结合穿着频率、搭配数量和替代单品判断，而不是只看折扣幅度。",
  },
  {
    topic: "灵感边界",
    tags: ["inspiration", "honesty"],
    content:
      "提供搭配灵感时必须区分用户已有衣橱单品和未来可补充方向，不能暗示用户已拥有不存在的单品。",
  },
];

export function retrieveBuiltinKnowledge(query: string, topK = 4) {
  const normalizedQuery = query.toLowerCase();

  return builtinFashionKnowledge
    .map((snippet) => {
      const haystack = `${snippet.topic} ${snippet.tags.join(" ")} ${snippet.content}`.toLowerCase();
      const score = normalizedQuery
        .split(/\s+|，|。|、|,|\./)
        .filter(Boolean)
        .reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);

      return { snippet, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ snippet }) => snippet);
}
