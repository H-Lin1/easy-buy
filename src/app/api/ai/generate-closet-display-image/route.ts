import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  CLOSET_DISPLAY_PROMPT_VERSION,
  buildClosetDisplayNegativePrompt,
  buildClosetDisplayPrompt,
} from "@/lib/ai/image-edit-prompt";
import {
  decodeImageEditBase64,
  extractImageEditOutput,
  createImageEditRequestInit,
  type ImageEditOutput,
} from "@/lib/ai/image-provider";
import {
  createImageEditRequest,
  getAiCapabilityConfig,
  getAiCapabilityConfigError,
  hasImageEditConfig,
} from "@/lib/ai/providers";
import { appEnv } from "@/lib/env";

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
  const authHeader = request.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ message: "Missing auth token." }, { status: 401 });
  }

  if (!appEnv.supabaseUrl || !appEnv.supabaseAnonKey) {
    return NextResponse.json({ message: "Supabase is not configured." }, { status: 500 });
  }

  if (!hasImageEditConfig()) {
    return NextResponse.json(
      { message: getAiCapabilityConfigError("imageEdit") },
      { status: 500 },
    );
  }

  const imageEditModel = getAiCapabilityConfig("imageEdit").model;
  if (!imageEditModel) {
    return NextResponse.json(
      { message: getAiCapabilityConfigError("imageEdit") },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid display image request.", issues: parsed.error.issues },
      { status: 400 },
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
  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData.user) {
    return NextResponse.json({ message: "Invalid auth token." }, { status: 401 });
  }

  const { closetItemId, imagePath, imageDataUrl } = parsed.data;
  const userId = userData.user.id;

  const { data: closetItem, error: closetError } = await supabase
    .from("closet_items")
    .select("id,image_path")
    .eq("id", closetItemId)
    .single();

  if (closetError || !closetItem || closetItem.image_path !== imagePath) {
    return NextResponse.json({ message: "Closet item not found." }, { status: 404 });
  }

  await supabase
    .from("closet_items")
    .update({
      display_image_status: "processing",
      display_image_model: imageEditModel,
      display_image_prompt_version: CLOSET_DISPLAY_PROMPT_VERSION,
      updated_at: new Date().toISOString(),
    })
    .eq("id", closetItemId);

  try {
    const generatedImage = await callConfiguredImageEdit(imageDataUrl);
    const { fileBody, extension, contentType } =
      generatedImage.kind === "url"
        ? await downloadGeneratedImage(generatedImage.value)
        : decodeImageEditBase64(generatedImage.value);
    const displayImagePath = `${userId}/display/${crypto.randomUUID()}${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("closet-images")
      .upload(displayImagePath, fileBody, {
        cacheControl: "3600",
        contentType,
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const { data, error } = await supabase
      .from("closet_items")
      .update({
        display_image_path: displayImagePath,
        display_image_status: "ready",
        display_image_model: imageEditModel,
        display_image_prompt_version: CLOSET_DISPLAY_PROMPT_VERSION,
        image_quality_flags: await mergeCurrentQualityFlags(supabase, closetItemId, {
          add: ["display_image_ready"],
          remove: ["display_image_queued", "display_image_processing", "display_image_failed"],
        }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", closetItemId)
      .select(closetItemSelect)
      .single();

    if (error) throw error;

    return NextResponse.json({
      item: data,
    });
  } catch (error) {
    console.error("[closet-display-image] failed", {
      closetItemId,
      failure: describeDisplayImageFailure(error),
    });

    await supabase
      .from("closet_items")
      .update({
        display_image_status: "failed",
        image_quality_flags: await mergeCurrentQualityFlags(supabase, closetItemId, {
          add: ["display_image_failed"],
          remove: ["display_image_queued", "display_image_processing", "display_image_ready"],
        }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", closetItemId);

    return NextResponse.json(
      {
        message: "Display image generation failed.",
      },
      { status: 500 },
    );
  }
}

async function callConfiguredImageEdit(imageDataUrl: string): Promise<ImageEditOutput> {
  const imageEditRequest = createImageEditRequest(
    imageDataUrl,
    buildClosetDisplayPrompt(),
    buildClosetDisplayNegativePrompt(),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), imageEditRequest.timeoutMs);

  try {
    const response = await fetch(imageEditRequest.endpoint, {
      ...createImageEditRequestInit(imageEditRequest),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ImageEditProviderError("provider_request_failed", response.status);
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new ImageEditProviderError("invalid_provider_response");
    }

    const imageOutput = extractImageEditOutput(result);
    if (!imageOutput) {
      throw new ImageEditProviderError("missing_image_output");
    }

    return imageOutput;
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

async function downloadGeneratedImage(url: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }

  const rawContentType = response.headers.get("content-type");
  const contentType = normalizeImageContentType(rawContentType, url);
  const extension = extensionFromContentType(contentType);

  return {
    fileBody: Buffer.from(await response.arrayBuffer()),
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
) {
  const { data } = await supabase
    .from("closet_items")
    .select("image_quality_flags")
    .eq("id", closetItemId)
    .single<ClosetQualityRow>();

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
