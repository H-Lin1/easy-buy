import type { OutfitCombination, PurchaseDecisionReport } from "./types";

export const MAX_OUTFIT_TRY_ONS = 3;
export const MAX_TRY_ON_ATTEMPTS = 2;

export function withStableOutfitIds(outfits: OutfitCombination[]): OutfitCombination[] {
  return outfits.map((outfit, position) => ({
    ...outfit,
    outfitId: outfit.outfitId || createStableOutfitId(outfit, position),
  }));
}

export function getEligibleTryOnOutfits(
  report: Pick<PurchaseDecisionReport, "usedModel" | "outfitCombinations">,
  hasCandidateImage: boolean,
) {
  if (!report.usedModel || !hasCandidateImage) return [];

  return withStableOutfitIds(report.outfitCombinations)
    .filter(
      (outfit) =>
        outfit.visualIntent === "outfit" &&
        Boolean(outfit.outfitId) &&
        Boolean(outfit.closetItemIds?.length),
    )
    .slice(0, MAX_OUTFIT_TRY_ONS);
}

export function settleTryOnJobs<T>(jobs: Array<() => Promise<T>>) {
  if (jobs.length > MAX_OUTFIT_TRY_ONS) {
    throw new Error(`A try-on batch cannot exceed ${MAX_OUTFIT_TRY_ONS} jobs.`);
  }

  return Promise.allSettled(jobs.map((job) => job()));
}

export function needsTryOnGeneration(row: { status: string; imagePath?: string | null }) {
  return row.status !== "ready" || !row.imagePath;
}

export function shouldRetryTryOn(
  attempt: number,
  row: { status: string; imagePath?: string | null },
) {
  return attempt + 1 < MAX_TRY_ON_ATTEMPTS && needsTryOnGeneration(row);
}

function createStableOutfitId(outfit: OutfitCombination, position: number) {
  const source = [
    position,
    outfit.title,
    outfit.scenario,
    ...(outfit.closetItemIds?.length
      ? [...new Set(outfit.closetItemIds)].sort()
      : outfit.items ?? []),
  ].join("|");

  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return `outfit-${toHex(first)}${toHex(second)}`;
}

function toHex(value: number) {
  return (value >>> 0).toString(16).padStart(8, "0");
}
