import type { ClothingItem } from "@/lib/types";
import {
  closetSeasonOptions,
  normalizeClosetSeasons,
  type ClosetSeason,
} from "./season.ts";

export { closetSeasonOptions } from "./season.ts";

export const closetStatusOptions = [
  { value: "often", label: "常穿" },
  { value: "sometimes", label: "偶尔穿" },
  { value: "rarely", label: "闲置" },
  { value: "unknown", label: "待确认" },
] as const;

export type ClosetSeasonFilter = ClosetSeason;
export type ClosetStatusFilter = ClothingItem["wearFrequency"];

export type ClosetFilters = {
  categories: string[];
  styles: string[];
  colors: string[];
  seasons: ClosetSeasonFilter[];
  statuses: ClosetStatusFilter[];
};

export type ClosetFilterOption<Value extends string = string> = {
  value: Value;
  label: string;
};

export type ClosetFilterOptions = {
  categories: ClosetFilterOption[];
  styles: ClosetFilterOption[];
  colors: ClosetFilterOption[];
  seasons: readonly ClosetFilterOption<ClosetSeasonFilter>[];
  statuses: readonly ClosetFilterOption<ClosetStatusFilter>[];
};

function normalizeClosetValue(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function selectedValues(values: readonly string[] | undefined) {
  return new Set(values?.map(normalizeClosetValue).filter(Boolean));
}

function matchesValue(value: string | null | undefined, selected: Set<string>) {
  return selected.size === 0 || selected.has(normalizeClosetValue(value));
}

function matchesAnyValue(values: readonly string[] | null | undefined, selected: Set<string>) {
  return selected.size === 0 || values?.some((value) => selected.has(normalizeClosetValue(value)));
}

function matchesSeason(
  seasonTags: readonly string[] | null | undefined,
  selected: Set<ClosetSeason>,
) {
  if (selected.size === 0) return true;

  const availableSeasons = new Set(normalizeClosetSeasons(seasonTags));
  return [...selected].some(
    (season) =>
      availableSeasons.has(season) ||
      (season !== "四季" && availableSeasons.has("四季")),
  );
}

function matchesSearchQuery(item: ClothingItem, normalizedQuery: string) {
  if (!normalizedQuery) return true;

  const searchableValues = [
    item.name,
    item.category,
    item.color,
    ...(item.styleTags ?? []),
    ...(item.scenarioTags ?? []),
    ...normalizeClosetSeasons(item.seasonTags),
  ];

  return searchableValues.some((value) => normalizeClosetValue(value).includes(normalizedQuery));
}

function collectUniqueOptions(values: Iterable<string | null | undefined>) {
  const seen = new Set<string>();
  const options: ClosetFilterOption[] = [];

  for (const rawValue of values) {
    const label = rawValue?.trim() ?? "";
    const value = normalizeClosetValue(rawValue);
    if (!value || seen.has(value)) continue;

    seen.add(value);
    options.push({ value, label });
  }

  return options;
}

export function createEmptyClosetFilters(): ClosetFilters {
  return {
    categories: [],
    styles: [],
    colors: [],
    seasons: [],
    statuses: [],
  };
}

export function hasActiveClosetFilters(filters: ClosetFilters) {
  return Object.values(filters).some((values) => selectedValues(values).size > 0);
}

export function getClosetFilterOptions(items: ClothingItem[]): ClosetFilterOptions {
  return {
    categories: collectUniqueOptions(items.map((item) => item.category)),
    styles: collectUniqueOptions(items.flatMap((item) => item.styleTags ?? [])),
    colors: collectUniqueOptions(items.map((item) => item.color)),
    seasons: closetSeasonOptions,
    statuses: closetStatusOptions,
  };
}

export function filterClosetItems(
  items: ClothingItem[],
  query: string,
  filters: ClosetFilters = createEmptyClosetFilters(),
) {
  const normalizedQuery = normalizeClosetValue(query);
  if (!normalizedQuery && !hasActiveClosetFilters(filters)) return items;

  const categories = selectedValues(filters.categories);
  const styles = selectedValues(filters.styles);
  const colors = selectedValues(filters.colors);
  const seasons = new Set(normalizeClosetSeasons(filters.seasons));
  const statuses = selectedValues(filters.statuses);

  return items.filter(
    (item) =>
      matchesSearchQuery(item, normalizedQuery) &&
      matchesValue(item.category, categories) &&
      matchesAnyValue(item.styleTags, styles) &&
      matchesValue(item.color, colors) &&
      matchesSeason(item.seasonTags, seasons) &&
      matchesValue(item.wearFrequency ?? "unknown", statuses),
  );
}
