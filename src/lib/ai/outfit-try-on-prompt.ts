import type { OutfitCombination, PurchaseCandidateAIProfile } from "./types";

export const OUTFIT_TRY_ON_PROMPT_VERSION = "outfit-try-on-v2-native-multi-image";

export function buildOutfitTryOnPrompt(
  candidate: Pick<PurchaseCandidateAIProfile, "productName" | "category" | "color">,
  outfit: Pick<OutfitCombination, "title" | "scenario" | "summary">,
) {
  return [
    "Create one photorealistic full-body fashion try-on photograph from the supplied image references.",
    "Image 1 is the identity, body proportion, pose, framing, lighting, and background reference only. Preserve this exact adult model's face, hair, body proportions, neutral standing pose, camera angle, full head-to-toe framing, studio lighting, and warm light-gray background. Completely ignore and replace every garment and shoe originally worn in Image 1; their colors, shapes, and materials are not outfit references.",
    "Image 2 is the candidate garment and its pixels are the primary visual source of truth. Preserve its exact visible color and undertone under neutral studio lighting, plus its material, texture, pattern, collar or neckline, sleeve length, hem length, silhouette, and distinctive construction details. Do not normalize, reinterpret, or borrow its color from Image 1 or from text metadata.",
    "Images 3 onward are wardrobe garments for this outfit, in source order. Use every supplied wardrobe garment exactly once and preserve the visible appearance of each corresponding image.",
    `Candidate garment: ${candidate.productName}; category: ${candidate.category}; catalog color metadata: ${candidate.color}.`,
    `Outfit: ${outfit.title}; scenario: ${outfit.scenario}. ${outfit.summary}`,
    "When text metadata conflicts with a garment image, follow the garment image pixels. Do not invent, omit, recolor, replace, or duplicate garments, and do not add unreferenced accessories.",
    "Resolve natural layering according to garment category. Produce only the final clean studio photograph, never the input images, labels, panels, product grids, or a collage.",
    "This is a styling visualization, not a body-shape or size-fit guarantee.",
  ].join("\n");
}

export function buildOutfitTryOnNegativePrompt() {
  return [
    "different person, changed face, changed hair, altered body shape, cropped head, cropped feet",
    "extra person, extra limbs, malformed hands, duplicate garment, missing garment, invented accessory",
    "inherited model-reference clothing, changed garment color, changed undertone, changed pattern, changed fabric, changed silhouette, logo, text, watermark",
    "collage, split screen, reference board, product grid, labels, captions, frame, border",
    "dramatic pose, seated pose, runway background, outdoor background, mirror selfie",
  ].join(", ");
}
