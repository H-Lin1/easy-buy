import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildPurchaseAnalysisPrompt,
  parsePurchaseAnalysisJson,
} from "@/lib/ai/purchase-analysis";
import { generateVisionJson, sanitizeAiErrorMessage } from "@/lib/ai/providers";
import type { PurchaseCandidateAIProfile } from "@/lib/ai/types";
import { parseCandidateFromMessage } from "@/lib/ai/workflow";

export async function analyzePurchaseCandidateSafely(
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
    } satisfies PurchaseCandidateAIProfile;
  } catch (error) {
    console.warn("[purchase-assessment] vision analysis skipped", {
      message: sanitizeAiErrorMessage(error),
    });

    const fallbackCandidate = parseCandidateFromMessage(message || "待买商品");
    return {
      ...fallbackCandidate,
      screenshotPath,
      screenshotUrl,
      summary: `${fallbackCandidate.summary} 商品截图识别暂时失败，本次先根据文字描述和衣橱信息做保守判断。`,
      aiConfidence: 0.45,
    } satisfies PurchaseCandidateAIProfile;
  }
}

export function stripUnsupportedPrice<
  T extends { estimatedPrice?: number; detectedText?: string },
>(candidate: T, message: string) {
  if (!candidate.estimatedPrice) return candidate;
  const evidenceText = [message, candidate.detectedText].filter(Boolean).join(" ");
  const hasExplicitPrice =
    /(?:[¥￥]\s*\d{2,5}|\d{2,5}\s*元|价格\s*[:：]?\s*\d{2,5}|售价\s*[:：]?\s*\d{2,5}|到手\s*[:：]?\s*\d{2,5}|券后\s*[:：]?\s*\d{2,5})/.test(
      evidenceText,
    );

  return hasExplicitPrice
    ? candidate
    : {
        ...candidate,
        estimatedPrice: undefined,
      };
}

export async function uploadPurchaseScreenshot(
  supabase: SupabaseClient,
  userId: string,
  imageDataUrl: string,
  pathPrefix = userId,
) {
  const image = parsePurchaseImageDataUrl(imageDataUrl);
  const extension = extensionForPurchaseImage(image.mimeType);
  const path = `${pathPrefix}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from("purchase-screenshots")
    .upload(path, image.buffer, {
      cacheControl: "3600",
      contentType: image.mimeType,
      upsert: false,
    });

  if (error) throw error;
  return { path, mimeType: image.mimeType };
}

export function parsePurchaseImageDataUrl(imageDataUrl: string) {
  const match = imageDataUrl.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match) {
    throw new Error("商品截图格式不支持，请上传 JPG、PNG 或 WebP。");
  }

  const mimeType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
    throw new Error("商品截图大小必须在 8MB 以内。");
  }

  return { mimeType, buffer };
}

export function getDataUrlByteLength(imageDataUrl: string) {
  const base64 = imageDataUrl.split(",", 2)[1] ?? "";
  return Math.round((base64.length * 3) / 4);
}

function extensionForPurchaseImage(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}
