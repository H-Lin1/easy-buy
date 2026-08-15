import sharp from "sharp";

const BOARD_WIDTH = 1200;
const BOARD_HEIGHT = 1600;
const MODEL_WIDTH = 780;
const ITEM_WIDTH = BOARD_WIDTH - MODEL_WIDTH;
const MAX_SOURCE_ITEMS = 5;

export async function buildOutfitTryOnReferenceBoard({
  modelImage,
  candidateImage,
  closetImages,
}: {
  modelImage: Buffer;
  candidateImage: Buffer;
  closetImages: Buffer[];
}) {
  const sourceImages = [candidateImage, ...closetImages.slice(0, MAX_SOURCE_ITEMS - 1)];
  const tileHeight = Math.floor(BOARD_HEIGHT / sourceImages.length);
  const modelPanel = await fitImage(modelImage, MODEL_WIDTH, BOARD_HEIGHT, "#f3f0ed");
  const sourcePanels = await Promise.all(
    sourceImages.map((image, index) =>
      fitImage(
        image,
        ITEM_WIDTH - 2,
        index === sourceImages.length - 1
          ? BOARD_HEIGHT - tileHeight * index
          : tileHeight - 2,
        "#ffffff",
      ),
    ),
  );

  const board = await sharp({
    create: {
      width: BOARD_WIDTH,
      height: BOARD_HEIGHT,
      channels: 3,
      background: "#e6dfda",
    },
  })
    .composite([
      { input: modelPanel, left: 0, top: 0 },
      ...sourcePanels.map((input, index) => ({
        input,
        left: MODEL_WIDTH + 2,
        top: tileHeight * index + (index ? 2 : 0),
      })),
    ])
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return `data:image/jpeg;base64,${board.toString("base64")}`;
}

async function fitImage(
  image: Buffer,
  width: number,
  height: number,
  background: string,
) {
  return sharp(image)
    .rotate()
    .resize({
      width,
      height,
      fit: "contain",
      background,
      withoutEnlargement: false,
    })
    .flatten({ background })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
