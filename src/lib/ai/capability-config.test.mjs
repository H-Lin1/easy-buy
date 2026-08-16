import assert from "node:assert/strict";
import test from "node:test";

import {
  createAiProviderConfig,
  getAiCapabilityConfigurationIssue,
  getAiCapabilityConfigurationMessage,
  getEmbeddingDimensions,
  getAiProviderHealth,
  isAiCapabilityConfigured,
  sanitizeAiError,
} from "./capability-config.ts";
import { createDeterministicEmbedding } from "./embedding-utils.ts";
import { createImageEditRequestForConfig } from "./image-provider.ts";

function createSource(overrides = {}) {
  return {
    AI_VISION_API_KEY: "vision-key",
    AI_VISION_BASE_URL: "https://vision.example/v1",
    AI_VISION_MODEL: "vision-model",
    AI_VISION_TIMEOUT_MS: "31000",
    AI_DECISION2_API_KEY: "decision-key",
    AI_DECISION2_BASE_URL: "https://decision.example/v1",
    AI_DECISION2_MODEL: "decision-model",
    AI_DECISION2_TIMEOUT_MS: "181000",
    AI_DECISION2_MAX_TOKENS: "4097",
    AI_EMBEDDING_API_KEY: "embedding-key",
    AI_EMBEDDING_BASE_URL: "https://embedding.example/v1",
    AI_EMBEDDING_MODEL: "embedding-model",
    AI_EMBEDDING_TIMEOUT_MS: "13000",
    AI_EMBEDDING_DIMENSIONS: "1024",
    AI_IMAGE_EDIT_API_KEY: "image-edit-key",
    AI_IMAGE_EDIT_BASE_URL: "https://image-edit.example/v1",
    AI_IMAGE_EDIT_MODEL: "image-edit-model",
    AI_IMAGE_EDIT_TIMEOUT_MS: "181000",
    ...overrides,
  };
}

test("reads provider credentials and runtime settings independently for each capability", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_VISION_PROVIDER: " AutoDL ",
      AI_DECISION2_PROVIDER: "tripo",
      AI_EMBEDDING_PROVIDER: "siliconflow",
      AI_IMAGE_EDIT_PROVIDER: "siliconflow",
    }),
  );

  assert.deepEqual(config.vision, {
    capability: "vision",
    provider: "autodl",
    apiKey: "vision-key",
    baseUrl: "https://vision.example/v1",
    model: "vision-model",
    timeoutMs: 31000,
  });
  assert.deepEqual(config.decision, {
    capability: "decision",
    provider: "tripo",
    apiKey: "decision-key",
    baseUrl: "https://decision.example/v1",
    model: "decision-model",
    timeoutMs: 181000,
    maxTokens: 4097,
  });
  assert.deepEqual(config.embedding, {
    capability: "embedding",
    provider: "siliconflow",
    apiKey: "embedding-key",
    baseUrl: "https://embedding.example/v1",
    model: "embedding-model",
    timeoutMs: 13000,
    dimensions: 1024,
  });
  assert.deepEqual(config.imageEdit, {
    capability: "imageEdit",
    provider: "siliconflow",
    apiKey: "image-edit-key",
    baseUrl: "https://image-edit.example/v1",
    model: "image-edit-model",
    timeoutMs: 181000,
  });
});

test("never borrows a key between vision and decision capabilities", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_VISION_API_KEY: "vision-only-key",
      AI_DECISION2_API_KEY: "decision-only-key",
    }),
  );

  assert.equal(config.vision.apiKey, "vision-only-key");
  assert.equal(config.decision.apiKey, "decision-only-key");
  assert.notEqual(config.vision.apiKey, config.decision.apiKey);

  const missingDecision = createAiProviderConfig(
    createSource({
      AI_DECISION2_API_KEY: undefined,
    }),
  );
  assert.equal(missingDecision.decision.apiKey, undefined);
  assert.equal(isAiCapabilityConfigured(missingDecision.decision), false);
  assert.equal(isAiCapabilityConfigured(missingDecision.vision), true);
});

test("ignores legacy shared variables", () => {
  const config = createAiProviderConfig({
    AUTODL_API_KEY: "legacy-autodl-key",
    AUTODL_OPENAI_BASE_URL: "https://legacy-autodl.example/v1",
    SILICONFLOW_API_KEY: "legacy-siliconflow-key",
    SILICONFLOW_BASE_URL: "https://legacy-siliconflow.example/v1",
  });

  assert.equal(config.vision.apiKey, undefined);
  assert.equal(config.decision.apiKey, undefined);
  assert.equal(config.embedding.apiKey, undefined);
  assert.equal(config.imageEdit.apiKey, undefined);
  assert.equal(config.vision.baseUrl, "https://www.autodl.art/api/v1");
  assert.equal(config.decision.baseUrl, "https://lumina.tripo3d.com/v1");
  assert.equal(config.embedding.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(config.imageEdit.baseUrl, "https://api.siliconflow.cn/v1");
  assert.equal(isAiCapabilityConfigured(config.vision), false);
  assert.equal(isAiCapabilityConfigured(config.embedding), false);
});

test("prefers new capability variables when legacy and new variables coexist", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_VISION_API_KEY: "new-vision-key",
      AI_VISION_BASE_URL: "https://new-vision.example/v1",
      AUTODL_API_KEY: "legacy-autodl-key",
      AUTODL_OPENAI_BASE_URL: "https://legacy-autodl.example/v1",
      SILICONFLOW_API_KEY: "legacy-siliconflow-key",
      SILICONFLOW_BASE_URL: "https://legacy-siliconflow.example/v1",
    }),
  );

  assert.equal(config.vision.apiKey, "new-vision-key");
  assert.equal(config.vision.baseUrl, "https://new-vision.example/v1");
  assert.equal(config.decision.apiKey, "decision-key");
  assert.equal(config.embedding.apiKey, "embedding-key");
  assert.equal(config.imageEdit.apiKey, "image-edit-key");
});

test("marks an unsupported provider as a capability configuration issue", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_VISION_PROVIDER: "unknown-provider",
    }),
  );

  assert.equal(getAiCapabilityConfigurationIssue(config.vision), "unsupported_provider");
  assert.match(getAiCapabilityConfigurationMessage(config.vision), /vision.*unknown-provider/i);
  assert.equal(isAiCapabilityConfigured(config.vision), false);
});

test("supports Tripo as an independently configured image-edit provider", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_IMAGE_EDIT_PROVIDER: "tripo",
      AI_IMAGE_EDIT_API_KEY: "tripo-key",
      AI_IMAGE_EDIT_BASE_URL: "https://lumina.example/v1",
      AI_IMAGE_EDIT_MODEL: "gpt-image-2",
    }),
  );

  assert.equal(config.imageEdit.provider, "tripo");
  assert.equal(config.imageEdit.apiKey, "tripo-key");
  assert.equal(config.imageEdit.baseUrl, "https://lumina.example/v1");
  assert.equal(config.imageEdit.model, "gpt-image-2");
  assert.equal(isAiCapabilityConfigured(config.imageEdit), true);
});

test("does not inherit SiliconFlow endpoint or model when selecting Tripo", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_IMAGE_EDIT_PROVIDER: "tripo",
      AI_IMAGE_EDIT_API_KEY: "tripo-key",
      AI_IMAGE_EDIT_BASE_URL: undefined,
      AI_IMAGE_EDIT_MODEL: undefined,
    }),
  );

  assert.equal(config.imageEdit.baseUrl, "https://lumina.tripo3d.com/v1");
  assert.equal(config.imageEdit.model, "gpt-image-2");
  assert.equal(config.imageEdit.baseUrl.includes("siliconflow"), false);
  assert.equal(config.imageEdit.model.includes("Qwen"), false);
});

test("reports only safe metadata in the provider health object", () => {
  const config = createAiProviderConfig(createSource());
  const health = getAiProviderHealth(config);

  assert.deepEqual(Object.keys(health), ["vision", "decision", "embedding", "imageEdit"]);
  for (const capability of Object.values(health)) {
    assert.deepEqual(Object.keys(capability).sort(), ["configured", "model", "provider"]);
    assert.equal("apiKey" in capability, false);
    assert.equal("baseUrl" in capability, false);
  }

  assert.equal(JSON.stringify(health).includes("vision-key"), false);
  assert.equal(JSON.stringify(health).includes("example"), false);
});

test("normalizes embedding dimensions to the database contract", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_EMBEDDING_DIMENSIONS: "768",
    }),
  );

  assert.equal(getEmbeddingDimensions(config.embedding), 1024);
  assert.equal(getAiCapabilityConfigurationIssue(config.embedding), "invalid_dimensions");
});

test("keeps the embedding fallback deterministic and database-compatible", () => {
  const first = createDeterministicEmbedding("same text", 1024);
  const second = createDeterministicEmbedding("same text", 1024);

  assert.equal(first.length, 1024);
  assert.deepEqual(first, second);
});

test("builds image requests from image-edit configuration only", () => {
  const config = createAiProviderConfig(createSource());
  const request = createImageEditRequestForConfig(
    config.imageEdit,
    "data:image/png;base64,image",
    "prompt",
    "negative",
  );

  assert.equal(request.protocol, "json");
  assert.equal(request.apiKey, "image-edit-key");
  assert.equal(request.model, "image-edit-model");
  assert.equal(request.endpoint, "https://image-edit.example/v1/images/generations");
  assert.equal(JSON.stringify(request).includes("embedding-key"), false);
});

test("rejects unsupported image providers before a request can be built", () => {
  const config = createAiProviderConfig(
    createSource({
      AI_IMAGE_EDIT_PROVIDER: "unknown-image-provider",
    }),
  );

  assert.throws(
    () =>
      createImageEditRequestForConfig(
        config.imageEdit,
        "data:image/png;base64,image",
        "prompt",
        "negative",
      ),
    /image-edit.*unknown-image-provider.*not supported/i,
  );
});

test("sanitizes bearer tokens and API keys from provider errors", () => {
  const message = sanitizeAiError(
    new Error(
      "provider rejected credential sk-live-abcdefghijkl; Bearer sk-live-secret authorization=top-secret",
    ),
    ["sk-live-secret", "top-secret", "another-secret"],
  );

  assert.equal(message.includes("sk-live-secret"), false);
  assert.equal(message.includes("sk-live"), false);
  assert.equal(message.includes("cret"), false);
  assert.equal(message.includes("top-secret"), false);
  assert.equal(message.includes("another-secret"), false);
  assert.match(message, /redacted/i);
});
