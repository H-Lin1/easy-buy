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
import { CLOSET_ANALYSIS_OWNER_FLAG_PREFIX } from "@/lib/closet/embedding-text";
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
  intent: z.enum(["initial_upload", "user_reanalysis"]).default("initial_upload"),
});

const closetItemSelect =
  "id,image_path,processed_image_path,display_image_path,display_image_status,display_image_model,display_image_prompt_version,image_quality_flags,category,color,fit,style_tags,season,scenario_tags,wear_frequency,status,summary,embedding_text,ai_confidence,user_corrected,updated_at";

type ClosetQualityRow = {
  image_quality_flags: string[] | null;
};

type QualityFlagChanges = {
  add?: string[];
  remove?: string[];
  removePrefixes?: string[];
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

  const {
    closetItemId,
    imagePath,
    originalImageDataUrl,
    displayImageDataUrl,
    fileName,
    userFeedback,
    intent,
  } = parsed.data;

  timing.addMetadata({
    imageCount: displayImageDataUrl ? 2 : 1,
    inputChars: originalImageDataUrl.length + (displayImageDataUrl?.length ?? 0),
  });
  const { data: closetItem, error: closetError } = await trace.measure(
    "db_item_lookup",
    () =>
      supabase
        .from("closet_items")
        .select(closetItemSelect)
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

  const manualReanalysis = intent === "user_reanalysis" && Boolean(closetItem.user_corrected);
  const analysisOwnerFlag = `${CLOSET_ANALYSIS_OWNER_FLAG_PREFIX}${crypto.randomUUID()}`;
  const originalQualityFlags = ((closetItem.image_quality_flags ?? []) as string[]).filter(
    (flag: string) => !flag.startsWith(CLOSET_ANALYSIS_OWNER_FLAG_PREFIX),
  );

  try {
    const analysisClaimed = await updateQualityFlags(
      supabase,
      closetItemId,
      {
        add: ["closet_analysis_processing", analysisOwnerFlag],
        remove: ["closet_analysis_queued", "closet_analysis_failed"],
        removePrefixes: [CLOSET_ANALYSIS_OWNER_FLAG_PREFIX],
      },
      trace,
      "db_mark_processing",
      manualReanalysis,
      manualReanalysis ? closetItem.updated_at : undefined,
    );

    if (!analysisClaimed) {
      const { data: authoritativeItem, error: authoritativeItemError } = await trace.measure(
        "db_read_confirmed_before_analysis",
        () =>
          supabase
            .from("closet_items")
            .select(closetItemSelect)
            .eq("id", closetItemId)
            .single(),
        (result) => (result.error || !result.data ? "failure" : "success"),
      );

      if (authoritativeItemError || !authoritativeItem) {
        throw authoritativeItemError ?? new Error("Authoritative closet item could not be read.");
      }

      const analysisAlreadyInProgress = (
        authoritativeItem.image_quality_flags ?? []
      ).includes("closet_analysis_processing");
      const conflict = analysisAlreadyInProgress
        ? "analysis_already_in_progress"
        : authoritativeItem.user_corrected
          ? "analysis_superseded_by_confirmation"
          : "analysis_state_changed";

      return timing.json(
        {
          message:
            conflict === "analysis_already_in_progress"
              ? "Closet item analysis is already in progress."
              : conflict === "analysis_superseded_by_confirmation"
                ? "Closet item confirmation already owns the latest labels."
                : "Closet item analysis state changed before this request could start.",
          conflict,
          item: authoritativeItem,
        },
        { status: 409, metadata: { failureKind: conflict } },
      );
    }

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
    const raw = await trace.measure("vision_api_sdk", () =>
      generateVisionJson(prompt, imageDataUrls, request.signal),
    );
    const analysis = trace.measureSync("analysis_parse", () => parseClosetAnalysisJson(raw));
    const analysisQualityFlags = analysis.imageQualityFlags.filter(
      (flag: string) => !flag.startsWith(CLOSET_ANALYSIS_OWNER_FLAG_PREFIX),
    );
    const qualityFlags = await mergeCurrentQualityFlags(
      supabase,
      closetItemId,
      {
        add: [
          ...analysisQualityFlags,
          "ai_label_ready",
          ...(analysis.needsUserReview || manualReanalysis
            ? ["needs_ai_label_confirmation"]
            : []),
        ],
        remove: [
          "closet_analysis_queued",
          "closet_analysis_processing",
          "closet_analysis_failed",
        ],
        removePrefixes: [CLOSET_ANALYSIS_OWNER_FLAG_PREFIX],
      },
      trace,
      "db_quality_flags_read",
    );

    const analysisPatch = {
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
    };

    const { data, error } = await trace.measure(
      "db_mark_ready",
      () => {
        const update = supabase
          .from("closet_items")
          .update({
            ...analysisPatch,
            updated_at: new Date().toISOString(),
          })
          .eq("id", closetItemId);
        const guardedUpdate = update
          .eq("user_corrected", manualReanalysis)
          .contains("image_quality_flags", ["closet_analysis_processing", analysisOwnerFlag]);
        return guardedUpdate.select(closetItemSelect).maybeSingle();
      },
      (result) => (result.error || !result.data ? "failure" : "success"),
    );

    if (error) throw error;
    if (!data) {
      const { data: confirmedItem, error: confirmedItemError } = await trace.measure(
        "db_read_confirmed_item",
        () =>
          supabase
            .from("closet_items")
            .select(closetItemSelect)
            .eq("id", closetItemId)
            .single(),
        (result) => (result.error || !result.data ? "failure" : "success"),
      );

      if (confirmedItemError || !confirmedItem) {
        throw confirmedItemError ?? new Error("Confirmed closet item could not be read.");
      }

      const analysisAlreadyInProgress = (
        confirmedItem.image_quality_flags ?? []
      ).includes("closet_analysis_processing");
      const conflict = analysisAlreadyInProgress
        ? "analysis_already_in_progress"
        : confirmedItem.user_corrected
          ? "analysis_superseded_by_confirmation"
          : "analysis_state_changed";

      return timing.json(
        {
          message:
            conflict === "analysis_already_in_progress"
              ? "A newer closet item analysis is already in progress."
              : conflict === "analysis_superseded_by_confirmation"
                ? "Closet item confirmation already owns the latest labels."
                : "Closet item analysis state changed before this result could be committed.",
          conflict,
          item: confirmedItem,
        },
        { status: 409, metadata: { failureKind: conflict } },
      );
    }

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
      if (manualReanalysis) {
        const { error: restoreConfirmedError } = await trace.measure(
          "db_restore_confirmed_after_analysis_failure",
          () =>
            supabase
              .from("closet_items")
              .update({
                image_quality_flags: originalQualityFlags,
                updated_at: new Date().toISOString(),
              })
              .eq("id", closetItemId)
              .eq("user_corrected", true)
              .contains("image_quality_flags", [
                "closet_analysis_processing",
                analysisOwnerFlag,
              ]),
          (result) => (result.error ? "failure" : "success"),
        );
        if (restoreConfirmedError) throw restoreConfirmedError;
      } else {
        const qualityFlags = await mergeCurrentQualityFlags(
          supabase,
          closetItemId,
          {
            add: ["closet_analysis_failed", "needs_ai_label_confirmation"],
            remove: ["closet_analysis_queued", "closet_analysis_processing"],
            removePrefixes: [CLOSET_ANALYSIS_OWNER_FLAG_PREFIX],
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
              .eq("id", closetItemId)
              .eq("user_corrected", false)
              .contains("image_quality_flags", [
                "closet_analysis_processing",
                analysisOwnerFlag,
              ]),
          (result) => (result.error ? "failure" : "success"),
        );
        if (markFailedError) throw markFailedError;
      }
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
  changes: QualityFlagChanges,
  trace: TimingTrace,
  spanPrefix: string,
  expectedUserCorrected = false,
  expectedUpdatedAt?: string | null,
) {
  const flags = await mergeCurrentQualityFlags(
    supabase,
    closetItemId,
    changes,
    trace,
    `${spanPrefix}_flags_read`,
  );

  const { data, error } = await trace.measure(
    spanPrefix,
    () => {
      let update = supabase
        .from("closet_items")
        .update({
          image_quality_flags: flags,
          updated_at: new Date().toISOString(),
        })
        .eq("id", closetItemId)
        .eq("user_corrected", expectedUserCorrected)
        .not(
          "image_quality_flags",
          "cs",
          '{"closet_analysis_processing"}',
        );
      if (expectedUpdatedAt) update = update.eq("updated_at", expectedUpdatedAt);
      return update.select("id").maybeSingle();
    },
    (result) => (result.error || !result.data ? "failure" : "success"),
  );
  if (error) throw error;
  return Boolean(data);
}

async function mergeCurrentQualityFlags(
  supabase: SupabaseClient,
  closetItemId: string,
  changes: QualityFlagChanges,
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

  return mergeQualityFlags(
    data?.image_quality_flags ?? [],
    changes.add ?? [],
    changes.remove ?? [],
    changes.removePrefixes ?? [],
  );
}

function mergeQualityFlags(
  current: string[],
  add: string[],
  remove: string[],
  removePrefixes: string[],
) {
  const removeSet = new Set(remove);

  return Array.from(
    new Set([
      ...current.filter(
        (flag) =>
          flag &&
          !removeSet.has(flag) &&
          !removePrefixes.some((prefix) => flag.startsWith(prefix)),
      ),
      ...add.filter((flag) => flag && !removeSet.has(flag)),
    ]),
  );
}
