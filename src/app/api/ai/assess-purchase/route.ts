import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  buildPurchaseEmbeddingText,
} from "@/lib/ai/purchase-analysis";
import {
  embedText,
  generateImageRequiredGuidance,
  sanitizeAiErrorMessage,
  toPgVector,
} from "@/lib/ai/providers";
import {
  analyzePurchaseCandidateSafely,
  getDataUrlByteLength,
  stripUnsupportedPrice,
  uploadPurchaseScreenshot,
} from "@/lib/ai/purchase-candidate-server";
import {
  hasPurchaseImage,
  IMAGE_REQUIRED_FALLBACK_MESSAGE,
} from "@/lib/ai/image-required-guidance";
import type { UserStyleProfile } from "@/lib/ai/types";
import {
  parseCandidateFromMessage,
  runPurchaseAssessment,
  runPurchaseAssessmentTrace,
} from "@/lib/ai/workflow";
import { appEnv } from "@/lib/env";
import { createSignedImageUrl, loadRealClosetItems } from "@/lib/server/closet-data";

export const runtime = "nodejs";

const profileSchema = z
  .object({
    heightCm: z.number().nullable().optional(),
    weightKg: z.number().nullable().optional(),
    bmi: z.number().nullable().optional(),
    stylePreferences: z.array(z.string()).optional(),
    commonScenarios: z.array(z.string()).optional(),
    budgetSensitivity: z.enum(["low", "medium", "high"]).optional(),
  })
  .optional();

const requestSchema = z
  .object({
    message: z.string().max(1200).default(""),
    imageDataUrl: z.string().startsWith("data:image/").optional(),
    sessionId: z.string().uuid().optional(),
    userProfile: profileSchema,
    trace: z.boolean().optional(),
  })
  .refine((value) => value.message.trim() || value.imageDataUrl, {
    message: "Message or image is required.",
  });

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
      {
        message: "Invalid assessment request.",
        issues: parsed.error.issues,
      },
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

  try {
    const { message, imageDataUrl, sessionId, trace: shouldTrace } = parsed.data;
    if (!hasPurchaseImage(imageDataUrl)) {
      let guidance = IMAGE_REQUIRED_FALLBACK_MESSAGE;
      try {
        guidance = await generateImageRequiredGuidance(message);
      } catch (error) {
        console.warn("[purchase-assessment] image guidance fallback used", {
          message: sanitizeAiErrorMessage(error),
        });
      }

      return NextResponse.json({
        mode: "image_required" as const,
        message: guidance,
      });
    }

    const routeTrace: Array<{
      id: string;
      title: string;
      elapsedMs: number;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    }> = [];
    const screenshotPath = await traceStep(routeTrace, "upload_purchase_screenshot", "保存待买商品截图", {
          hasImage: true,
          imageBytesApprox: getDataUrlByteLength(imageDataUrl),
        }, async () => {
          const { path } = await uploadPurchaseScreenshot(
            supabase,
            userData.user.id,
            imageDataUrl,
          );
          return {
            value: path,
            output: {
              screenshotPath: path,
            },
          };
        });
    const screenshotUrl = await createSignedImageUrl(
      supabase,
      "purchase-screenshots",
      screenshotPath,
    );
    const candidate = await traceStep(routeTrace, "analyze_purchase_candidate", "识别待买商品截图", {
          message,
          hasImage: true,
          screenshotPath,
        }, async () => {
          const result = stripUnsupportedPrice(
            await analyzePurchaseCandidateSafely(message, imageDataUrl, screenshotPath, screenshotUrl),
            message,
          );
          return {
            value: result,
            output: {
              candidate: sanitizeCandidateForTrace(result),
            },
          };
        });
    const candidateEmbeddingText =
      candidate.embeddingText ?? buildPurchaseEmbeddingText(candidate);
    const candidateEmbedding = await traceStep(routeTrace, "embed_purchase_candidate", "生成待买商品向量", {
      embeddingText: candidateEmbeddingText,
    }, async () => {
      const result = await embedText(candidateEmbeddingText);
      return {
        value: result,
        output: {
          dimensions: result.length,
          preview: result.slice(0, 8).map((value) => Number(value.toFixed(6))),
        },
      };
    });
    let candidateId: string | undefined;

    if (screenshotPath) {
      const { data: candidateRow, error: candidateInsertError } = await supabase
        .from("purchase_candidates")
        .insert({
          user_id: userData.user.id,
          session_id: sessionId,
          screenshot_path: screenshotPath,
          user_intent: message,
          product_name: candidate.productName,
          category: candidate.category,
          color: candidate.color,
          secondary_colors: candidate.secondaryColors ?? [],
          fit: candidate.fit,
          style_tags: candidate.styleTags,
          estimated_price: candidate.estimatedPrice,
          detected_text: candidate.detectedText,
          selling_points: candidate.sellingPoints,
          possible_scenarios: candidate.possibleScenarios,
          summary: candidate.summary,
          embedding_text: candidateEmbeddingText,
          embedding: toPgVector(candidateEmbedding),
          ai_confidence: candidate.aiConfidence,
        })
        .select("id")
        .single();

      if (candidateInsertError) {
        console.warn("[purchase-assessment] candidate persistence skipped", {
          message: sanitizeAiErrorMessage(candidateInsertError),
        });
      } else {
        candidateId = candidateRow?.id;
      }
    }

    const closetItems = await traceStep(routeTrace, "load_real_closet", "读取真实衣橱数据", {
      limit: 120,
      filter: "status != archived, category 已识别",
    }, async () => {
      const result = await loadRealClosetItems(supabase);
      return {
        value: result,
        output: {
          closetItemCount: result.length,
          sampleItems: result.slice(0, 10).map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category,
            color: item.color,
            fit: item.fit,
            styleTags: item.styleTags,
            scenarioTags: item.scenarioTags,
            wearFrequency: item.wearFrequency,
            hasEmbedding: Boolean(item.embedding?.length),
          })),
        },
      };
    });
    const assessmentRequest = {
      message,
      imageDataUrl,
      userProfile: normalizeUserProfile(parsed.data.userProfile),
      candidate: {
        ...candidate,
        embeddingText: candidateEmbeddingText,
      },
      candidateEmbedding,
      closetItems,
    };
    const assessmentResult = shouldTrace
      ? await runPurchaseAssessmentTrace(assessmentRequest)
      : { report: await runPurchaseAssessment(assessmentRequest), trace: undefined };
    const report = assessmentResult.report;
    const reportId = await persistAssessmentReport(supabase, {
      userId: userData.user.id,
      sessionId,
      candidateId,
      report,
    });

    return NextResponse.json({
      mode: "assessment" as const,
      report,
      candidateId,
      reportId,
      closetItemCount: closetItems.length,
      ...(shouldTrace
        ? {
            trace: {
              generatedAt: new Date().toISOString(),
              routeSteps: routeTrace,
              workflowSteps: assessmentResult.trace,
            },
          }
        : {}),
    });
  } catch (error) {
    console.error("[purchase-assessment] failed", { message: sanitizeAiErrorMessage(error) });

    return NextResponse.json({ message: "Purchase assessment failed." }, { status: 500 });
  }
}

async function persistAssessmentReport(
  supabase: SupabaseClient,
  {
    userId,
    sessionId,
    candidateId,
    report,
  }: {
    userId: string;
    sessionId?: string;
    candidateId?: string;
    report: Awaited<ReturnType<typeof runPurchaseAssessment>>;
  },
) {
  if (!candidateId) return undefined;

  const { data, error } = await supabase
    .from("assessment_reports")
    .insert({
      user_id: userId,
      session_id: sessionId,
      candidate_id: candidateId,
      decision: report.decision,
      decision_label: report.decisionLabel,
      scores: report.scores,
      summary: report.summary,
      styling_inspirations: report.outfitCombinations.map((item) => item.summary).slice(0, 3),
      reasons_to_buy: report.reasonsToBuy,
      reasons_to_save: report.reasonsToSave,
      risks: report.risks,
      body_fit_notes: report.bodyFitNotes,
      outfit_combinations: report.outfitCombinations,
      alternatives_from_closet: [],
      retrieved_context: {
        closetMatches: report.retrievedClosetItems.map((match) => ({
          itemId: match.item.id,
          matchType: match.matchType,
          score: match.score,
          reason: match.reason,
        })),
        knowledgeSnippets: report.knowledgeSnippets,
        usedModel: report.usedModel,
      },
      safety_checked: true,
    })
    .select("id")
    .single();

  if (error) {
    console.warn("[purchase-assessment] report persistence skipped", {
      message: sanitizeAiErrorMessage(error),
    });
    return undefined;
  }

  return data?.id as string | undefined;
}

async function traceStep<T>(
  steps: Array<{
    id: string;
    title: string;
    elapsedMs: number;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }>,
  id: string,
  title: string,
  input: Record<string, unknown>,
  runner: () => Promise<{ value: T; output: Record<string, unknown> }>,
) {
  const startedAt = Date.now();
  const result = await runner();
  steps.push({
    id,
    title,
    elapsedMs: Date.now() - startedAt,
    input,
    output: result.output,
  });
  return result.value;
}

function sanitizeCandidateForTrace(candidate: ReturnType<typeof parseCandidateFromMessage>) {
  return {
    productName: candidate.productName,
    category: candidate.category,
    categoryGroup: candidate.categoryGroup,
    itemCategoryId: candidate.itemCategoryId,
    color: candidate.color,
    secondaryColors: candidate.secondaryColors,
    fit: candidate.fit,
    styleTags: candidate.styleTags,
    possibleScenarios: candidate.possibleScenarios,
    estimatedPrice: candidate.estimatedPrice,
    sellingPoints: candidate.sellingPoints,
    wearRole: candidate.wearRole,
    retrievalSlots: candidate.retrievalSlots,
    retrievalSlotReason: candidate.retrievalSlotReason,
    avoidSlots: candidate.avoidSlots,
    ambiguityFlags: candidate.ambiguityFlags,
    summary: candidate.summary,
    embeddingText: candidate.embeddingText,
    aiConfidence: candidate.aiConfidence,
    screenshotPath: candidate.screenshotPath,
    hasScreenshotUrl: Boolean(candidate.screenshotUrl),
  };
}

function normalizeUserProfile(profile: z.infer<typeof profileSchema>): UserStyleProfile | undefined {
  if (!profile) return undefined;

  return {
    heightCm: profile.heightCm ?? undefined,
    weightKg: profile.weightKg ?? undefined,
    bmi: profile.bmi ?? undefined,
    stylePreferences: profile.stylePreferences,
    commonScenarios: profile.commonScenarios,
    budgetSensitivity: profile.budgetSensitivity,
  };
}
