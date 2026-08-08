import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  buildClosetAnalysisPrompt,
  parseClosetAnalysisJson,
} from "@/lib/ai/closet-analysis";
import {
  generateVisionJson,
  getAiCapabilityConfig,
  getAiCapabilityConfigError,
  hasVisionConfig,
  sanitizeAiErrorMessage,
} from "@/lib/ai/providers";
import { appEnv } from "@/lib/env";
import { createRouteTiming } from "@/lib/performance/route-timing";
import type { TimingTrace } from "@/lib/performance/timing";

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
  const timing = createRouteTiming(request, {
    operation: "closet_analysis_route",
    route: "analyze_closet_item",
  });

  try {
    return await handlePost(request, timing);
  } catch (error) {
    console.error("[closet-analysis] route failed", {
      message: sanitizeAiErrorMessage(error),
    });

    return timing.json(
      { message: "Closet item analysis failed." },
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

  if (!hasVisionConfig()) {
    return timing.json(
      { message: getAiCapabilityConfigError("vision") },
      { status: 500, metadata: { failureKind: "vision_not_configured" } },
    );
  }

  const visionConfig = getAiCapabilityConfig("vision");
  timing.addMetadata({ provider: visionConfig.provider, model: visionConfig.model ?? "unknown" });

  const body = await trace.measure("request_body_json", () => request.json()).catch(() => null);
  const parsed = trace.measureSync(
    "request_validate",
    () => requestSchema.safeParse(body),
    (result) => (result.success ? "success" : "failure"),
  );

  if (!parsed.success) {
    return timing.json(
      { message: "Invalid closet analysis request.", issues: parsed.error.issues },
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

  const { closetItemId, imagePath, originalImageDataUrl, displayImageDataUrl, fileName, userFeedback } =
    parsed.data;

  timing.addMetadata({
    imageCount: displayImageDataUrl ? 2 : 1,
    inputChars: originalImageDataUrl.length + (displayImageDataUrl?.length ?? 0),
  });
  const { data: closetItem, error: closetError } = await trace.measure(
    "db_item_lookup",
    () =>
      supabase
        .from("closet_items")
        .select("id,image_path,display_image_path")
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
    await updateQualityFlags(
      supabase,
      closetItemId,
      {
        add: ["closet_analysis_processing"],
        remove: ["closet_analysis_queued", "closet_analysis_failed"],
      },
      trace,
      "db_mark_processing",
    );

    const imageDataUrls = [originalImageDataUrl, displayImageDataUrl].filter(
      (url): url is string => Boolean(url),
    );
    const prompt = trace.measureSync("prompt_build", () =>
      buildClosetAnalysisPrompt({
        fileName,
        hasDisplayImage: Boolean(displayImageDataUrl),
        userFeedback,
      }),
    );
    const raw = await trace.measure("vision_api_sdk", () => generateVisionJson(prompt, imageDataUrls));
    const analysis = trace.measureSync("analysis_parse", () => parseClosetAnalysisJson(raw));
    const qualityFlags = await mergeCurrentQualityFlags(
      supabase,
      closetItemId,
      {
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
          .single(),
      (result) => (result.error || !result.data ? "failure" : "success"),
    );

    if (error) throw error;

    return timing.json({
      item: data,
      analysis,
    });
  } catch (error) {
    console.error("[closet-analysis] failed", {
      closetItemId,
      message: sanitizeAiErrorMessage(error),
    });

    try {
      const qualityFlags = await mergeCurrentQualityFlags(
        supabase,
        closetItemId,
        {
          add: ["closet_analysis_failed", "needs_ai_label_confirmation"],
          remove: ["closet_analysis_queued", "closet_analysis_processing"],
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
              image_quality_flags: qualityFlags,
              updated_at: new Date().toISOString(),
            })
            .eq("id", closetItemId),
        (result) => (result.error ? "failure" : "success"),
      );
      if (markFailedError) throw markFailedError;
    } catch (cleanupError) {
      console.error("[closet-analysis] failure state update failed", {
        closetItemId,
        message: sanitizeAiErrorMessage(cleanupError),
      });
    }

    return timing.json(
      { message: "Closet item analysis failed." },
      { status: 500, metadata: { failureKind: "analysis_or_persistence_failed" } },
    );
  }
}

async function updateQualityFlags(
  supabase: SupabaseClient,
  closetItemId: string,
  changes: { add?: string[]; remove?: string[] },
  trace: TimingTrace,
  spanPrefix: string,
) {
  const flags = await mergeCurrentQualityFlags(
    supabase,
    closetItemId,
    changes,
    trace,
    `${spanPrefix}_flags_read`,
  );

  const { error } = await trace.measure(
    spanPrefix,
    () =>
      supabase
        .from("closet_items")
        .update({
          image_quality_flags: flags,
          updated_at: new Date().toISOString(),
        })
        .eq("id", closetItemId),
    (result) => (result.error ? "failure" : "success"),
  );
  if (error) throw error;
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
