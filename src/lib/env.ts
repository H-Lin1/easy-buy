import "server-only";

import { createAiProviderConfig } from "@/lib/ai/capability-config";

export {
  EMBEDDING_DIMENSIONS,
  getAiApiKeys,
  getAiCapabilityConfigurationIssue,
  getAiCapabilityConfigurationMessage,
  getAiCapabilityHealth,
  getAiProviderHealth,
  getEmbeddingDimensions,
  isAiCapabilityConfigured,
  isAiProviderSupported,
  sanitizeAiError,
  type AiCapability,
  type AiCapabilityConfig,
  type AiCapabilityConfigurationIssue,
  type AiProviderConfig,
} from "@/lib/ai/capability-config";

type AppEnvSource = Record<string, string | undefined>;

export function getRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function createAppEnv(env: AppEnvSource = process.env) {
  return {
    supabaseUrl: readEnv(env, "NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: readEnv(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: readEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    databaseUrl: readEnv(env, "DATABASE_URL") ?? readEnv(env, "DATABASE_URL3"),
    ai: createAiProviderConfig(env),
  };
}

export const appEnv = createAppEnv();

function readEnv(env: AppEnvSource, name: string) {
  const value = env[name]?.trim();
  return value || undefined;
}
