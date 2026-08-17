import assert from "node:assert/strict";
import test from "node:test";

import { createTimingTrace } from "../performance/timing.ts";

import {
  createImageBlobFromDataUrl,
  createImageDataUrlFromBytes,
  createImageEditHeaders,
  createImageEditRequestForConfig,
  createImageEditRequestInit,
  decodeImageEditBase64,
  extractImageEditResponseDiagnostics,
  extractImageEditOutput,
  getUtf8ByteLength,
  parseImageEditResponseJson,
  readImageEditResponseBody,
} from "./image-provider.ts";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBase64 = pngBytes.toString("base64");
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const jpegBase64 = jpegBytes.toString("base64");

function createImageConfig(overrides = {}) {
  return {
    capability: "imageEdit",
    provider: "tripo",
    apiKey: "tripo-test-key",
    baseUrl: "https://lumina.example/v1",
    model: "gpt-image-2",
    timeoutMs: 180000,
    ...overrides,
  };
}

test("keeps SiliconFlow image editing on its JSON protocol", () => {
  const request = createImageEditRequestForConfig(
    createImageConfig({
      provider: "siliconflow",
      baseUrl: "https://siliconflow.example/v1/",
      model: "Qwen/Qwen-Image-Edit-2509",
    }),
    `data:image/png;base64,${pngBase64}`,
    "main prompt",
    "negative prompt",
  );

  assert.equal(request.protocol, "json");
  assert.equal(request.endpoint, "https://siliconflow.example/v1/images/generations");
  assert.deepEqual(request.body, {
    model: "Qwen/Qwen-Image-Edit-2509",
    prompt: "main prompt",
    negative_prompt: "negative prompt",
    image: `data:image/png;base64,${pngBase64}`,
  });
  assert.deepEqual(createImageEditHeaders(request), {
    Authorization: "Bearer tripo-test-key",
    "Content-Type": "application/json",
  });
});

test("builds the Tripo native multi-image edit contract in source order", async () => {
  const request = createImageEditRequestForConfig(
    createImageConfig(),
    [
      `data:image/png;base64,${pngBase64}`,
      `data:image/jpeg;base64,${jpegBase64}`,
    ],
    "main prompt",
    "do not add a model",
  );

  assert.equal(request.protocol, "multipart");
  assert.equal(request.endpoint, "https://lumina.example/v1/images/edits");
  assert.deepEqual(createImageEditHeaders(request), {
    Authorization: "Bearer tripo-test-key",
  });
  const requestInit = createImageEditRequestInit(request);
  const multipartRequest = new Request(request.endpoint, requestInit);
  assert.match(multipartRequest.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/i);
  assert.equal(request.formData.get("model"), "gpt-image-2");
  assert.equal(request.formData.has("negative_prompt"), false);

  const prompt = request.formData.get("prompt");
  assert.equal(typeof prompt, "string");
  assert.match(prompt, /main prompt/);
  assert.match(prompt, /do not add a model/);

  const images = request.formData.getAll("image[]");
  assert.equal(images.length, 2);
  assert.ok(images[0] instanceof Blob);
  assert.ok(images[1] instanceof Blob);
  assert.equal(images[0].type, "image/png");
  assert.equal(images[0].name, "input-1.png");
  assert.equal(images[1].type, "image/jpeg");
  assert.equal(images[1].name, "input-2.jpg");
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), pngBytes);
  assert.deepEqual(Buffer.from(await images[1].arrayBuffer()), jpegBytes);
});

test("wraps original image bytes in data URLs without re-encoding them", () => {
  const pngDataUrl = createImageDataUrlFromBytes(pngBytes);
  const jpegDataUrl = createImageDataUrlFromBytes(jpegBytes);

  assert.equal(pngDataUrl, `data:image/png;base64,${pngBase64}`);
  assert.equal(jpegDataUrl, `data:image/jpeg;base64,${jpegBase64}`);
});

test("rejects native multi-image input for the legacy SiliconFlow contract", () => {
  assert.throws(
    () =>
      createImageEditRequestForConfig(
        createImageConfig({ provider: "siliconflow" }),
        [
          `data:image/png;base64,${pngBase64}`,
          `data:image/jpeg;base64,${jpegBase64}`,
        ],
        "prompt",
        "negative",
      ),
    /does not support native multi-image input/i,
  );
});

test("accepts only supported input image data URLs before any provider request", () => {
  assert.throws(
    () => createImageBlobFromDataUrl(`data:text/plain;base64,${pngBase64}`),
    /PNG, JPEG, or WebP data URL/i,
  );

  assert.throws(
    () =>
      createImageEditRequestForConfig(
        createImageConfig(),
        "data:image/png;base64,",
        "prompt",
        "negative",
      ),
    /PNG, JPEG, or WebP data URL|empty/i,
  );
});

test("normalizes URL and Base64 provider outputs without exposing the full response", () => {
  assert.deepEqual(
    extractImageEditOutput({ images: [{ url: "https://cdn.example/image.png" }] }),
    { kind: "url", value: "https://cdn.example/image.png" },
  );
  assert.deepEqual(
    extractImageEditOutput({ data: [{ b64_json: pngBase64 }] }),
    { kind: "base64", value: pngBase64 },
  );
  assert.equal(extractImageEditOutput({ data: [{ message: "upstream detail" }] }), undefined);
});

test("decodes raw and data-URL Base64 outputs for server-side storage", () => {
  const raw = decodeImageEditBase64(pngBase64);
  assert.equal(raw.contentType, "image/png");
  assert.equal(raw.extension, ".png");
  assert.deepEqual(Buffer.from(raw.fileBody), pngBytes);

  const jpeg = decodeImageEditBase64(`data:image/jpeg;base64,${jpegBase64}`);
  assert.equal(jpeg.contentType, "image/jpeg");
  assert.equal(jpeg.extension, ".jpg");
});

test("rejects an unsupported image provider before request construction", () => {
  assert.throws(
    () =>
      createImageEditRequestForConfig(
        createImageConfig({ provider: "unknown-image-provider" }),
        `data:image/png;base64,${pngBase64}`,
        "prompt",
        "negative",
      ),
    /image-edit provider.*unknown-image-provider.*not supported/i,
  );
});

test("extracts only bounded allowlisted image provider response diagnostics", () => {
  const response = new Response(null, {
    status: 202,
    headers: {
      "content-length": "975452",
      "request-id": "request-fallback",
      "server-timing":
        'queue;dur=123.45;desc="private, provider detail", inference;dur=48580.2;other=ignored',
      "x-api-key": "secret-provider-key",
      "x-request-id": "req_abc-123:iad1",
    },
  });

  const diagnostics = extractImageEditResponseDiagnostics(response);

  assert.deepEqual(diagnostics, {
    providerHttpStatus: 202,
    providerRequestId: "req_abc-123:iad1",
    providerServerTiming: "queue;dur=123.45, inference;dur=48580.2",
    providerContentLength: 975452,
  });
  assert.equal(JSON.stringify(diagnostics).includes("private"), false);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
});

test("ignores invalid provider diagnostics and falls back to the next request ID header", () => {
  const fallbackResponse = new Response(null, {
    headers: {
      "content-length": "9007199254740992",
      "request-id": "request-valid",
      "server-timing": 'queue;dur=12, broken;desc="unterminated',
      "x-request-id": "request id with spaces",
      "x-secret-debug": "must-not-appear",
    },
  });

  assert.deepEqual(extractImageEditResponseDiagnostics(fallbackResponse), {
    providerHttpStatus: 200,
    providerRequestId: "request-valid",
  });

  const oversizedResponse = new Response(null, {
    headers: {
      "server-timing": `queue;dur=1,${"a".repeat(2048)}`,
      "x-request-id": `r${"x".repeat(128)}`,
    },
  });

  assert.deepEqual(extractImageEditResponseDiagnostics(oversizedResponse), {
    providerHttpStatus: 200,
  });
});

test("counts decoded provider response text as UTF-8 bytes", () => {
  assert.equal(getUtf8ByteLength('{"label":"衣"}'), 15);
  assert.equal(getUtf8ByteLength("plain-ascii"), 11);
});

test("records separate successful provider body-read and JSON-parse spans", async () => {
  const trace = createTimingTrace({
    operation: "image_provider_response",
    traceId: "11111111-1111-4111-8111-111111111111",
  });
  const bodyResult = await readImageEditResponseBody(
    new Response('{"label":"衣"}'),
    trace,
  );
  const payload = parseImageEditResponseJson(bodyResult.bodyText, trace);

  assert.deepEqual(payload, { label: "衣" });
  assert.equal(bodyResult.responseBytes, 15);
  assert.deepEqual(
    trace.summarize().spans.map(({ name, outcome }) => ({ name, outcome })),
    [
      { name: "provider_response_body_read", outcome: "success" },
      { name: "provider_response_json_parse", outcome: "success" },
    ],
  );
});

test("marks invalid provider JSON as a parse failure without exposing the body", async () => {
  const trace = createTimingTrace({
    operation: "image_provider_invalid_json",
    traceId: "11111111-1111-4111-8111-111111111111",
  });
  const bodyResult = await readImageEditResponseBody(new Response("private invalid JSON"), trace);

  assert.throws(() => parseImageEditResponseJson(bodyResult.bodyText, trace), SyntaxError);
  const summary = trace.summarize("failure");
  assert.deepEqual(summary.spans.map((span) => span.outcome), ["success", "failure"]);
  assert.equal(JSON.stringify(summary).includes("private"), false);
});

test("preserves provider body-read errors and marks the span as failed", async () => {
  const trace = createTimingTrace({
    operation: "image_provider_body_error",
    traceId: "11111111-1111-4111-8111-111111111111",
  });
  const bodyError = new DOMException("provider timeout detail", "AbortError");

  await assert.rejects(
    readImageEditResponseBody(
      {
        text: async () => {
          throw bodyError;
        },
      },
      trace,
    ),
    (error) => error === bodyError,
  );
  const summary = trace.summarize("failure");
  assert.deepEqual(summary.spans.map((span) => span.outcome), ["failure"]);
  assert.equal(JSON.stringify(summary).includes("timeout detail"), false);
});
