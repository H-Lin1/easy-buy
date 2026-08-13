export type ClosetStoragePaths = {
  imagePath?: string | null;
  processedImagePath?: string | null;
  displayImagePath?: string | null;
};

export function collectClosetStorageCleanupPaths(...sources: ClosetStoragePaths[]) {
  return Array.from(
    new Set(
      sources
        .flatMap((source) => [
          source.imagePath,
          source.processedImagePath,
          source.displayImagePath,
        ])
        .filter((path): path is string => Boolean(path)),
    ),
  );
}

export function restoreClosetItemAtIndex<T extends { id: string }>(
  items: T[],
  item: T,
  originalIndex: number,
) {
  if (items.some((currentItem) => currentItem.id === item.id)) return items;

  const restoredItems = [...items];
  const restoreIndex = Math.min(Math.max(originalIndex, 0), restoredItems.length);
  restoredItems.splice(restoreIndex, 0, item);
  return restoredItems;
}
