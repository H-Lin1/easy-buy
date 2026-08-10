import type { AiCapabilityConfig } from "./capability-config";
import type { TimingTrace } from "../performance/timing";

type ImageEditJsonBody = {
  model: string;
  prompt: string;
  negative_prompt: string;
  image: string;
};

type ImageEditJsonRequest = {
  protocol: "json";
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  body: ImageEditJsonBody;
};

type ImageEditMultipartRequest = {
  protocol: "multipart";
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  formData: FormData;
};

export type ImageEditRequest = ImageEditJsonRequest | ImageEditMultipartRequest;

export type ImageEditOutput =
  | { kind: "url"; value: string }
  | { kind: "base64"; value: string };

export type ImageEditResponseDiagnostics = {
  providerHttpStatus: number;
  providerRequestId?: string;
  providerServerTiming?: string;
  providerContentLength?: number;
};

const providerRequestIdHeaderNames = ["x-request-id", "request-id", "x-trace-id"] as const;
const providerRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const providerServerTimingNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const providerServerTimingDurationPattern = /^dur\s*=\s*(\d+(?:\.\d+)?)$/i;
const maxProviderServerTimingInputLength = 2048;
const maxProviderServerTimingOutputLength = 1024;
const maxProviderServerTimingMetrics = 16;

export function extractImageEditResponseDiagnostics(
  response: Pick<Response, "headers" | "status">,
): ImageEditResponseDiagnostics {
  const providerRequestId = providerRequestIdHeaderNames
    .map((name) => sanitizeProviderRequestId(response.headers.get(name)))
    .find((value) => value !== undefined);
  const providerServerTiming = sanitizeProviderServerTiming(
    response.headers.get("server-timing"),
  );
  const providerContentLength = parseProviderContentLength(
    response.headers.get("content-length"),
  );

  return {
    providerHttpStatus: response.status,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerServerTiming ? { providerServerTiming } : {}),
    ...(providerContentLength !== undefined ? { providerContentLength } : {}),
  };
}

export function getUtf8ByteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export async function readImageEditResponseBody(
  response: Pick<Response, "text">,
  trace: Pick<TimingTrace, "measure">,
) {
  return trace.measure("provider_response_body_read", async () => {
    const bodyText = await response.text();
    return {
      bodyText,
      responseBytes: getUtf8ByteLength(bodyText),
    };
  });
}

export function parseImageEditResponseJson(
  bodyText: string,
  trace: Pick<TimingTrace, "measureSync">,
): unknown {
  return trace.measureSync("provider_response_json_parse", () => JSON.parse(bodyText));
}

export function createImageEditRequestForConfig(
  config: AiCapabilityConfig,
  imageDataUrl: string,
  prompt: string,
  negativePrompt: string,
): ImageEditRequest {
  if (config.capability !== "imageEdit") {
    throw new Error(`AI ${config.capability} cannot create an image-edit request.`);
  }

  const provider = config.provider.trim().toLowerCase();
  if (provider !== "siliconflow" && provider !== "tripo") {
    throw new Error(`AI image-edit provider "${config.provider}" is not supported.`);
  }

  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;
  const model = config.model;

  if (!apiKey || !baseUrl || !model) {
    throw new Error("AI image-edit capability is not configured.");
  }

  if (provider === "siliconflow") {
    return {
      protocol: "json",
      endpoint: `${baseUrl.replace(/\/$/, "")}/images/generations`,
      apiKey,
      model,
      timeoutMs: config.timeoutMs,
      body: {
        model,
        prompt,
        negative_prompt: negativePrompt,
        image: imageDataUrl,
      },
    };
  }

  const inputImage = createImageBlobFromDataUrl(imageDataUrl);
  const formData = new FormData();
  formData.append("model", model);
  formData.append("prompt", appendNegativeConstraints(prompt, negativePrompt));
  formData.append("image[]", inputImage.blob, `closet-input${inputImage.extension}`);

  return {
    protocol: "multipart",
    endpoint: `${baseUrl.replace(/\/$/, "")}/images/edits`,
    apiKey,
    model,
    timeoutMs: config.timeoutMs,
    formData,
  };
}

export function createImageEditHeaders(request: ImageEditRequest) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${request.apiKey}`,
  };

  if (request.protocol === "json") {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

export function createImageEditRequestInit(request: ImageEditRequest): RequestInit {
  return {
    method: "POST",
    headers: createImageEditHeaders(request),
    body: request.protocol === "json" ? JSON.stringify(request.body) : request.formData,
  };
}

export function extractImageEditOutput(payload: unknown): ImageEditOutput | undefined {
  if (!isRecord(payload)) return undefined;

  for (const field of ["images", "data"] as const) {
    const entries = payload[field];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!isRecord(entry)) continue;

      if (typeof entry.url === "string" && entry.url.trim()) {
        return { kind: "url", value: entry.url.trim() };
      }

      if (typeof entry.b64_json === "string" && entry.b64_json.trim()) {
        return { kind: "base64", value: entry.b64_json.trim() };
      }
    }
  }

  return undefined;
}

export function createImageBlobFromDataUrl(imageDataUrl: string) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
    imageDataUrl.trim(),
  );

  if (!match) {
    throw new Error("AI image-edit input must be a PNG, JPEG, or WebP data URL.");
  }

  const bytes = Buffer.from(match[2], "base64");
  const contentType = getImageContentType(bytes);
  if (!contentType) {
    throw new Error("AI image-edit input data URL does not contain a supported image.");
  }
  if (normalizeImageContentType(match[1]) !== contentType) {
    throw new Error("AI image-edit input data URL content type does not match its image bytes.");
  }

  return {
    blob: new Blob([bytes], { type: contentType }),
    contentType,
    extension: extensionFromContentType(contentType),
  };
}

export function decodeImageEditBase64(value: string) {
  const trimmedValue = value.trim();
  const dataUrlMatch = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([\s\S]+)$/i.exec(trimmedValue);
  const declaredContentType = dataUrlMatch ? normalizeImageContentType(dataUrlMatch[1]) : undefined;
  const base64 = (dataUrlMatch ? dataUrlMatch[2] : trimmedValue).replace(/\s/g, "");

  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("AI image-edit provider returned an invalid Base64 image.");
  }

  const fileBody = Buffer.from(base64, "base64");
  const contentType = getImageContentType(fileBody);
  if (!contentType) {
    throw new Error("AI image-edit provider returned invalid image bytes.");
  }
  if (declaredContentType && declaredContentType !== contentType) {
    throw new Error("AI image-edit provider returned mismatched image content type.");
  }

  return {
    fileBody,
    contentType,
    extension: extensionFromContentType(contentType),
  };
}

function appendNegativeConstraints(prompt: string, negativePrompt: string) {
  const normalizedPrompt = prompt.trim();
  const normalizedNegativePrompt = negativePrompt.trim();

  if (!normalizedNegativePrompt) return normalizedPrompt;

  return `${normalizedPrompt}\n\nAdditional negative constraints (must not appear):\n${normalizedNegativePrompt}`;
}

function sanitizeProviderRequestId(value: string | null) {
  const normalized = value?.trim();
  return normalized && providerRequestIdPattern.test(normalized) ? normalized : undefined;
}

function sanitizeProviderServerTiming(value: string | null) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maxProviderServerTimingInputLength) return undefined;

  const entries = splitHeaderValue(normalized, ",");
  if (!entries) return undefined;

  const metrics: string[] = [];
  let outputLength = 0;

  for (const entry of entries) {
    if (metrics.length >= maxProviderServerTimingMetrics) break;

    const segments = splitHeaderValue(entry, ";");
    if (!segments) continue;
    const name = segments[0]?.trim();
    if (!name || !providerServerTimingNamePattern.test(name)) continue;

    const duration = segments
      .slice(1)
      .map((segment) => providerServerTimingDurationPattern.exec(segment.trim())?.[1])
      .find((candidate) => candidate !== undefined);
    if (!duration || duration.length > 32) continue;

    const durationMs = Number(duration);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;

    const metric = `${name};dur=${durationMs}`;
    const addedLength = metric.length + (metrics.length > 0 ? 2 : 0);
    if (outputLength + addedLength > maxProviderServerTimingOutputLength) break;

    metrics.push(metric);
    outputLength += addedLength;
  }

  return metrics.length > 0 ? metrics.join(", ") : undefined;
}

function parseProviderContentLength(value: string | null) {
  const normalized = value?.trim();
  if (!normalized || !/^\d{1,20}$/.test(normalized)) return undefined;

  const contentLength = Number(normalized);
  return Number.isSafeInteger(contentLength) ? contentLength : undefined;
}

function splitHeaderValue(value: string, delimiter: "," | ";") {
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      segments.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quoted || escaped) return undefined;
  segments.push(value.slice(start));
  return segments;
}

function normalizeImageContentType(contentType: string) {
  return contentType.toLowerCase() === "image/jpg" ? "image/jpeg" : contentType.toLowerCase();
}

function extensionFromContentType(contentType: string) {
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  return ".png";
}

function getImageContentType(bytes: Buffer) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    bytes.subarray(8, 12).equals(Buffer.from("WEBP"))
  ) {
    return "image/webp";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
