import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import OpenAI from "openai";

const projectRoot = process.cwd();
const defaultInputDir = path.join(projectRoot, "resources", "closet");
const defaultOutputDir = path.join(projectRoot, "resources", "closet-ai-test");
const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function parseArgs(argv) {
  const args = {
    dir: defaultInputDir,
    out: defaultOutputDir,
    limit: 3,
    model: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--dir" && next) {
      args.dir = path.resolve(next);
      index += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(next);
      index += 1;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      index += 1;
    } else if (arg === "--model" && next) {
      args.model = next;
      index += 1;
    } else if (arg === "--all") {
      args.limit = Number.POSITIVE_INFINITY;
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

function extractJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match?.[0] ?? cleaned);
}

function buildPrompt(fileName) {
  return `
请识别这张用户真实衣橱照片中的主要衣服。照片可能来自宿舍、衣柜、床面、门后或其他复杂背景，衣服也可能有折叠、遮挡、光线偏色或未完整入镜。

请只输出严格 JSON，不要输出 Markdown 或解释文本。不要猜测品牌、价格、用户身份、用户身材。不要使用淘宝或电商同款图作为依据。

图片文件名：${fileName}

输出 JSON 字段：
{
  "itemName": "适合展示给用户看的短名称，例如 灰绿色休闲衬衫",
  "category": "品类，例如 衬衫/西装外套/连衣裙/半身裙/牛仔裤/运动鞋",
  "color": "主色，不确定用 unknown",
  "secondaryColors": ["辅助色"],
  "fit": "slim | regular | oversized | unknown",
  "length": "cropped | regular | long | unknown",
  "sleeveLength": "sleeveless | short | long | unknown",
  "materialGuess": "只能写视觉可见的可能材质，不确定用 unknown",
  "styleTags": ["简约", "通勤", "休闲", "运动", "温柔", "复古", "正式"],
  "season": ["spring", "summer", "autumn", "winter", "all-season"],
  "formality": 1,
  "scenarioTags": ["通勤", "日常", "约会", "面试", "旅行", "运动", "居家"],
  "imageQualityFlags": ["background_complex", "folded", "occluded", "partial_view", "low_light", "color_cast", "low_confidence"],
  "needsUserReview": true,
  "reviewReasons": ["需要用户确认的原因"],
  "summary": "一句话描述这件衣服，说明可见信息和不确定信息",
  "embeddingText": "用于衣橱 RAG 的自然语言摘要，包含品类、颜色、风格、场景、版型",
  "aiConfidence": 0.0
}

评分要求：
- formality 为 1-5，1 最休闲，5 最正式。
- aiConfidence 为 0-1。
- 如果衣服主体清楚但背景复杂，imageQualityFlags 应包含 background_complex，但不一定 low_confidence。
- 如果版型、长度或材质无法从照片判断，请使用 unknown 并加入 reviewReasons。
`.trim();
}

async function analyzeImage(client, model, filePath) {
  const fileName = path.basename(filePath);
  const dataUrl = imageToDataUrl(filePath);

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "你是衣橱图片识别助手。你只输出严格 JSON，帮助用户把真实衣服照片转成可确认的衣橱标签。你不重绘衣服，不猜测品牌和价格。",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildPrompt(fileName),
          },
          {
            type: "image_url",
            image_url: {
              url: dataUrl,
            },
          },
        ],
      },
    ],
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  return {
    fileName,
    raw,
    parsed: extractJson(raw),
    model,
    analyzedAt: new Date().toISOString(),
  };
}

async function main() {
  loadEnvFile(path.join(projectRoot, ".env.local"));

  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.AUTODL_API_KEY;
  const baseURL = process.env.AUTODL_OPENAI_BASE_URL ?? "https://www.autodl.art/api/v1";
  const model = args.model ?? process.env.AI_VISION_MODEL ?? "qwen3-vl-plus";
  const timeout = Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 30000);

  if (!apiKey) {
    throw new Error("AUTODL_API_KEY is missing. Put it in .env.local before running this script.");
  }

  if (!fs.existsSync(args.dir)) {
    throw new Error(`Input directory does not exist: ${args.dir}`);
  }

  fs.mkdirSync(args.out, { recursive: true });

  const imageFiles = fs
    .readdirSync(args.dir)
    .filter((fileName) => supportedExtensions.has(path.extname(fileName).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .slice(0, args.limit)
    .map((fileName) => path.join(args.dir, fileName));

  if (imageFiles.length === 0) {
    throw new Error(`No supported images found in ${args.dir}`);
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout,
    maxRetries: 0,
  });

  const results = [];
  console.log(`Testing ${imageFiles.length} closet image(s) with model ${model}.`);
  console.log(`Input: ${args.dir}`);
  console.log(`Output: ${args.out}`);

  for (const filePath of imageFiles) {
    const fileName = path.basename(filePath);
    console.log(`Analyzing ${fileName} ...`);

    try {
      const result = await analyzeImage(client, model, filePath);
      results.push({ ok: true, ...result });

      const safeName = fileName.replace(/[^\p{L}\p{N}._-]+/gu, "_");
      fs.writeFileSync(
        path.join(args.out, `${safeName}.json`),
        JSON.stringify(result, null, 2),
        "utf8",
      );

      const parsed = result.parsed;
      console.log(
        `  -> ${parsed.itemName ?? parsed.category ?? "unknown"} | confidence=${parsed.aiConfidence ?? "n/a"} | review=${parsed.needsUserReview ?? "n/a"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ok: false,
        fileName,
        error: message,
        model,
        analyzedAt: new Date().toISOString(),
      });
      console.log(`  -> failed: ${message}`);
    }
  }

  const aggregatePath = path.join(args.out, "summary.json");
  fs.writeFileSync(aggregatePath, JSON.stringify(results, null, 2), "utf8");
  console.log(`Done. Summary saved to ${aggregatePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
