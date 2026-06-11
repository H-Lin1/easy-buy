import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const defaultInputImage = path.join(
  projectRoot,
  "resources",
  "closet",
  "微信图片_20260610124157_324_2.jpg",
);
const defaultOutputDir = path.join(projectRoot, "resources", "closet-siliconflow-image-edit-test");

function parseArgs(argv) {
  const args = {
    image: defaultInputImage,
    out: defaultOutputDir,
    model: process.env.AI_IMAGE_EDIT_MODEL ?? "Qwen/Qwen-Image-Edit-2509",
    prompt: undefined,
    negativePrompt: undefined,
    seed: undefined,
    steps: undefined,
    timeoutMs: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--image" && next) {
      args.image = path.resolve(next);
      index += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(next);
      index += 1;
    } else if (arg === "--model" && next) {
      args.model = next;
      index += 1;
    } else if (arg === "--prompt" && next) {
      args.prompt = next;
      index += 1;
    } else if (arg === "--negative-prompt" && next) {
      args.negativePrompt = next;
      index += 1;
    } else if (arg === "--seed" && next) {
      args.seed = Number(next);
      index += 1;
    } else if (arg === "--steps" && next) {
      args.steps = Number(next);
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      args.timeoutMs = Number(next);
      index += 1;
    }
  }

  return args;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function imageToDataUrl(filePath) {
  const mimeType = getMimeType(filePath);
  const base64 = fs.readFileSync(filePath).toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

function buildPrompt() {
  return `
任务：把参考照片中的单件衣服整理成衣橱 App 可用的白底商品展示图。请把它当作“忠实图像编辑/整理”，不是重新设计衣服。

必须保留：
- 只保留参考图里这件衣服本身，保持同一件衣服的真实身份。
- 严格保留原衣服的主色、材质质感、洗旧/磨白纹理、缝线、领型、肩线、袖长、衣长、下摆形状、门襟、纽扣数量与位置、口袋形状与位置。
- 保留自然布料质感和少量真实褶皱，不要把衣服变成全新的硬挺样衣。

需要处理：
- 移除衣架、夹子、挂钩、床架、柜子、门、墙面、杂物、阴影、环境反光和所有无关背景。
- 将衣服摆正为正面自然垂挂/平铺的电商商品图，完整居中，不裁切领口、袖口、下摆。
- 对拍摄造成的倾斜、遮挡感、随意堆叠感和明显杂乱褶皱做轻度整理，让衣服看起来接近它原本自然展开的样子。
- 如果某些不可见区域需要补全，只能根据参考图的同款结构做保守补全，不能发明新设计。
- 背景为纯白或极浅灰摄影棚背景，柔和真实光线，清晰边缘。

禁止：
- 不要添加模特、人体、手、衣架、吊牌、品牌 logo、文字、水印、价格、额外配饰。
- 不要改变颜色、面料、版型、袖长、衣长、领型、口袋、纽扣、下摆、装饰线或图案。
- 不要把衣服改成更时髦、更修身、更宽松、更厚、更薄或另一个商品。
- 不要过度磨皮、过度熨平、过度美化，不要产生塑料感或假电商图。

输出风格：真实电商平铺/挂拍商品图，front view, centered full garment, white studio background, high fidelity to the reference garment, faithful garment restoration.
`.trim();
}

function buildNegativePrompt() {
  return `
model, person, mannequin, human body, hands, hanger, hook, clip, tag, logo, watermark, text, price, extra accessories,
changed color, changed material, changed pocket, changed collar, changed buttons, changed hem, changed sleeve length, changed fit,
new design, different garment, fantasy fashion, over-smoothed fabric, plastic texture, blurry edges, cropped garment, messy background
`.trim();
}

function buildEndpoint() {
  const baseURL = process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1";
  return `${baseURL.replace(/\/$/, "")}/images/generations`;
}

function buildPayload(args, imageDataUrl) {
  const payload = {
    model: args.model,
    prompt: args.prompt ?? buildPrompt(),
    negative_prompt: args.negativePrompt ?? buildNegativePrompt(),
    image: imageDataUrl,
  };

  if (Number.isFinite(args.seed)) {
    payload.seed = args.seed;
  }

  if (Number.isFinite(args.steps)) {
    payload.num_inference_steps = args.steps;
  }

  return payload;
}

function stripLargePayloadFields(payload) {
  return {
    ...payload,
    image: payload.image ? "[image data url omitted]" : undefined,
    image2: payload.image2 ? "[image2 data url omitted]" : undefined,
    image3: payload.image3 ? "[image3 data url omitted]" : undefined,
  };
}

function stripTemporaryUrls(result) {
  return {
    ...result,
    images: Array.isArray(result.images)
      ? result.images.map((item) => ({ ...item, url: item?.url ? "[temporary image url omitted]" : item?.url }))
      : result.images,
    data: Array.isArray(result.data)
      ? result.data.map((item) => ({ ...item, url: item?.url ? "[temporary image url omitted]" : item?.url }))
      : result.data,
  };
}

function extensionFromContentType(contentType) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  return ".png";
}

async function downloadImage(url, outputPathWithoutExtension) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to download image ${response.status}: ${text.slice(0, 500)}`);
  }

  const contentType = response.headers.get("content-type") ?? "image/png";
  const extension = extensionFromContentType(contentType);
  const imagePath = `${outputPathWithoutExtension}${extension}`;
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(imagePath, buffer);
  return imagePath;
}

async function saveGeneratedImages(result, outputDir) {
  const images = Array.isArray(result.images) ? result.images : [];
  const saved = [];

  for (let index = 0; index < images.length; index += 1) {
    const item = images[index];
    if (!item?.url) continue;

    const outputBase = path.join(
      outputDir,
      `siliconflow-qwen-image-edit-${String(index + 1).padStart(2, "0")}`,
    );
    saved.push(await downloadImage(item.url, outputBase));
  }

  return saved;
}

async function callSiliconFlowImageEdit(endpoint, apiKey, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const traceId = response.headers.get("x-siliconcloud-trace-id");
    const text = await response.text();
    let result;

    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`SiliconFlow response is not JSON: ${text.slice(0, 500)}`);
    }

    if (!response.ok) {
      const message = result?.message ?? result?.error?.message ?? text;
      throw new Error(`SiliconFlow image API failed ${response.status}: ${message}`);
    }

    return { result, traceId };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  loadEnvFile(path.join(projectRoot, ".env.local"));

  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const endpoint = buildEndpoint();
  const timeoutMs = Number(args.timeoutMs ?? process.env.SILICONFLOW_IMAGE_TIMEOUT_MS ?? 180000);

  if (!apiKey) {
    throw new Error("SILICONFLOW_API_KEY is missing. Put it in .env.local before running this script.");
  }

  if (!fs.existsSync(args.image)) {
    throw new Error(`Input image does not exist: ${args.image}`);
  }

  fs.mkdirSync(args.out, { recursive: true });

  const imageDataUrl = imageToDataUrl(args.image);
  const payload = buildPayload(args, imageDataUrl);
  const startedAt = new Date().toISOString();
  const started = performance.now();

  console.log(`Calling ${args.model}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Input: ${args.image}`);
  console.log(`Output: ${args.out}`);

  const { result, traceId } = await callSiliconFlowImageEdit(endpoint, apiKey, payload, timeoutMs);
  const savedImages = await saveGeneratedImages(result, args.out);

  const metadata = {
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    endpoint,
    traceId,
    inputImage: args.image,
    outputDir: args.out,
    savedImages,
    request: stripLargePayloadFields(payload),
    response: stripTemporaryUrls(result),
  };

  const metadataPath = path.join(args.out, "siliconflow-qwen-image-edit.metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  console.log(`Saved ${savedImages.length} image(s).`);
  for (const imagePath of savedImages) {
    console.log(`  ${imagePath}`);
  }
  console.log(`Metadata: ${metadataPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
