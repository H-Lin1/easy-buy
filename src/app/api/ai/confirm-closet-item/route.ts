import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  buildClosetEmbeddingText,
  removeClosetConfirmationFlags,
} from "@/lib/closet/embedding-text";
import { embedText, toPgVector } from "@/lib/ai/providers";
import { appEnv } from "@/lib/env";

export const runtime = "nodejs";

const closetItemSelect =
  "id,image_path,processed_image_path,display_image_path,display_image_status,display_image_model,display_image_prompt_version,image_quality_flags,category,color,fit,style_tags,season,scenario_tags,wear_frequency,status,summary,embedding_text,ai_confidence,user_corrected";

const requestSchema = z.object({
  closetItemId: z.string().uuid(),
  draft: z.object({
    name: z.string().min(1).max(80),
    category: z.string().min(1).max(60),
    color: z.string().min(1).max(40),
    fit: z.enum(["slim", "regular", "oversized", "unknown"]),
    styleTags: z.array(z.string().min(1).max(24)).max(12),
    scenarioTags: z.array(z.string().min(1).max(24)).max(12),
    seasonTags: z.array(z.string().min(1).max(24)).max(8),
    wearFrequency: z.enum(["often", "sometimes", "rarely", "unknown"]),
  }),
});

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

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid closet confirmation request.", issues: parsed.error.issues },
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

  const { closetItemId, draft } = parsed.data;
  const { data: currentItem, error: currentError } = await supabase
    .from("closet_items")
    .select("image_quality_flags")
    .eq("id", closetItemId)
    .single<ClosetQualityRow>();

  if (currentError || !currentItem) {
    return NextResponse.json({ message: "Closet item not found." }, { status: 404 });
  }

  const embeddingText = buildClosetEmbeddingText(draft);
  const embedding = await embedText(embeddingText);
  const nextFlags = removeClosetConfirmationFlags(currentItem.image_quality_flags ?? []);

  const { data, error } = await supabase
    .from("closet_items")
    .update({
      category: draft.category,
      color: draft.color,
      fit: draft.fit,
      style_tags: draft.styleTags,
      season: draft.seasonTags,
      scenario_tags: draft.scenarioTags,
      wear_frequency: draft.wearFrequency,
      summary: draft.name,
      embedding_text: embeddingText,
      embedding: toPgVector(embedding),
      image_quality_flags: nextFlags,
      user_corrected: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", closetItemId)
    .select(closetItemSelect)
    .single();

  if (error) {
    return NextResponse.json({ message: error.message }, { status: 500 });
  }

  return NextResponse.json({
    item: data,
    embeddingText,
  });
}
