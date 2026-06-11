import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  CLOSET_DISPLAY_PROMPT_VERSION,
  buildClosetDisplayNegativePrompt,
  buildClosetDisplayPrompt,
} from "@/lib/ai/image-edit-prompt";
import { appEnv } from "@/lib/env";

export const runtime = "nodejs";

const requestSchema = z.object({
  closetItemId: z.string().uuid(),
  imagePath: z.string().min(1),
  imageDataUrl: z.string().startsWith("data:image/"),
});

type SiliconFlowImageResult = {
  images?: Array<{ url?: string }>;
  data?: Array<{ url?: string }>;
  error?: { message?: string };
  message?: string;
};

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

  if (!appEnv.siliconFlowApiKey) {
    return NextResponse.json({ message: "SILICONFLOW_API_KEY is not configured." }, { status: 500 });
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
      display_image_model: appEnv.imageEditModel,
      display_image_prompt_version: CLOSET_DISPLAY_PROMPT_VERSION,
      updated_at: new Date().toISOString(),
    })
    .eq("id", closetItemId);

  try {
    const generatedUrl = await callSiliconFlowImageEdit(imageDataUrl);
    const { fileBody, extension, contentType } = await downloadGeneratedImage(generatedUrl);
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
        display_image_model: appEnv.imageEditModel,
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
    const message = error instanceof Error ? error.message : "Display image generation failed.";
    console.error("[closet-display-image] failed", {
      closetItemId,
      message,
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
        message,
      },
      { status: 500 },
    );
  }
}

async function callSiliconFlowImageEdit(imageDataUrl: string) {
  const endpoint = `${appEnv.siliconFlowBaseUrl.replace(/\/$/, "")}/images/generations`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appEnv.siliconFlowImageTimeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appEnv.siliconFlowApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: appEnv.imageEditModel,
        prompt: buildClosetDisplayPrompt(),
        negative_prompt: buildClosetDisplayNegativePrompt(),
        image: imageDataUrl,
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let result: SiliconFlowImageResult;

    try {
      result = JSON.parse(text) as SiliconFlowImageResult;
    } catch {
      throw new Error(`SiliconFlow response is not JSON: ${text.slice(0, 300)}`);
    }

    if (!response.ok) {
      const traceId = response.headers.get("x-siliconcloud-trace-id");
      throw new Error(
        `SiliconFlow image API failed ${response.status}${
          traceId ? `, trace ${traceId}` : ""
        }: ${result.message ?? result.error?.message ?? text.slice(0, 300)}`,
      );
    }

    const imageUrl = result.images?.[0]?.url ?? result.data?.[0]?.url;
    if (!imageUrl) {
      throw new Error("SiliconFlow image API did not return an image URL.");
    }

    return imageUrl;
  } finally {
    clearTimeout(timeout);
  }
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
