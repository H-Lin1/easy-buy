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
import { claimableDisplayImageStatuses } from "@/lib/closet/display-workflow";
import { appEnv } from "@/lib/env";
import { createRouteTiming } from "@/lib/performance/route-timing";
import type { TimingTrace } from "@/lib/performance/timing";

export const runtime = "nodejs";

const requestSchema = z.object({
  closetItemId: z.string().uuid(),
  imagePath: z.string().min(1),
  imageDataUrl: z.string().startsWith("data:image/"),
});

const displayImageSelect =
  "id,display_image_path,display_image_status,display_image_model,display_image_prompt_version";

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

  const { data: claimedItem, error: processingError } = await trace.measure(
    "db_mark_processing",
    () =>
      supabase
        .from("closet_items")
        .update({
          display_image_status: "processing",
        })
        .eq("id", closetItemId)
        .in("display_image_status", [...claimableDisplayImageStatuses])
        .select("id")
        .maybeSingle(),
    (result) => (result.error || !result.data ? "failure" : "success"),
  );

  if (processingError) throw processingError;
  if (!claimedItem) {
    const { data: authoritativeItem, error: authoritativeItemError } = await trace.measure(
      "db_read_claim_conflict",
      () =>
        supabase
          .from("closet_items")
          .select(displayImageSelect)
          .eq("id", closetItemId)
          .maybeSingle(),
      (result) => (result.error || !result.data ? "failure" : "success"),
    );
    if (authoritativeItemError) throw authoritativeItemError;

    return timing.json(
      {
        message: "Display image generation is already in progress.",
        item: authoritativeItem ?? undefined,
      },
      { status: 409, metadata: { failureKind: "display_image_not_claimed" } },
    );
  }

  let uploadedDisplayImagePath: string | undefined;
  let displayImageCommitted = false;

  try {
    if (!hasImageEditConfig()) {
      throw new ImageEditConfigurationError(
        "image_edit_not_configured",
        getAiCapabilityConfigError("imageEdit"),
      );
    }

    const imageEditConfig = getAiCapabilityConfig("imageEdit");
    const imageEditModel = imageEditConfig.model;
    if (!imageEditModel) {
      throw new ImageEditConfigurationError(
        "image_edit_model_missing",
        getAiCapabilityConfigError("imageEdit"),
      );
    }
    timing.addMetadata({ provider: imageEditConfig.provider, model: imageEditModel });

    const generatedImage = await callConfiguredImageEdit(imageDataUrl, timing, request.signal);
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
    uploadedDisplayImagePath = displayImagePath;

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
          })
          .eq("id", closetItemId)
          .eq("display_image_status", "processing")
          .select(displayImageSelect)
          .maybeSingle(),
      (result) => (result.error || !result.data ? "failure" : "success"),
    );

    if (error) throw error;
    if (!data) {
      await removeUncommittedDisplayImage(
        supabase,
        displayImagePath,
        trace,
        closetItemId,
        "storage_cleanup_unowned",
      );
      uploadedDisplayImagePath = undefined;
      return timing.json(
        { message: "Display image generation no longer owns this item." },
        { status: 409, metadata: { failureKind: "display_image_commit_not_owned" } },
      );
    }
    displayImageCommitted = true;

    return timing.json({
      item: data,
    });
  } catch (error) {
    console.error("[closet-display-image] failed", {
      closetItemId,
      failure: describeDisplayImageFailure(error),
    });

    if (uploadedDisplayImagePath && !displayImageCommitted) {
      await removeUncommittedDisplayImage(
        supabase,
        uploadedDisplayImagePath,
        trace,
        closetItemId,
        "storage_cleanup_failed",
      );
    }

    try {
      const { error: markFailedError } = await trace.measure(
        "db_mark_failed",
        () =>
          supabase
            .from("closet_items")
            .update({
              display_image_status: "failed",
            })
            .eq("id", closetItemId)
            .eq("display_image_status", "processing"),
        (result) => (result.error ? "failure" : "success"),
      );
      if (markFailedError) throw markFailedError;
    } catch (cleanupError) {
      console.error("[closet-display-image] failure state update failed", {
        closetItemId,
        failure: describeDisplayImageFailure(cleanupError),
      });
    }

    const failureKind = describeDisplayImageFailure(error);
    return timing.json(
      {
        message:
          error instanceof ImageEditConfigurationError
            ? error.message
            : "Display image generation failed.",
      },
      {
        status: 500,
        metadata: { failureKind },
      },
    );
  }
}

async function callConfiguredImageEdit(
  imageDataUrl: string,
  timing: ReturnType<typeof createRouteTiming>,
  requestSignal: AbortSignal,
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
  const abortProviderRequest = () => controller.abort();
  requestSignal.addEventListener("abort", abortProviderRequest, { once: true });
  if (requestSignal.aborted) controller.abort();

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
    requestSignal.removeEventListener("abort", abortProviderRequest);
  }
}

async function removeUncommittedDisplayImage(
  supabase: SupabaseClient,
  displayImagePath: string,
  trace: TimingTrace,
  closetItemId: string,
  spanName: string,
) {
  try {
    const { error } = await trace.measure(
      spanName,
      () => supabase.storage.from("closet-images").remove([displayImagePath]),
      (result) => (result.error ? "failure" : "success"),
    );
    if (error) throw error;
  } catch (error) {
    console.error("[closet-display-image] orphan cleanup failed", {
      closetItemId,
      displayImagePath,
      failure: describeDisplayImageFailure(error),
    });
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

class ImageEditConfigurationError extends Error {
  constructor(
    readonly failure: "image_edit_not_configured" | "image_edit_model_missing",
    message: string,
  ) {
    super(message);
    this.name = "ImageEditConfigurationError";
  }
}

function describeDisplayImageFailure(error: unknown) {
  if (error instanceof ImageEditConfigurationError) {
    return error.failure;
  }
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
