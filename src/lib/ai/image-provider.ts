import type { AiCapabilityConfig } from "./capability-config";

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
