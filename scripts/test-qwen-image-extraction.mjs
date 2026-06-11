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
const defaultOutputDir = path.join(projectRoot, "resources", "closet-qwen-image-test");

function parseArgs(argv) {
  const args = {
    image: defaultInputImage,
    out: defaultOutputDir,
    model: undefined,
    endpoint: undefined,
    mode: "image",
    size: "1024x1365",
    responseFormat: "b64_json",
    n: 1,
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
    } else if (arg === "--endpoint" && next) {
      args.endpoint = next;
      index += 1;
    } else if (arg === "--mode" && next) {
      args.mode = next;
      index += 1;
    } else if (arg === "--size" && next) {
      args.size = next;
      index += 1;
    } else if (arg === "--response-format" && next) {
      args.responseFormat = next;
      index += 1;
    } else if (arg === "--n" && next) {
      args.n = Number(next);
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

function buildEndpoint(args) {
  if (args.endpoint) return args.endpoint;

  const baseURL = process.env.AUTODL_OPENAI_BASE_URL ?? "https://www.autodl.art/api/v1";
  return `${baseURL.replace(/\/$/, "")}/images/generations`;
}

function buildPrompt() {
  return `
请基于输入参考照片，生成一张用于衣橱 App 展示的电商商品图。任务是“衣服提取与整理”，不是重新设计衣服。

核心要求：
- 只保留参考图中的那件灰绿色/灰卡其色长袖衬衫。
- 移除衣架、床架、柜子、门、房间背景、杂物、墙面贴纸、阴影和拍摄环境。
- 将衬衫整理成正面自然平整展示，完整衣身居中，不裁切袖口、领口、下摆。
- 尽量还原原图可见的真实细节：翻领、前襟纽扣、左胸口袋、肩线、袖长、下摆弧度、洗旧棉质纹理、缝线、轻微褶皱和灰绿色颜色。
- 背景使用干净白色或极浅灰摄影棚背景，柔和真实光线，边缘清晰。

禁止：
- 不要添加模特、人体、手、衣架、夹子、额外配饰。
- 不要添加品牌 logo、文字、水印、价格、吊牌。
- 不要改成其他颜色、其他材质、其他版型、短袖、外套或新设计。
- 不要过度熨平到失去原图的洗旧质感。

photorealistic product photo, front view, white studio background, high fidelity to the reference garment, clean catalog image.
`.trim();
}

function buildPayload(args, dataUrl) {
  const prompt = buildPrompt();
  const payload = {
    model: args.model ?? process.env.AUTODL_IMAGE_MODEL ?? "Qwen-Image",
    prompt,
    n: args.n,
    size: args.size,
    response_format: args.responseFormat,
  };

  if (args.mode === "image") {
    payload.image = dataUrl;
  } else if (args.mode === "images") {
    payload.images = [dataUrl];
  } else if (args.mode === "reference_image") {
    payload.reference_image = dataUrl;
  } else if (args.mode === "input_image") {
    payload.input_image = dataUrl;
  } else if (args.mode === "prompt_data_url") {
    payload.prompt = `${prompt}\n\n参考图片 data URL：${dataUrl}`;
  } else if (args.mode !== "prompt_only") {
    throw new Error(
      `Unsupported mode: ${args.mode}. Use image, images, reference_image, input_image, prompt_data_url, or prompt_only.`,
    );
  }

  return payload;
}

function stripLargePayloadFields(payload) {
  const clone = { ...payload };
  for (const key of ["image", "reference_image", "input_image"]) {
    if (clone[key]) clone[key] = `[${key} data url omitted]`;
  }
  if (Array.isArray(clone.images)) {
    clone.images = clone.images.map((_, index) => `[images[${index}] data url omitted]`);
  }
  if (typeof clone.prompt === "string" && clone.prompt.includes("data:image/")) {
    clone.prompt = clone.prompt.replace(/data:image\/[^;\s]+;base64,[^\s]+/g, "[image data url omitted]");
  }
  return clone;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Response is not JSON: ${text.slice(0, 500)}`);
  }
}

function normalizeBase64(value) {
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1],
      base64: match[2],
    };
  }

  return {
    mimeType: "image/png",
    base64: value,
  };
}

function extensionFromMimeType(mimeType) {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  if (mimeType.includes("webp")) return ".webp";
  return ".png";
}

async function saveUrlImage(url, outputPathWithoutExtension) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to download generated image ${response.status}: ${text.slice(0, 300)}`);
  }

  const contentType = response.headers.get("content-type") ?? "image/png";
  const extension = extensionFromMimeType(contentType);
  const arrayBuffer = await response.arrayBuffer();
  const filePath = `${outputPathWithoutExtension}${extension}`;
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
  return filePath;
}

function saveBase64Image(value, outputPathWithoutExtension) {
  const { mimeType, base64 } = normalizeBase64(value);
  const extension = extensionFromMimeType(mimeType);
  const filePath = `${outputPathWithoutExtension}${extension}`;
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

async function saveGeneratedImages(result, outputDir) {
  const saved = [];
  const data = Array.isArray(result.data) ? result.data : [];

  for (let index = 0; index < data.length; index += 1) {
    const item = data[index];
    const outputBase = path.join(outputDir, `qwen-image-extraction-${String(index + 1).padStart(2, "0")}`);

    if (item.b64_json) {
      saved.push(saveBase64Image(item.b64_json, outputBase));
    } else if (item.url) {
      saved.push(await saveUrlImage(item.url, outputBase));
    } else if (item.image) {
      saved.push(saveBase64Image(item.image, outputBase));
    } else if (item.base64) {
      saved.push(saveBase64Image(item.base64, outputBase));
    }
  }

  return saved;
}

async function callImageModel(endpoint, apiKey, payload, timeoutMs) {
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

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AutoDL image API failed ${response.status}: ${text.slice(0, 1000)}`);
    }

    return parseJsonResponse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  loadEnvFile(path.join(projectRoot, ".env.local"));

  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.AUTODL_API_KEY;
  const endpoint = buildEndpoint(args);
  const timeoutMs = Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 120000);

  if (!apiKey) {
    throw new Error("AUTODL_API_KEY is missing. Put it in .env.local before running this script.");
  }

  if (!fs.existsSync(args.image)) {
    throw new Error(`Input image does not exist: ${args.image}`);
  }

  fs.mkdirSync(args.out, { recursive: true });

  const dataUrl = imageToDataUrl(args.image);
  const payload = buildPayload(args, dataUrl);
  const startedAt = new Date().toISOString();
  const started = performance.now();

  console.log(`Calling ${payload.model} at ${endpoint}`);
  console.log(`Input: ${args.image}`);
  console.log(`Output: ${args.out}`);
  console.log(`Mode: ${args.mode}, size: ${args.size}`);

  const result = await callImageModel(endpoint, apiKey, payload, timeoutMs);
  const savedImages = await saveGeneratedImages(result, args.out);

  const metadata = {
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    endpoint,
    inputImage: args.image,
    outputDir: args.out,
    savedImages,
    request: stripLargePayloadFields(payload),
    response: result,
  };

  const metadataPath = path.join(args.out, "qwen-image-extraction.metadata.json");
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
