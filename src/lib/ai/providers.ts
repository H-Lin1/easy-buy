import "server-only";

import OpenAI from "openai";

import {
  getAiApiKeys,
  getAiCapabilityConfigurationMessage,
  getAiCapabilityConfigurationIssue,
  getEmbeddingDimensions,
  isAiCapabilityConfigured,
  isAiProviderSupported,
  sanitizeAiError,
  type AiCapability,
  type AiCapabilityConfig,
} from "@/lib/ai/capability-config";
import {
  createDeterministicEmbedding,
  formatPgVector,
  normalizeEmbeddingToDimensions,
} from "@/lib/ai/embedding-utils";
import { createImageEditRequestForConfig } from "@/lib/ai/image-provider";
import { appEnv } from "@/lib/env";

export function hasVisionConfig() {
  return isAiCapabilityConfigured(appEnv.ai.vision);
}

export function hasDecisionConfig() {
  return isAiCapabilityConfigured(appEnv.ai.decision);
}

export function hasEmbeddingConfig() {
  return isAiCapabilityConfigured(appEnv.ai.embedding);
}

export function hasImageEditConfig() {
  return isAiCapabilityConfigured(appEnv.ai.imageEdit);
}

export function getAiCapabilityConfig(capability: AiCapability) {
  return appEnv.ai[capability];
}

export function getAiCapabilityConfigError(capability: AiCapability) {
  return getAiCapabilityConfigurationMessage(getAiCapabilityConfig(capability));
}

export async function generateDecisionJson(prompt: string) {
  const config = getAiCapabilityConfig("decision");
  const client = createOpenAiCompatibleClient(config);

  const completion = await client.chat.completions.create({
    model: requireModel(config),
    messages: [
      {
        role: "system",
        content:
          "你是一个衣服购买决策助手，只输出严格 JSON，不要输出 Markdown。不要展开推理过程，直接给出结论和结构化理由。表达要温和，不做身材羞辱或绝对审美判断。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: config.maxTokens,
    response_format: { type: "json_object" as const },
  });

  return completion.choices[0]?.message.content ?? "{}";
}

export async function generateVisionJson(prompt: string, imageDataUrls: string[]) {
  const config = getAiCapabilityConfig("vision");
  const client = createOpenAiCompatibleClient(config);
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
    model: requireModel(config),
    messages: [
      {
        role: "system",
        content:
          "你是服装图片和商品截图识别助手。你只输出严格 JSON，帮助用户把真实衣服照片或待买商品截图转成可确认的服装标签。你不重绘衣服，不猜测品牌、价格、用户身份或用户身材；价格只能来自图片文字或用户补充。",
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
  const config = getAiCapabilityConfig("embedding");
  const dimensions = getEmbeddingDimensions(config);
  const configurationIssue = getAiCapabilityConfigurationIssue(config);

  if (configurationIssue === "unsupported_provider") {
    throw new Error(getAiCapabilityConfigurationMessage(config));
  }

  if (configurationIssue) {
    return createDeterministicEmbedding(text, dimensions);
  }

  try {
    const client = createOpenAiCompatibleClient(config);
    const result = await client.embeddings.create({
      model: requireModel(config),
      input: text,
    });

    const embedding = result.data[0]?.embedding;
    if (!embedding?.length) {
      return createDeterministicEmbedding(text, dimensions);
    }

    return normalizeEmbedding(embedding, dimensions);
  } catch (error) {
    console.warn("[ai-provider] embedding fallback used", {
      capability: config.capability,
      provider: config.provider,
      message: sanitizeAiErrorMessage(error),
    });
    return createDeterministicEmbedding(text, dimensions);
  }
}

export function createImageEditRequest(imageDataUrl: string, prompt: string, negativePrompt: string) {
  return createImageEditRequestForConfig(
    getAiCapabilityConfig("imageEdit"),
    imageDataUrl,
    prompt,
    negativePrompt,
  );
}

export function sanitizeAiErrorMessage(error: unknown) {
  return sanitizeAiError(error, getAiApiKeys(appEnv.ai));
}

function createOpenAiCompatibleClient(config: AiCapabilityConfig) {
  if (!isAiCapabilityConfigured(config)) {
    throw new Error(getAiCapabilityConfigurationMessage(config));
  }

  if (!isAiProviderSupported(config.capability, config.provider)) {
    throw new Error(`AI ${config.capability} provider \"${config.provider}\" is not supported.`);
  }

  return new OpenAI({
    apiKey: requireApiKey(config),
    baseURL: requireBaseUrl(config),
    maxRetries: 0,
    timeout: config.timeoutMs,
  });
}

function requireApiKey(config: AiCapabilityConfig) {
  if (!config.apiKey) throw new Error(getAiCapabilityConfigurationMessage(config));
  return config.apiKey;
}

function requireBaseUrl(config: AiCapabilityConfig) {
  if (!config.baseUrl) throw new Error(getAiCapabilityConfigurationMessage(config));
  return config.baseUrl;
}

function requireModel(config: AiCapabilityConfig) {
  if (!config.model) throw new Error(getAiCapabilityConfigurationMessage(config));
  return config.model;
}

export function normalizeEmbedding(
  embedding: number[],
  dimensions = getEmbeddingDimensions(appEnv.ai.embedding),
) {
  return normalizeEmbeddingToDimensions(embedding, dimensions);
}

export function toPgVector(embedding: number[]) {
  return formatPgVector(embedding);
}
