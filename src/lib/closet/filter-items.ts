import type { ClothingItem } from "@/lib/types";

function normalizeSearchValue(value: string) {
  return value.trim().toLowerCase();
}

export function filterClosetItems(items: ClothingItem[], query: string) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return items;

  return items.filter((item) => {
    const searchableValues = [
      item.name,
      item.category,
      item.color,
      ...item.styleTags,
      ...item.scenarioTags,
      ...(item.seasonTags ?? []),
    ];

    return searchableValues.some((value) =>
      normalizeSearchValue(value).includes(normalizedQuery),
    );
  });
}
