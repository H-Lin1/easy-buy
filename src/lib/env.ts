export function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const appEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  databaseUrl: process.env.DATABASE_URL ?? process.env.DATABASE_URL3,
  autoDlApiKey: process.env.AUTODL_API_KEY,
  autoDlBaseUrl: process.env.AUTODL_OPENAI_BASE_URL ?? "https://www.autodl.art/api/v1",
  visionModel: process.env.AI_VISION_MODEL ?? "qwen3-vl-plus",
  decisionModel: process.env.AI_DECISION_MODEL ?? "qwen3.6-plus",
  aiProviderTimeoutMs: Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 12000),
  aiDecisionTimeoutMs: Number(process.env.AI_DECISION_TIMEOUT_MS ?? 180000),
  aiVisionTimeoutMs: Number(process.env.AI_VISION_TIMEOUT_MS ?? 30000),
  aiForceJsonMode: process.env.AI_FORCE_JSON_MODE === "true",
  siliconFlowApiKey: process.env.SILICONFLOW_API_KEY,
  siliconFlowBaseUrl: process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1",
  imageEditModel: process.env.AI_IMAGE_EDIT_MODEL ?? "Qwen/Qwen-Image-Edit-2509",
  siliconFlowImageTimeoutMs: Number(process.env.SILICONFLOW_IMAGE_TIMEOUT_MS ?? 180000),
  embeddingModel: process.env.AI_EMBEDDING_MODEL ?? "BAAI/bge-m3",
  embeddingDimensions: Number(process.env.AI_EMBEDDING_DIMENSIONS ?? 1024),
  rerankModel: process.env.AI_RERANK_MODEL ?? "BAAI/bge-reranker-v2-m3",
  enableRerank: process.env.ENABLE_RERANK === "true",
};
