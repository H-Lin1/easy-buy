import taxonomyDeck from "../../../knowledge/fashion-taxonomy.v1.json";

type TaxonomyEntry = {
  id: string;
  name: string;
  group?: string;
  synonyms?: string[];
  notes?: string;
};

type CategoryGroup = TaxonomyEntry & {
  items: string[];
};

type FashionTaxonomy = {
  taxonomy_version: string;
  locale: string;
  dimensions: {
    category_groups: CategoryGroup[];
    item_categories: TaxonomyEntry[];
    colors: TaxonomyEntry[];
    fit_and_silhouette: TaxonomyEntry[];
    fabric_looks: TaxonomyEntry[];
    patterns: TaxonomyEntry[];
    styles: TaxonomyEntry[];
    scenarios: TaxonomyEntry[];
    care_risks: TaxonomyEntry[];
    value_tags: TaxonomyEntry[];
    risk_tags: TaxonomyEntry[];
  };
};

const taxonomy = taxonomyDeck as FashionTaxonomy;

export function getFashionTaxonomy() {
  return taxonomy;
}

export function buildTaxonomyPromptBlock() {
  const dimensions = taxonomy.dimensions;

  return `
可选标签体系（请优先使用这些中文标签；如果无法确定，写 unknown 或待确认，不要硬猜）：
- MVP 识别范围：只关注衣服、裤装、裙装、套装；暂不把鞋、包、配饰作为主商品。
- 品类：${formatCategoryGroups()}
- 颜色：${formatEntryNames(dimensions.colors)}
- 版型/廓形：${formatEntryNames(dimensions.fit_and_silhouette)}
- 材质/功能观感：${formatEntryNames(dimensions.fabric_looks)}
- 图案：${formatEntryNames(dimensions.patterns)}
- 风格：${formatEntryNames(dimensions.styles)}
- 场景：${formatEntryNames(dimensions.scenarios)}
- 维护/质量风险：${formatEntryNames(dimensions.care_risks)}
- 搭配价值：${formatEntryNames(dimensions.value_tags)}
- 决策风险：${formatEntryNames(dimensions.risk_tags)}
`.trim();
}

export function getTaxonomyLabelSet() {
  const dimensions = taxonomy.dimensions;
  const entries = [
    ...dimensions.item_categories,
    ...dimensions.colors,
    ...dimensions.fit_and_silhouette,
    ...dimensions.fabric_looks,
    ...dimensions.patterns,
    ...dimensions.styles,
    ...dimensions.scenarios,
    ...dimensions.care_risks,
    ...dimensions.value_tags,
    ...dimensions.risk_tags,
  ];

  return new Set(entries.flatMap((entry) => [entry.name, ...(entry.synonyms ?? [])]));
}

function formatCategoryGroups() {
  const itemById = new Map(
    taxonomy.dimensions.item_categories.map((item) => [item.id, item.name]),
  );

  return taxonomy.dimensions.category_groups
    .map((group) => {
      const itemNames = group.items
        .map((id) => itemById.get(id))
        .filter((name): name is string => Boolean(name));

      return `${group.name}（${itemNames.join("、")}）`;
    })
    .join("；");
}

function formatEntryNames(entries: TaxonomyEntry[]) {
  return entries.map((entry) => entry.name).join("、");
}
