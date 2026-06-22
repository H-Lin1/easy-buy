import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  buildPurchaseAnalysisPrompt,
  buildPurchaseEmbeddingText,
  parsePurchaseAnalysisJson,
} from "@/lib/ai/purchase-analysis";
import { embedText, generateVisionJson, toPgVector } from "@/lib/ai/providers";
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
    const routeTrace: Array<{
      id: string;
      title: string;
      elapsedMs: number;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    }> = [];
    const screenshotPath = imageDataUrl
      ? await traceStep(routeTrace, "upload_purchase_screenshot", "保存待买商品截图", {
          hasImage: true,
          imageBytesApprox: getDataUrlByteLength(imageDataUrl),
        }, async () => {
          const path = await uploadPurchaseScreenshot(supabase, userData.user.id, imageDataUrl);
          return {
            value: path,
            output: {
              screenshotPath: path,
            },
          };
        })
      : undefined;
    const screenshotUrl = screenshotPath
      ? await createSignedImageUrl(supabase, "purchase-screenshots", screenshotPath)
      : undefined;
    const candidate = imageDataUrl
      ? await traceStep(routeTrace, "analyze_purchase_candidate", "识别待买商品截图", {
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
        })
      : await traceStep(routeTrace, "parse_candidate_from_message", "从文字描述理解待买商品", {
          message,
          hasImage: false,
        }, async () => {
          const result = stripUnsupportedPrice(
            {
              ...parseCandidateFromMessage(message),
              detectedText: message,
            },
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
          message: candidateInsertError.message,
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
    const message = error instanceof Error ? error.message : "Purchase assessment failed.";
    console.error("[purchase-assessment] failed", { message });

    return NextResponse.json({ message }, { status: 500 });
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
      message: error.message,
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

async function analyzePurchaseCandidateSafely(
  message: string,
  imageDataUrl: string,
  screenshotPath?: string,
  screenshotUrl?: string,
) {
  try {
    return {
      ...parsePurchaseAnalysisJson(
        await generateVisionJson(
          buildPurchaseAnalysisPrompt({ userIntent: message }),
          [imageDataUrl],
        ),
      ),
      screenshotPath,
      screenshotUrl,
    };
  } catch (error) {
    console.warn("[purchase-assessment] vision analysis skipped", {
      message: error instanceof Error ? error.message : "Vision analysis failed.",
    });

    const fallbackCandidate = parseCandidateFromMessage(message || "待买商品");
    return {
      ...fallbackCandidate,
      screenshotPath,
      screenshotUrl,
      summary: `${fallbackCandidate.summary} 商品截图识别暂时失败，本次先根据文字描述和衣橱信息做保守判断。`,
      aiConfidence: 0.45,
    };
  }
}

function stripUnsupportedPrice<T extends { estimatedPrice?: number; detectedText?: string }>(
  candidate: T,
  message: string,
) {
  if (!candidate.estimatedPrice) return candidate;
  const evidenceText = [message, candidate.detectedText].filter(Boolean).join(" ");
  const hasExplicitPrice = /(?:[¥￥]\s*\d{2,5}|\d{2,5}\s*元|价格\s*[:：]?\s*\d{2,5}|售价\s*[:：]?\s*\d{2,5}|到手\s*[:：]?\s*\d{2,5}|券后\s*[:：]?\s*\d{2,5})/.test(
    evidenceText,
  );

  if (hasExplicitPrice) return candidate;

  return {
    ...candidate,
    estimatedPrice: undefined,
  };
}

async function uploadPurchaseScreenshot(
  supabase: SupabaseClient,
  userId: string,
  imageDataUrl: string,
) {
  const image = parseImageDataUrl(imageDataUrl);
  const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/webp" ? "webp" : "jpg";
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from("purchase-screenshots").upload(path, image.buffer, {
    cacheControl: "3600",
    contentType: image.mimeType,
    upsert: false,
  });

  if (error) throw error;
  return path;
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

function parseImageDataUrl(imageDataUrl: string) {
  const match = imageDataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/);
  if (!match) {
    throw new Error("商品截图格式不支持，请上传 JPG、PNG 或 WebP。");
  }

  return {
    mimeType: match[1] === "image/jpg" ? "image/jpeg" : match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function getDataUrlByteLength(imageDataUrl: string) {
  const base64 = imageDataUrl.split(",", 2)[1] ?? "";
  return Math.round((base64.length * 3) / 4);
}
