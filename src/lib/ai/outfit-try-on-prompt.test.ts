import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOutfitTryOnNegativePrompt,
  buildOutfitTryOnPrompt,
  OUTFIT_TRY_ON_PROMPT_VERSION,
} from "./outfit-try-on-prompt.ts";

test("native multi-image prompt assigns stable roles and prioritizes garment pixels", () => {
  const prompt = buildOutfitTryOnPrompt(
    { productName: "花灰色竖条纹针织 Polo 衫", category: "Polo衫", color: "花灰色" },
    { title: "浅色日常搭配", scenario: "日常出街", summary: "搭配米白色长裤。" },
  );

  assert.equal(OUTFIT_TRY_ON_PROMPT_VERSION, "outfit-try-on-v2-native-multi-image");
  assert.match(prompt, /Image 1 is the identity/i);
  assert.match(prompt, /ignore and replace every garment and shoe originally worn in Image 1/i);
  assert.match(prompt, /Image 2 is the candidate garment/i);
  assert.match(prompt, /pixels are the primary visual source of truth/i);
  assert.match(prompt, /Images 3 onward are wardrobe garments/i);
  assert.match(prompt, /text metadata conflicts.*follow the garment image pixels/i);
  assert.match(prompt, /catalog color metadata: 花灰色/);
  assert.doesNotMatch(prompt, /reference board/i);
});

test("negative prompt rejects inherited model clothing and color drift", () => {
  const negativePrompt = buildOutfitTryOnNegativePrompt();

  assert.match(negativePrompt, /inherited model-reference clothing/i);
  assert.match(negativePrompt, /changed garment color/i);
  assert.match(negativePrompt, /changed undertone/i);
});
