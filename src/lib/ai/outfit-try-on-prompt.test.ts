import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOutfitTryOnNegativePrompt,
  buildOutfitTryOnPrompt,
  OUTFIT_TRY_ON_PROMPT_VERSION,
} from "./outfit-try-on-prompt.ts";

test("native multi-image prompt assigns stable roles and prioritizes garment pixels", () => {
  const outfit = {
    title: "浅色日常搭配",
    scenario: "日常出街",
    closetItemIds: ["outerwear-id", "bottom-id"],
    summary: "将上衣塞入裤腰，这段用户可见解释绝不能进入生图提示词。",
  };
  const prompt = buildOutfitTryOnPrompt(
    { productName: "花灰色竖条纹针织 Polo 衫", category: "Polo衫", color: "花灰色" },
    outfit,
  );

  assert.equal(
    OUTFIT_TRY_ON_PROMPT_VERSION,
    "outfit-try-on-v6-quiet-luxury-mandatory-garments",
  );
  assert.match(prompt, /IMAGE 1 - PERSON IDENTITY ONLY/i);
  assert.match(prompt, /Do not copy Image 1's pose.*camera angle.*lighting.*background/i);
  assert.match(prompt, /relaxed, natural standing pose/i);
  assert.match(prompt, /lifestyle fashion photograph/i);
  assert.match(prompt, /lower two-thirds of the frame/i);
  assert.match(prompt, /upper one-third above the head as clean, uncluttered negative space/i);
  assert.match(prompt, /Keep the head and feet fully inside the frame/i);
  assert.match(prompt, /ignore and replace every garment and shoe originally worn in Image 1/i);
  assert.match(prompt, /IMAGE 2 - CANDIDATE GARMENT/i);
  assert.match(prompt, /pixels are the primary visual source of truth/i);
  assert.match(prompt, /IMAGES 3 ONWARD - WARDROBE GARMENTS/i);
  assert.match(prompt, /MANDATORY GARMENT INVENTORY/i);
  assert.match(prompt, /all 3 supplied garments exactly once/i);
  assert.match(prompt, /Image 2 plus all 2 wardrobe garments in Images 3 through 4/i);
  assert.match(prompt, /Every listed garment is mandatory, not optional/i);
  assert.match(prompt, /Wear every supplied garment.*intended clothing category.*conventional body position/i);
  assert.match(prompt, /held in a hand.*draped over a shoulder.*tied around the waist/i);
  assert.match(prompt, /outer layer open as needed/i);
  assert.match(prompt, /Never solve a visibility conflict by omitting.*merging.*fully covering/i);
  assert.match(prompt, /collar or neckline shape and width/i);
  assert.match(prompt, /exact sleeve length/i);
  assert.match(prompt, /body length, hem shape, silhouette/i);
  assert.match(prompt, /exact waist rise, waistband construction/i);
  assert.match(prompt, /leg shape such as straight, tapered, or wide/i);
  assert.match(prompt, /change the pose, layering, or scene instead of changing the garment/i);
  assert.match(prompt, /text metadata conflicts.*follow the garment image pixels/i);
  assert.match(prompt, /catalog color metadata: 花灰色/);
  assert.match(prompt, /Outfit: 浅色日常搭配; scenario: 日常出街\./);
  assert.match(prompt, /STYLE DIRECTION — QUIET LUXURY EDITORIAL/i);
  assert.match(prompt, /sunlit minimalist apartment/i);
  assert.match(prompt, /calm neutral palette/i);
  assert.match(prompt, /clear silhouette hierarchy/i);
  assert.match(prompt, /Do not force a specific tuck, pose, or accessory/i);
  assert.doesNotMatch(prompt, /将上衣塞入裤腰/);
  assert.doesNotMatch(prompt, /reference board/i);
});

test("negative prompt rejects inherited model clothing and color drift", () => {
  const negativePrompt = buildOutfitTryOnNegativePrompt();

  assert.match(negativePrompt, /inherited model-reference clothing/i);
  assert.match(negativePrompt, /changed garment color/i);
  assert.match(negativePrompt, /changed undertone/i);
  assert.match(negativePrompt, /changed sleeve length/i);
  assert.match(negativePrompt, /changed waist rise/i);
  assert.match(negativePrompt, /unused supplied garment/i);
  assert.match(negativePrompt, /garment held in hand/i);
  assert.match(negativePrompt, /garment draped over shoulder/i);
  assert.match(negativePrompt, /garment tied around waist/i);
  assert.match(negativePrompt, /stiff front-facing passport pose/i);
  assert.doesNotMatch(negativePrompt, /outdoor background/i);
});
