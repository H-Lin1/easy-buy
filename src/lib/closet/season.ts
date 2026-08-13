export const closetSeasonValues = ["春季", "夏季", "秋季", "冬季", "四季"] as const;

export type ClosetSeason = (typeof closetSeasonValues)[number];

export const closetSeasonOptions = closetSeasonValues.map((season) => ({
  value: season,
  label: season,
})) satisfies readonly { value: ClosetSeason; label: ClosetSeason }[];

const seasonAliases: Readonly<Record<string, ClosetSeason>> = {
  spring: "春季",
  springseason: "春季",
  春: "春季",
  春天: "春季",
  春季: "春季",
  summer: "夏季",
  summerseason: "夏季",
  夏: "夏季",
  夏天: "夏季",
  夏季: "夏季",
  autumn: "秋季",
  autumnseason: "秋季",
  fall: "秋季",
  fallseason: "秋季",
  秋: "秋季",
  秋天: "秋季",
  秋季: "秋季",
  winter: "冬季",
  winterseason: "冬季",
  冬: "冬季",
  冬天: "冬季",
  冬季: "冬季",
  allseason: "四季",
  allseasons: "四季",
  yearround: "四季",
  四季: "四季",
  全季: "四季",
  全年: "四季",
  全年适用: "四季",
  全年可穿: "四季",
  四季皆宜: "四季",
  四季可穿: "四季",
};

function normalizeSeasonKey(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function normalizeClosetSeason(
  value: string | null | undefined,
): ClosetSeason | undefined {
  if (!value) return undefined;
  return seasonAliases[normalizeSeasonKey(value)];
}

export function normalizeClosetSeasons(
  values: readonly (string | null | undefined)[] | null | undefined,
): ClosetSeason[] {
  const normalizedSeasons: ClosetSeason[] = [];
  const seen = new Set<ClosetSeason>();

  for (const value of values ?? []) {
    const season = normalizeClosetSeason(value);
    if (!season || seen.has(season)) continue;

    seen.add(season);
    normalizedSeasons.push(season);
  }

  return normalizedSeasons;
}
