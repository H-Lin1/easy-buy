import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { buildPurchaseEmbeddingText } from "@/lib/ai/purchase-analysis";
import { embedText } from "@/lib/ai/providers";
import type {
  OutfitCombination,
  PurchaseCandidateAIProfile,
  UserStyleProfile,
} from "@/lib/ai/types";
import { runPurchaseAssessment } from "@/lib/ai/workflow";
import { appEnv } from "@/lib/env";
import { loadRealClosetItems } from "@/lib/server/closet-data";

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

const candidateSchema = z
  .object({
    productName: z.string().min(1),
    category: z.string().default("待买商品"),
    color: z.string().default("unknown"),
    secondaryColors: z.array(z.string()).optional(),
    fit: z.enum(["slim", "regular", "oversized", "unknown"]).default("unknown"),
    styleTags: z.array(z.string()).default([]),
    possibleScenarios: z.array(z.string()).default([]),
    estimatedPrice: z.number().optional(),
    detectedText: z.string().optional(),
    sellingPoints: z.array(z.string()).default([]),
    summary: z.string().default(""),
    embeddingText: z.string().optional(),
    aiConfidence: z.number().optional(),
    screenshotPath: z.string().optional(),
    screenshotUrl: z.string().optional(),
  })
  .passthrough();

const requestSchema = z.object({
  candidate: candidateSchema,
  previousOutfitCombinations: z.array(z.custom<OutfitCombination>()).default([]),
  userProfile: profileSchema,
});

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ message: "Missing auth token." }, { status: 401 });
  }

  if (!appEnv.supabaseUrl || !appEnv.supabaseAnonKey) {
    return NextResponse.json({ message: "Supabase is not configured." }, { status: 500 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      {
        message: "Invalid more outfit request.",
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
    const candidate = parsed.data.candidate as PurchaseCandidateAIProfile;
    const previousOutfitCombinations = parsed.data.previousOutfitCombinations;
    const candidateEmbeddingText = candidate.embeddingText ?? buildPurchaseEmbeddingText(candidate);
    const [candidateEmbedding, closetItems] = await Promise.all([
      embedText(candidateEmbeddingText),
      loadRealClosetItems(supabase),
    ]);

    const report = await runPurchaseAssessment({
      message:
        "请继续寻找更多真实搭配灵感。不要重复之前已经给出的搭配；如果没有自然的新组合，请返回空的 outfitCombinations，并说明没有新的可靠灵感。",
      userProfile: normalizeUserProfile(parsed.data.userProfile),
      candidate: {
        ...candidate,
        embeddingText: candidateEmbeddingText,
      },
      candidateEmbedding,
      closetItems,
      ideaMode: "more_inspiration",
      previousOutfitCombinations,
    });
    const newOutfits = getNovelOutfitCombinations(
      report.outfitCombinations,
      previousOutfitCombinations,
    );

    return NextResponse.json({
      outfitCombinations: report.usedModel ? newOutfits : [],
      message:
        report.usedModel && newOutfits.length
          ? `找到了 ${newOutfits.length} 套新的可靠搭配灵感。`
          : "暂时没有新的可靠搭配灵感。当前衣橱证据不足，或者新组合会比较牵强。",
      usedModel: report.usedModel,
      closetItemCount: closetItems.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "More outfit ideas failed.";
    console.error("[more-outfit-ideas] failed", { message });

    return NextResponse.json({ message }, { status: 500 });
  }
}

function getNovelOutfitCombinations(
  combinations: OutfitCombination[],
  previousCombinations: OutfitCombination[],
) {
  const previousKeys = new Set(previousCombinations.map(getOutfitKey).filter(Boolean));

  return combinations
    .filter((combination) => {
      const key = getOutfitKey(combination);
      if (!key || previousKeys.has(key)) return false;
      return (combination.visualItems?.length ?? 0) > 0;
    })
    .slice(0, 2);
}

function getOutfitKey(combination: OutfitCombination) {
  const ids =
    combination.closetItemIds?.length
      ? combination.closetItemIds
      : combination.visualItems?.map((item) => item.id);

  if (!ids?.length) return "";
  return [...new Set(ids)].sort().join("|");
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
