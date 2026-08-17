import type { OutfitCombination, PurchaseCandidateAIProfile } from "./types";

export const OUTFIT_TRY_ON_PROMPT_VERSION =
  "outfit-try-on-v6-quiet-luxury-mandatory-garments";

export function buildOutfitTryOnPrompt(
  candidate: Pick<PurchaseCandidateAIProfile, "productName" | "category" | "color">,
  outfit: Pick<OutfitCombination, "title" | "scenario" | "closetItemIds">,
) {
  const wardrobeGarmentCount = outfit.closetItemIds?.length ?? 0;
  const totalGarmentCount = wardrobeGarmentCount + 1;
  const mandatoryImageRange = wardrobeGarmentCount === 0
    ? "Image 2 is the only supplied garment."
    : wardrobeGarmentCount === 1
      ? "Image 2 plus the wardrobe garment in Image 3."
      : `Image 2 plus all ${wardrobeGarmentCount} wardrobe garments in Images 3 through ${wardrobeGarmentCount + 2}.`;

  return [
    "Create one photorealistic full-body lifestyle fashion photograph from the supplied image references.",
    "SCENE AND COMPOSITION: Recompose the person in a relaxed, natural standing pose with subtle asymmetry and believable hand placement that does not cover the garments. Show the complete body from head to feet at eye level in a portrait-oriented frame. Place the full model in approximately the lower two-thirds of the frame, leaving approximately the upper one-third above the head as clean, uncluttered negative space. Keep the head and feet fully inside the frame; do not crop or let the person expand into the reserved upper space. Use a tasteful contemporary everyday interior appropriate to the outfit scenario, soft natural daylight, realistic skin and fabric texture, and restrained editorial fashion photography. The result must feel candid and lived-in rather than like a catalog studio, passport photo, mannequin, or runway pose.",
    "IMAGE 1 - PERSON IDENTITY ONLY: Preserve this exact adult model's identity, face, facial features, skin tone, apparent age, hairstyle, height, body shape, and shoulder, waist, torso, arm, and leg proportions. Do not copy Image 1's pose, hand position, camera angle, framing, lighting, background, or clothing silhouette. Completely ignore and replace every garment and shoe originally worn in Image 1; their colors, shapes, fit, and materials are not outfit references.",
    "IMAGE 2 - CANDIDATE GARMENT: Its pixels are the primary visual source of truth. Preserve its exact visible color and undertone, material, texture, pattern, construction, and garment geometry. The collar or neckline shape and width, placket or closure, shoulder line, sleeve construction and exact sleeve length, body length, hem shape, silhouette, volume, seams, and distinctive details must not change. Do not roll, cuff, shorten, lengthen, tuck, resize, slim, widen, or redesign it unless that treatment is explicitly visible in the source image.",
    "IMAGES 3 ONWARD - WARDROBE GARMENTS: Use every supplied wardrobe garment exactly once in source order. Preserve each garment's visible color, material, texture, pattern, construction, and geometry. For tops and outerwear, preserve the neckline or collar, shoulder line, sleeve type and length, body length, hem, closure, and silhouette. For trousers, preserve the exact waist rise, waistband construction, pleats, drawstring or belt loops, hip and thigh volume, leg shape such as straight, tapered, or wide, trouser length, and cuff. For skirts and dresses, preserve the waistline, length, hem, volume, and silhouette.",
    `MANDATORY GARMENT INVENTORY: The final outfit must visibly and correctly wear all ${totalGarmentCount} supplied garments exactly once. ${mandatoryImageRange} Every listed garment is mandatory, not optional, and must remain identifiable against its own source image.`,
    "CORRECT USE AND VISIBILITY: Wear every supplied garment on the model in its intended clothing category and conventional body position. A garment does not count as used if it is held in a hand, draped over a shoulder or arm, tied around the waist, placed in the scene, converted into an accessory, merged into another garment, fully hidden, or used on the wrong body area. Keep enough identifying structure visible to verify every garment: for tops and inner layers, show the neckline or collar, torso, and relevant sleeves or hem; for outer layers, show the collar or hood, shoulders, sleeves, front opening or body, and hem; for bottoms, show the waistband or rise, leg or skirt silhouette, and length; for one-piece garments, show the neckline, main body, waist relationship, and hem.",
    "MANDATORY LAYERING: Natural partial occlusion is allowed only when every garment remains clearly identifiable. When layering would hide another mandatory garment, wear the outer layer open as needed and adjust the layering, pose, arm placement, framing, or scene to reveal all supplied garments. Never solve a visibility conflict by omitting, replacing, merging, recoloring, redesigning, or fully covering any supplied garment.",
    `Candidate garment: ${candidate.productName}; category: ${candidate.category}; catalog color metadata: ${candidate.color}.`,
    `Outfit: ${outfit.title}; scenario: ${outfit.scenario}.`,
    "FIDELITY PRIORITY: When text metadata conflicts with a garment image, follow the garment image pixels. Styling must adapt to the garments, never the reverse. If the pose, layering, or scene conflicts with garment fidelity, change the pose, layering, or scene instead of changing the garment. Fit the garments naturally to the preserved body proportions with realistic drape, folds, occlusion, gravity, lighting, and shadows, but do not alter their construction or proportions.",
    "Use natural layering according to garment category. Do not invent, omit, recolor, replace, duplicate, merge, misuse, or fully cover the supplied garments, and do not add another garment or a prominent unreferenced accessory. Produce only the final lifestyle fashion photograph, never the input images, labels, panels, product grids, or a collage.",
    "This is a styling visualization, not a body-shape or size-fit guarantee.",
    "STYLE DIRECTION — QUIET LUXURY EDITORIAL: This style direction is subordinate to the mandatory garment inventory and garment-fidelity rules above. Create a refined contemporary fashion editorial in a sunlit minimalist apartment with warm stone, pale wood, and soft geometric shadows. Use a calm neutral palette, clean vertical composition, elegant relaxed posture, subtle asymmetry, and premium-looking proportion and drape. Make the outfit feel intentionally styled and sophisticated through restraint, material contrast, and clear silhouette hierarchy, while keeping every supplied garment faithful and visibly used. Keep the result approachable and wearable rather than theatrical, runway-like, or purely catalog-like. Do not force a specific tuck, pose, or accessory; choose the most natural styling that keeps every mandatory garment correctly worn and identifiable.",
  ].join("\n");
}

export function buildOutfitTryOnNegativePrompt() {
  return [
    "different person, changed face, changed hair, altered body shape, cropped head, cropped feet",
    "extra person, extra limbs, malformed hands, duplicate garment, missing garment, unused supplied garment, fully hidden supplied garment, merged garments, incorrect garment role, garment on wrong body area, garment held in hand, garment draped over shoulder or arm, garment tied around waist, off-body garment placed in scene, prominent invented accessory",
    "inherited model-reference clothing, changed garment color, changed undertone, changed pattern, changed fabric, changed silhouette, changed collar, changed neckline, changed sleeve length, rolled sleeves, changed hem length, changed waist rise, changed waistband, changed trouser shape, changed trouser length, logo, text, watermark",
    "collage, split screen, reference board, product grid, labels, captions, frame, border",
    "stiff front-facing passport pose, mannequin pose, sterile catalog studio, flat gray seamless background, exaggerated runway pose, seated pose, crouching pose, hands covering clothes, mirror selfie",
  ].join(", ");
}
