import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  buildClosetAnalysisPrompt,
  parseClosetAnalysisJson,
} from "@/lib/ai/closet-analysis";
import { generateVisionJson } from "@/lib/ai/providers";
import { appEnv } from "@/lib/env";

export const runtime = "nodejs";

const requestSchema = z.object({
  closetItemId: z.string().uuid(),
  imagePath: z.string().min(1),
  originalImageDataUrl: z.string().startsWith("data:image/"),
  displayImageDataUrl: z.string().startsWith("data:image/").optional(),
  fileName: z.string().optional(),
  userFeedback: z.string().max(800).optional(),
});

const closetItemSelect =
  "id,image_path,processed_image_path,display_image_path,display_image_status,display_image_model,display_image_prompt_version,image_quality_flags,category,color,fit,style_tags,season,scenario_tags,wear_frequency,status,summary,embedding_text,ai_confidence,user_corrected";

type ClosetQualityRow = {
  image_quality_flags: string[] | null;
};

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ message: "Missing auth token." }, { status: 401 });
  }

  if (!appEnv.supabaseUrl || !appEnv.supabaseAnonKey) {
    return NextResponse.json({ message: "Supabase is not configured." }, { status: 500 });
  }

  if (!appEnv.autoDlApiKey) {
    return NextResponse.json({ message: "AUTODL_API_KEY is not configured." }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid closet analysis request.", issues: parsed.error.issues },
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

  const { closetItemId, imagePath, originalImageDataUrl, displayImageDataUrl, fileName, userFeedback } =
    parsed.data;

  const { data: closetItem, error: closetError } = await supabase
    .from("closet_items")
    .select("id,image_path,display_image_path")
    .eq("id", closetItemId)
    .single();

  if (closetError || !closetItem || closetItem.image_path !== imagePath) {
    return NextResponse.json({ message: "Closet item not found." }, { status: 404 });
  }

  await updateQualityFlags(supabase, closetItemId, {
    add: ["closet_analysis_processing"],
    remove: ["closet_analysis_queued", "closet_analysis_failed"],
  });

  try {
    const imageDataUrls = [originalImageDataUrl, displayImageDataUrl].filter(
      (url): url is string => Boolean(url),
    );
    const prompt = buildClosetAnalysisPrompt({
      fileName,
      hasDisplayImage: Boolean(displayImageDataUrl),
      userFeedback,
    });
    const raw = await generateVisionJson(prompt, imageDataUrls);
    const analysis = parseClosetAnalysisJson(raw);
    const qualityFlags = await mergeCurrentQualityFlags(supabase, closetItemId, {
      add: [
        ...analysis.imageQualityFlags,
        "ai_label_ready",
        ...(analysis.needsUserReview ? ["needs_ai_label_confirmation"] : []),
      ],
      remove: [
        "closet_analysis_queued",
        "closet_analysis_processing",
        "closet_analysis_failed",
        "display_image_queued",
      ],
    });

    const { data, error } = await supabase
      .from("closet_items")
      .update({
        category: analysis.category,
        color: analysis.color,
        secondary_colors: analysis.secondaryColors,
        fit: analysis.fit,
        style_tags: analysis.styleTags,
        season: analysis.season,
        formality: analysis.formality,
        scenario_tags: analysis.scenarioTags,
        summary: analysis.itemName,
        embedding_text: analysis.embeddingText,
        ai_confidence: analysis.aiConfidence,
        user_corrected: false,
        image_quality_flags: qualityFlags,
        updated_at: new Date().toISOString(),
      })
      .eq("id", closetItemId)
      .select(closetItemSelect)
      .single();

    if (error) throw error;

    return NextResponse.json({
      item: data,
      analysis,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Closet item analysis failed.";
    console.error("[closet-analysis] failed", {
      closetItemId,
      message,
    });

    const qualityFlags = await mergeCurrentQualityFlags(supabase, closetItemId, {
      add: ["closet_analysis_failed", "needs_ai_label_confirmation"],
      remove: ["closet_analysis_queued", "closet_analysis_processing"],
    });

    await supabase
      .from("closet_items")
      .update({
        image_quality_flags: qualityFlags,
        updated_at: new Date().toISOString(),
      })
      .eq("id", closetItemId);

    return NextResponse.json({ message }, { status: 500 });
  }
}

async function updateQualityFlags(
  supabase: SupabaseClient,
  closetItemId: string,
  changes: { add?: string[]; remove?: string[] },
) {
  const flags = await mergeCurrentQualityFlags(supabase, closetItemId, changes);

  await supabase
    .from("closet_items")
    .update({
      image_quality_flags: flags,
      updated_at: new Date().toISOString(),
    })
    .eq("id", closetItemId);
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
