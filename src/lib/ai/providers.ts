import "server-only";

import OpenAI from "openai";

import { appEnv } from "@/lib/env";

export function hasAutoDlConfig() {
  return Boolean(appEnv.autoDlApiKey);
}

export function hasSiliconFlowConfig() {
  return Boolean(appEnv.siliconFlowApiKey);
}

function createAutoDlClient(timeout = appEnv.aiProviderTimeoutMs) {
  if (!appEnv.autoDlApiKey) {
    throw new Error("AUTODL_API_KEY is not configured.");
  }

  return new OpenAI({
    apiKey: appEnv.autoDlApiKey,
    baseURL: appEnv.autoDlBaseUrl,
    maxRetries: 0,
    timeout,
  });
}

function createSiliconFlowClient() {
  if (!appEnv.siliconFlowApiKey) {
    throw new Error("SILICONFLOW_API_KEY is not configured.");
  }

  return new OpenAI({
    apiKey: appEnv.siliconFlowApiKey,
    baseURL: appEnv.siliconFlowBaseUrl,
    maxRetries: 0,
    timeout: appEnv.aiProviderTimeoutMs,
  });
}

export async function generateDecisionJson(prompt: string) {
  const client = createAutoDlClient(appEnv.aiDecisionTimeoutMs);

  const completion = await client.chat.completions.create({
    model: appEnv.decisionModel,
    messages: [
      {
        role: "system",
        content:
          "你是一个衣服购买决策助手，只输出严格 JSON，不要输出 Markdown。不要展开推理过程，直接给出结论和结构化理由。表达要温和，不做身材羞辱或绝对审美判断。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: appEnv.aiDecisionMaxTokens,
    response_format: { type: "json_object" as const },
  });

  return completion.choices[0]?.message.content ?? "{}";
}

export async function generateVisionJson(prompt: string, imageDataUrls: string[]) {
  const client = createAutoDlClient(appEnv.aiVisionTimeoutMs);
  const content = [
    {
      type: "text" as const,
      text: prompt,
    },
    ...imageDataUrls.map((url) => ({
      type: "image_url" as const,
      image_url: {
        url,
      },
    })),
  ];

  const completion = await client.chat.completions.create({
    model: appEnv.visionModel,
    messages: [
      {
        role: "system",
        content:
          "你是衣橱图片识别助手。你只输出严格 JSON，帮助用户把真实衣服照片转成可确认的衣橱标签。你不重绘衣服，不猜测品牌、价格、用户身份或用户身材。",
      },
      {
        role: "user",
        content,
      },
    ],
    temperature: 0.1,
  });

  return completion.choices[0]?.message.content ?? "{}";
}

export async function embedText(text: string) {
  if (!hasSiliconFlowConfig()) {
    return createDeterministicEmbedding(text, appEnv.embeddingDimensions);
  }

  try {
    const client = createSiliconFlowClient();
    const result = await client.embeddings.create({
      model: appEnv.embeddingModel,
      input: text,
    });

    const embedding = result.data[0]?.embedding;
    if (!embedding?.length) {
      return createDeterministicEmbedding(text, appEnv.embeddingDimensions);
    }

    return normalizeEmbedding(embedding, appEnv.embeddingDimensions);
  } catch (error) {
    console.warn("[ai-provider] embedding fallback used", {
      message: error instanceof Error ? error.message : "Embedding request failed.",
    });
    return createDeterministicEmbedding(text, appEnv.embeddingDimensions);
  }
}

function createDeterministicEmbedding(text: string, dimensions: number) {
  const values = new Array<number>(dimensions).fill(0);

  for (let index = 0; index < text.length; index += 1) {
    const bucket = index % dimensions;
    values[bucket] += (text.charCodeAt(index) % 97) / 97;
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export function normalizeEmbedding(embedding: number[], dimensions = appEnv.embeddingDimensions) {
  if (embedding.length === dimensions) return embedding;
  if (embedding.length > dimensions) return embedding.slice(0, dimensions);

  return [...embedding, ...new Array<number>(dimensions - embedding.length).fill(0)];
}

export function toPgVector(embedding: number[]) {
  return `[${embedding.map((value) => Number(value.toFixed(8))).join(",")}]`;
}
