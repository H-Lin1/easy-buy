import assert from "node:assert/strict";
import test from "node:test";

import {
  createImageBlobFromDataUrl,
  createImageEditHeaders,
  createImageEditRequestForConfig,
  createImageEditRequestInit,
  decodeImageEditBase64,
  extractImageEditOutput,
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

test("builds the Tripo multipart edit contract without a manual content type", async () => {
  const request = createImageEditRequestForConfig(
    createImageConfig(),
    `data:image/png;base64,${pngBase64}`,
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

  const image = request.formData.get("image[]");
  assert.ok(image instanceof Blob);
  assert.equal(image.type, "image/png");
  assert.equal(image.name, "closet-input.png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), pngBytes);
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
