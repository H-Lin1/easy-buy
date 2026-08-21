export type DecisionTryOnPreviewResult = {
  outfitId: string;
  position: number;
  status: "ready" | "failed";
  imageUrl?: string;
};

export function selectDecisionTryOnResult(
  results: DecisionTryOnPreviewResult[] | undefined,
  outfitId: string | undefined,
  index: number,
) {
  return results?.find((result) => result.outfitId === outfitId) ?? results?.[index];
}

export function hasDecisionTryOnImage(result: DecisionTryOnPreviewResult | undefined) {
  return result?.status === "ready" && Boolean(result.imageUrl);
}
