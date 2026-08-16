import type { OutfitCombination, PurchaseCandidateAIProfile } from "./types";

export const OUTFIT_TRY_ON_PROMPT_VERSION = "outfit-try-on-v4-autonomous-styling";

export function buildOutfitTryOnPrompt(
  candidate: Pick<PurchaseCandidateAIProfile, "productName" | "category" | "color">,
  outfit: Pick<OutfitCombination, "title" | "scenario">,
) {
  return [
    "Create one photorealistic full-body lifestyle fashion photograph from the supplied image references.",
    "SCENE AND COMPOSITION: Recompose the person in a relaxed, natural standing pose with subtle asymmetry and believable hand placement that does not cover the garments. Show the complete body from head to feet at eye level in a portrait-oriented frame. Use a tasteful contemporary everyday interior appropriate to the outfit scenario, soft natural daylight, realistic skin and fabric texture, and restrained editorial fashion photography. The result must feel candid and lived-in rather than like a catalog studio, passport photo, mannequin, or runway pose.",
    "IMAGE 1 - PERSON IDENTITY ONLY: Preserve this exact adult model's identity, face, facial features, skin tone, apparent age, hairstyle, height, body shape, and shoulder, waist, torso, arm, and leg proportions. Do not copy Image 1's pose, hand position, camera angle, framing, lighting, background, or clothing silhouette. Completely ignore and replace every garment and shoe originally worn in Image 1; their colors, shapes, fit, and materials are not outfit references.",
    "IMAGE 2 - CANDIDATE GARMENT: Its pixels are the primary visual source of truth. Preserve its exact visible color and undertone, material, texture, pattern, construction, and garment geometry. The collar or neckline shape and width, placket or closure, shoulder line, sleeve construction and exact sleeve length, body length, hem shape, silhouette, volume, seams, and distinctive details must not change. Do not roll, cuff, shorten, lengthen, tuck, resize, slim, widen, or redesign it unless that treatment is explicitly visible in the source image.",
    "IMAGES 3 ONWARD - WARDROBE GARMENTS: Use every supplied wardrobe garment exactly once in source order. Preserve each garment's visible color, material, texture, pattern, construction, and geometry. For tops and outerwear, preserve the neckline or collar, shoulder line, sleeve type and length, body length, hem, closure, and silhouette. For trousers, preserve the exact waist rise, waistband construction, pleats, drawstring or belt loops, hip and thigh volume, leg shape such as straight, tapered, or wide, trouser length, and cuff. For skirts and dresses, preserve the waistline, length, hem, volume, and silhouette.",
    `Candidate garment: ${candidate.productName}; category: ${candidate.category}; catalog color metadata: ${candidate.color}.`,
    `Outfit: ${outfit.title}; scenario: ${outfit.scenario}.`,
    "FIDELITY PRIORITY: When text metadata conflicts with a garment image, follow the garment image pixels. Styling must adapt to the garments, never the reverse. If the pose, layering, or scene conflicts with garment fidelity, change the pose, layering, or scene instead of changing the garment. Fit the garments naturally to the preserved body proportions with realistic drape, folds, occlusion, gravity, lighting, and shadows, but do not alter their construction or proportions.",
    "Use natural layering according to garment category. Do not invent, omit, recolor, replace, duplicate, or cover the supplied garments, and do not add another garment or a prominent unreferenced accessory. Produce only the final lifestyle fashion photograph, never the input images, labels, panels, product grids, or a collage.",
    "This is a styling visualization, not a body-shape or size-fit guarantee.",
  ].join("\n");
}

export function buildOutfitTryOnNegativePrompt() {
  return [
    "different person, changed face, changed hair, altered body shape, cropped head, cropped feet",
    "extra person, extra limbs, malformed hands, duplicate garment, missing garment, prominent invented accessory",
    "inherited model-reference clothing, changed garment color, changed undertone, changed pattern, changed fabric, changed silhouette, changed collar, changed neckline, changed sleeve length, rolled sleeves, changed hem length, changed waist rise, changed waistband, changed trouser shape, changed trouser length, logo, text, watermark",
    "collage, split screen, reference board, product grid, labels, captions, frame, border",
    "stiff front-facing passport pose, mannequin pose, sterile catalog studio, flat gray seamless background, exaggerated runway pose, seated pose, crouching pose, hands covering clothes, mirror selfie",
  ].join(", ");
}
