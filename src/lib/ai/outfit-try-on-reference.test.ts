import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { buildOutfitTryOnReferenceBoard } from "./outfit-try-on-reference.ts";

test("reference board combines model, candidate, and wardrobe images at 3:4", async () => {
  const [modelImage, candidateImage, closetImage] = await Promise.all([
    createImage("#d9d2cc"),
    createImage("#b45f5f"),
    createImage("#4f6f8f"),
  ]);
  const dataUrl = await buildOutfitTryOnReferenceBoard({
    modelImage,
    candidateImage,
    closetImages: [closetImage],
  });
  const image = Buffer.from(dataUrl.split(",")[1], "base64");
  const metadata = await sharp(image).metadata();

  assert.match(dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 1600);
});

function createImage(background: string) {
  return sharp({
    create: { width: 40, height: 60, channels: 3, background },
  })
    .png()
    .toBuffer();
}
