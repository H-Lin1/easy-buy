export type AiCapability = "vision" | "decision" | "embedding" | "imageEdit";

export type AiCapabilityConfig = {
  capability: AiCapability;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
  maxTokens?: number;
  dimensions?: number;
};

export type AiProviderConfig = Record<AiCapability, AiCapabilityConfig>;

export type AiCapabilityConfigurationIssue =
  | "unsupported_provider"
  | "missing_api_key"
  | "missing_base_url"
  | "missing_model"
  | "invalid_dimensions";

export const EMBEDDING_DIMENSIONS = 1024;

type EnvSource = Record<string, string | undefined>;

const supportedProviders: Record<AiCapability, readonly string[]> = {
  // Keep provider support explicit so an unknown image protocol cannot be guessed at runtime.
  vision: ["autodl"],
  decision: ["tripo"],
  embedding: ["siliconflow"],
  imageEdit: ["siliconflow", "tripo"],
};

const capabilityLabels: Record<AiCapability, string> = {
  vision: "vision",
  decision: "decision",
  embedding: "embedding",
  imageEdit: "image-edit",
};

export function createAiProviderConfig(env: EnvSource = process.env): AiProviderConfig {
  return {
    vision: createCapabilityConfig(env, {
      capability: "vision",
      prefix: "AI_VISION",
      provider: "autodl",
      baseUrl: "https://www.autodl.art/api/v1",
      model: "qwen3-vl-plus",
      timeoutMs: 30000,
    }),
    decision: createCapabilityConfig(env, {
      capability: "decision",
      prefix: "AI_DECISION2",
      provider: "tripo",
      baseUrl: "https://lumina.tripo3d.com/v1",
      model: "gpt-5.6-terra",
      timeoutMs: 180000,
      maxTokens: 4096,
    }),
    embedding: createCapabilityConfig(env, {
      capability: "embedding",
      prefix: "AI_EMBEDDING",
      provider: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "BAAI/bge-m3",
      timeoutMs: 12000,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
    imageEdit: createCapabilityConfig(env, {
      capability: "imageEdit",
      prefix: "AI_IMAGE_EDIT",
      provider: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "Qwen/Qwen-Image-Edit-2509",
      timeoutMs: 180000,
      providerDefaults: {
        tripo: {
          baseUrl: "https://lumina.tripo3d.com/v1",
          model: "gpt-image-2",
        },
      },
    }),
  };
}

export function getAiCapabilityConfigurationIssue(config: AiCapabilityConfig) {
  if (!isAiProviderSupported(config.capability, config.provider)) {
    return "unsupported_provider" as const;
  }
  if (!config.apiKey) return "missing_api_key" as const;
  if (!config.baseUrl) return "missing_base_url" as const;
  if (!config.model) return "missing_model" as const;
  if (config.capability === "embedding" && config.dimensions !== EMBEDDING_DIMENSIONS) {
    return "invalid_dimensions" as const;
  }
  return undefined;
}

export function isAiCapabilityConfigured(config: AiCapabilityConfig) {
  return !getAiCapabilityConfigurationIssue(config);
}

export function getAiCapabilityHealth(config: AiCapabilityConfig) {
  return {
    provider: config.provider || "unknown",
    model: config.model ?? null,
    configured: isAiCapabilityConfigured(config),
  };
}

export function getAiProviderHealth(config: AiProviderConfig) {
  return {
    vision: getAiCapabilityHealth(config.vision),
    decision: getAiCapabilityHealth(config.decision),
    embedding: getAiCapabilityHealth(config.embedding),
    imageEdit: getAiCapabilityHealth(config.imageEdit),
  };
}

export function getAiCapabilityConfigurationMessage(config: AiCapabilityConfig) {
  const issue = getAiCapabilityConfigurationIssue(config);
  const label = capabilityLabels[config.capability];

  if (issue === "unsupported_provider") {
    return `AI ${label} provider "${config.provider || "unknown"}" is not supported.`;
  }
  if (issue === "missing_api_key") {
    return `AI ${label} capability is not configured: missing API key.`;
  }
  if (issue === "missing_base_url") {
    return `AI ${label} capability is not configured: missing base URL.`;
  }
  if (issue === "missing_model") {
    return `AI ${label} capability is not configured: missing model.`;
  }
  if (issue === "invalid_dimensions") {
    return `AI ${label} capability is not configured: embedding dimensions must be ${EMBEDDING_DIMENSIONS}.`;
  }
  return `AI ${label} capability is not configured.`;
}

export function isAiProviderSupported(capability: AiCapability, provider: string) {
  return supportedProviders[capability].includes(provider.trim().toLowerCase());
}

export function getEmbeddingDimensions(config: AiCapabilityConfig) {
  return config.capability === "embedding" && config.dimensions === EMBEDDING_DIMENSIONS
    ? config.dimensions
    : EMBEDDING_DIMENSIONS;
}

export function getAiApiKeys(config: AiProviderConfig) {
  return Object.values(config)
    .map((capability) => capability.apiKey)
    .filter((apiKey): apiKey is string => Boolean(apiKey));
}

export function sanitizeAiError(error: unknown, secrets: readonly string[] = []) {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "AI provider request failed.";

  if (/(?:api[_ -]?key|authorization|x-api-key|bearer|access[_ -]?token|secret)/i.test(rawMessage)) {
    return "AI provider credential error [redacted].";
  }

  let message = rawMessage;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join("[redacted]");
  }

  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_ -]?key|authorization|x-api-key|token|secret))\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[redacted]")
    .replace(/([?&](?:api[_-]?key|access_token|token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 600);
}

function createCapabilityConfig(
  env: EnvSource,
  defaults: {
    capability: AiCapability;
    prefix: string;
    provider: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    maxTokens?: number;
    dimensions?: number;
    providerDefaults?: Record<string, { baseUrl: string; model: string }>;
  },
): AiCapabilityConfig {
  const provider = (readEnv(env, `${defaults.prefix}_PROVIDER`) ?? defaults.provider).toLowerCase();
  const providerDefaults = defaults.providerDefaults?.[provider];
  const dimensions =
    defaults.dimensions === undefined
      ? undefined
      : readEmbeddingDimensions(env, `${defaults.prefix}_DIMENSIONS`, defaults.dimensions);

  return {
    capability: defaults.capability,
    provider,
    apiKey: readEnv(env, `${defaults.prefix}_API_KEY`),
    baseUrl: readEnv(env, `${defaults.prefix}_BASE_URL`) ?? providerDefaults?.baseUrl ?? defaults.baseUrl,
    model: readEnv(env, `${defaults.prefix}_MODEL`) ?? providerDefaults?.model ?? defaults.model,
    timeoutMs: readPositiveNumber(env, `${defaults.prefix}_TIMEOUT_MS`, defaults.timeoutMs),
    ...(defaults.maxTokens === undefined ? {} : {
      maxTokens: readPositiveNumber(env, `${defaults.prefix}_MAX_TOKENS`, defaults.maxTokens),
    }),
    ...(dimensions === undefined ? {} : { dimensions }),
  };
}

function readEnv(env: EnvSource, name: string) {
  const value = env[name]?.trim();
  return value || undefined;
}

function readPositiveNumber(env: EnvSource, name: string, fallback: number) {
  const value = Number(readEnv(env, name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readEmbeddingDimensions(env: EnvSource, name: string, fallback: number) {
  const rawValue = readEnv(env, name);
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : 0;
}
