import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  CLOSET_DISPLAY_PROMPT_VERSION,
  buildClosetDisplayNegativePrompt,
  buildClosetDisplayPrompt,
} from "@/lib/ai/image-edit-prompt";
import {
  decodeImageEditBase64,
  extractImageEditResponseDiagnostics,
  extractImageEditOutput,
  createImageEditRequestInit,
  parseImageEditResponseJson,
  readImageEditResponseBody,
  type ImageEditOutput,
} from "@/lib/ai/image-provider";
import {
  createImageEditRequest,
  getAiCapabilityConfig,
  getAiCapabilityConfigError,
  hasImageEditConfig,
} from "@/lib/ai/providers";
import { appEnv } from "@/lib/env";
import { createRouteTiming } from "@/lib/performance/route-timing";
import type { TimingTrace } from "@/lib/performance/timing";

export const runtime = "nodejs";

const requestSchema = z.object({
  closetItemId: z.string().uuid(),
  imagePath: z.string().min(1),
  imageDataUrl: z.string().startsWith("data:image/"),
});

type ClosetQualityRow = {
  image_quality_flags: string[] | null;
};

const closetItemSelect =
  "id,image_path,processed_image_path,display_image_path,display_image_status,display_image_model,display_image_prompt_version,image_quality_flags,category,color,fit,style_tags,season,scenario_tags,wear_frequency,status,summary,embedding_text,ai_confidence,user_corrected";

export async function POST(request: NextRequest) {
  const timing = createRouteTiming(request, {
    operation: "closet_display_image_route",
    route: "generate_closet_display_image",
  });

  try {
    return await handlePost(request, timing);
  } catch (error) {
    console.error("[closet-display-image] route failed", {
      failure: describeDisplayImageFailure(error),
    });

    return timing.json(
      { message: "Display image generation failed." },
      { status: 500, metadata: { failureKind: "unexpected_route_failure" } },
    );
  }
}

async function handlePost(
  request: NextRequest,
  timing: ReturnType<typeof createRouteTiming>,
) {
  const { trace } = timing;
  const authHeader = trace.measureSync(
    "request_headers",
    () => request.headers.get("authorization"),
    (value) => (value?.startsWith("Bearer ") ? "success" : "failure"),
  );

  if (!authHeader?.startsWith("Bearer ")) {
    return timing.json(
      { message: "Missing auth token." },
      { status: 401, metadata: { failureKind: "missing_auth" } },
    );
  }

  if (!appEnv.supabaseUrl || !appEnv.supabaseAnonKey) {
    return timing.json(
      { message: "Supabase is not configured." },
      { status: 500, metadata: { failureKind: "supabase_not_configured" } },
    );
  }

  if (!hasImageEditConfig()) {
    return timing.json(
      { message: getAiCapabilityConfigError("imageEdit") },
      { status: 500, metadata: { failureKind: "image_edit_not_configured" } },
    );
  }

  const imageEditConfig = getAiCapabilityConfig("imageEdit");
  const imageEditModel = imageEditConfig.model;
  if (!imageEditModel) {
    return timing.json(
      { message: getAiCapabilityConfigError("imageEdit") },
      { status: 500, metadata: { failureKind: "image_edit_model_missing" } },
    );
  }
  timing.addMetadata({ provider: imageEditConfig.provider, model: imageEditModel });

  const body = await trace.measure("request_body_json", () => request.json()).catch(() => null);
  const parsed = trace.measureSync(
    "request_validate",
    () => requestSchema.safeParse(body),
    (result) => (result.success ? "success" : "failure"),
  );

  if (!parsed.success) {
    return timing.json(
      { message: "Invalid display image request.", issues: parsed.error.issues },
      { status: 400, metadata: { failureKind: "invalid_request" } },
    );
  }

  const supabase = createClient(appEnv.supabaseUrl, appEnv.supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userError } = await trace.measure(
    "auth_get_user",
    () => supabase.auth.getUser(token),
    (result) => (result.error || !result.data.user ? "failure" : "success"),
  );

  if (userError || !userData.user) {
    return timing.json(
      { message: "Invalid auth token." },
      { status: 401, metadata: { failureKind: "invalid_auth" } },
    );
  }

  const { closetItemId, imagePath, imageDataUrl } = parsed.data;
  const userId = userData.user.id;
  timing.addMetadata({ inputChars: imageDataUrl.length });

  const { data: closetItem, error: closetError } = await trace.measure(
    "db_item_lookup",
    () =>
      supabase
        .from("closet_items")
        .select("id,image_path")
        .eq("id", closetItemId)
        .single(),
    (result) => (result.error || !result.data ? "failure" : "success"),
  );

  if (closetError || !closetItem || closetItem.image_path !== imagePath) {
    return timing.json(
      { message: "Closet item not found." },
      { status: 404, metadata: { failureKind: "item_not_found" } },
    );
  }

  try {
    const { error: processingError } = await trace.measure(
      "db_mark_processing",
      () =>
        supabase
          .from("closet_items")
          .update({
            display_image_status: "processing",
            display_image_model: imageEditModel,
            display_image_prompt_version: CLOSET_DISPLAY_PROMPT_VERSION,
            updated_at: new Date().toISOString(),
          })
          .eq("id", closetItemId),
      (result) => (result.error ? "failure" : "success"),
    );
    if (processingError) throw processingError;

    const generatedImage = await callConfiguredImageEdit(imageDataUrl, timing);
    timing.addMetadata({ outputKind: generatedImage.kind });
    const { fileBody, extension, contentType } =
      generatedImage.kind === "url"
        ? await downloadGeneratedImage(generatedImage.value, trace)
        : trace.measureSync("output_base64_decode", () =>
            decodeImageEditBase64(generatedImage.value),
          );
    timing.addMetadata({ outputBytes: fileBody.length });
    const displayImagePath = `${userId}/display/${crypto.randomUUID()}${extension}`;

    const { error: uploadError } = await trace.measure(
      "storage_upload",
      () =>
        supabase.storage.from("closet-images").upload(displayImagePath, fileBody, {
          cacheControl: "3600",
          contentType,
          upsert: false,
        }),
      (result) => (result.error ? "failure" : "success"),
    );

    if (uploadError) throw uploadError;

    const qualityFlags = await mergeCurrentQualityFlags(
      supabase,
      closetItemId,
      {
        add: ["display_image_ready"],
        remove: ["display_image_queued", "display_image_processing", "display_image_failed"],
      },
      trace,
      "db_quality_flags_read",
    );
    const { data, error } = await trace.measure(
      "db_mark_ready",
      () =>
        supabase
          .from("closet_items")
          .update({
            display_image_path: displayImagePath,
            display_image_status: "ready",
            display_image_model: imageEditModel,
            display_image_prompt_version: CLOSET_DISPLAY_PROMPT_VERSION,
            image_quality_flags: qualityFlags,
            updated_at: new Date().toISOString(),
          })
          .eq("id", closetItemId)
          .select(closetItemSelect)
          .single(),
      (result) => (result.error || !result.data ? "failure" : "success"),
    );

    if (error) throw error;

    return timing.json({
      item: data,
    });
  } catch (error) {
    console.error("[closet-display-image] failed", {
      closetItemId,
      failure: describeDisplayImageFailure(error),
    });

    try {
      const qualityFlags = await mergeCurrentQualityFlags(
        supabase,
        closetItemId,
        {
          add: ["display_image_failed"],
          remove: ["display_image_queued", "display_image_processing", "display_image_ready"],
        },
        trace,
        "db_failure_flags_read",
      );
      const { error: markFailedError } = await trace.measure(
        "db_mark_failed",
        () =>
          supabase
            .from("closet_items")
            .update({
              display_image_status: "failed",
              image_quality_flags: qualityFlags,
              updated_at: new Date().toISOString(),
            })
            .eq("id", closetItemId),
        (result) => (result.error ? "failure" : "success"),
      );
      if (markFailedError) throw markFailedError;
    } catch (cleanupError) {
      console.error("[closet-display-image] failure state update failed", {
        closetItemId,
        failure: describeDisplayImageFailure(cleanupError),
      });
    }

    return timing.json(
      {
        message: "Display image generation failed.",
      },
      {
        status: 500,
        metadata: { failureKind: describeDisplayImageFailure(error) },
      },
    );
  }
}

async function callConfiguredImageEdit(
  imageDataUrl: string,
  timing: ReturnType<typeof createRouteTiming>,
): Promise<ImageEditOutput> {
  const { trace } = timing;
  const imageEditRequest = trace.measureSync("provider_request_build", () =>
    createImageEditRequest(
      imageDataUrl,
      buildClosetDisplayPrompt(),
      buildClosetDisplayNegativePrompt(),
    ),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), imageEditRequest.timeoutMs);

  try {
    const response = await trace.measure(
      "provider_fetch_ttfb",
      () =>
        fetch(imageEditRequest.endpoint, {
          ...createImageEditRequestInit(imageEditRequest),
          signal: controller.signal,
        }),
      (result) => (result.ok ? "success" : "failure"),
    );

    try {
      timing.addMetadata(extractImageEditResponseDiagnostics(response));
    } catch {
      // Provider diagnostics must not change image generation behavior.
    }

    if (!response.ok) {
      throw new ImageEditProviderError("provider_request_failed", response.status);
    }

    let responseBody: string;
    try {
      const bodyResult = await readImageEditResponseBody(response, trace);
      responseBody = bodyResult.bodyText;
      timing.addMetadata({ providerResponseBytes: bodyResult.responseBytes });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ImageEditProviderError("invalid_provider_response");
    }

    let result: unknown;
    try {
      result = parseImageEditResponseJson(responseBody, trace);
    } catch {
      throw new ImageEditProviderError("invalid_provider_response");
    }

    return trace.measureSync("provider_output_extract", () => {
      const imageOutput = extractImageEditOutput(result);
      if (!imageOutput) {
        throw new ImageEditProviderError("missing_image_output");
      }
      return imageOutput;
    });
  } finally {
    clearTimeout(timeout);
  }
}

class ImageEditProviderError extends Error {
  constructor(
    readonly failure:
      | "provider_request_failed"
      | "invalid_provider_response"
      | "missing_image_output",
    readonly status?: number,
  ) {
    super(failure);
    this.name = "ImageEditProviderError";
  }
}

function describeDisplayImageFailure(error: unknown) {
  if (error instanceof ImageEditProviderError) {
    return error.status ? `${error.failure}:${error.status}` : error.failure;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "provider_timeout";
  }
  return "image_generation_or_storage_failed";
}

async function downloadGeneratedImage(url: string, trace: TimingTrace) {
  const response = await trace.measure(
    "output_url_fetch",
    () => fetch(url),
    (result) => (result.ok ? "success" : "failure"),
  );

  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }

  const rawContentType = response.headers.get("content-type");
  const contentType = normalizeImageContentType(rawContentType, url);
  const extension = extensionFromContentType(contentType);

  return {
    fileBody: Buffer.from(
      await trace.measure("output_url_body", () => response.arrayBuffer()),
    ),
    extension,
    contentType,
  };
}

function normalizeImageContentType(contentType: string | null, url: string) {
  const lowerContentType = contentType?.toLowerCase() ?? "";
  if (lowerContentType.includes("image/jpeg") || lowerContentType.includes("image/jpg")) {
    return "image/jpeg";
  }
  if (lowerContentType.includes("image/webp")) return "image/webp";
  if (lowerContentType.includes("image/png")) return "image/png";

  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes(".jpg") || lowerUrl.includes(".jpeg")) return "image/jpeg";
  if (lowerUrl.includes(".webp")) return "image/webp";
  return "image/png";
}

function extensionFromContentType(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  return ".png";
}

async function mergeCurrentQualityFlags(
  supabase: SupabaseClient,
  closetItemId: string,
  changes: { add?: string[]; remove?: string[] },
  trace: TimingTrace,
  spanName: string,
) {
  const { data, error } = await trace.measure(
    spanName,
    () =>
      supabase
        .from("closet_items")
        .select("image_quality_flags")
        .eq("id", closetItemId)
        .single<ClosetQualityRow>(),
    (result) => (result.error ? "failure" : "success"),
  );
  if (error) throw error;

  return mergeQualityFlags(data?.image_quality_flags ?? [], changes.add ?? [], changes.remove ?? []);
}

function mergeQualityFlags(current: string[], add: string[], remove: string[]) {
  const removeSet = new Set(remove);

  return Array.from(
    new Set([
      ...current.filter((flag) => flag && !removeSet.has(flag)),
      ...add.filter((flag) => flag && !removeSet.has(flag)),
    ]),
  );
}
