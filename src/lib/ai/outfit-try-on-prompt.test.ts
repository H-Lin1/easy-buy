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
    summary: "将上衣塞入裤腰，这段用户可见解释绝不能进入生图提示词。",
  };
  const prompt = buildOutfitTryOnPrompt(
    { productName: "花灰色竖条纹针织 Polo 衫", category: "Polo衫", color: "花灰色" },
    outfit,
  );

  assert.equal(OUTFIT_TRY_ON_PROMPT_VERSION, "outfit-try-on-v4-autonomous-styling");
  assert.match(prompt, /IMAGE 1 - PERSON IDENTITY ONLY/i);
  assert.match(prompt, /Do not copy Image 1's pose.*camera angle.*lighting.*background/i);
  assert.match(prompt, /relaxed, natural standing pose/i);
  assert.match(prompt, /lifestyle fashion photograph/i);
  assert.match(prompt, /ignore and replace every garment and shoe originally worn in Image 1/i);
  assert.match(prompt, /IMAGE 2 - CANDIDATE GARMENT/i);
  assert.match(prompt, /pixels are the primary visual source of truth/i);
  assert.match(prompt, /IMAGES 3 ONWARD - WARDROBE GARMENTS/i);
  assert.match(prompt, /collar or neckline shape and width/i);
  assert.match(prompt, /exact sleeve length/i);
  assert.match(prompt, /body length, hem shape, silhouette/i);
  assert.match(prompt, /exact waist rise, waistband construction/i);
  assert.match(prompt, /leg shape such as straight, tapered, or wide/i);
  assert.match(prompt, /change the pose, layering, or scene instead of changing the garment/i);
  assert.match(prompt, /text metadata conflicts.*follow the garment image pixels/i);
  assert.match(prompt, /catalog color metadata: 花灰色/);
  assert.match(prompt, /Outfit: 浅色日常搭配; scenario: 日常出街\./);
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
  assert.match(negativePrompt, /stiff front-facing passport pose/i);
  assert.doesNotMatch(negativePrompt, /outdoor background/i);
});
