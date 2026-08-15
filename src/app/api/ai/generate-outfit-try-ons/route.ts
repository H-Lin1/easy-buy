import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";

import {
  createImageDataUrlFromBytes,
  decodeImageEditBase64,
  extractImageEditOutput,
  createImageEditRequestInit,
  type ImageEditOutput,
} from "@/lib/ai/image-provider";
import {
  getEligibleTryOnOutfits,
  needsTryOnGeneration,
  settleTryOnJobs,
} from "@/lib/ai/outfit-try-on";
import {
  buildOutfitTryOnNegativePrompt,
  buildOutfitTryOnPrompt,
  OUTFIT_TRY_ON_PROMPT_VERSION,
} from "@/lib/ai/outfit-try-on-prompt";
import {
  createImageEditRequest,
  getAiCapabilityConfig,
  hasImageEditConfig,
  sanitizeAiErrorMessage,
} from "@/lib/ai/providers";
import type {
  OutfitCombination,
  OutfitTryOnBatch,
  PurchaseCandidateAIProfile,
} from "@/lib/ai/types";
import { appEnv } from "@/lib/env";

export const runtime = "nodejs";

const requestSchema = z.object({
  reportId: z.string().uuid(),
});

type AssessmentReportRow = {
  id: string;
  user_id: string;
  candidate_id: string;
  outfit_combinations: unknown;
  retrieved_context: unknown;
};

type CandidateRow = {
  id: string;
  screenshot_path: string;
  product_name: string | null;
  category: string | null;
  color: string | null;
};

type ClosetSourceRow = {
  id: string;
  image_path: string;
  processed_image_path: string | null;
  display_image_path: string | null;
};

type TryOnRow = {
  id: string;
  outfit_id: string;
  position: number;
  closet_item_ids: string[];
  image_path: string | null;
  status: "pending" | "processing" | "ready" | "failed";
  failure_kind: string | null;
};

type TryOnTask = {
  outfit: OutfitCombination & { outfitId: string };
  position: number;
  row: TryOnRow;
};

const tryOnRowSelect =
  "id,outfit_id,position,closet_item_ids,image_path,status,failure_kind";
const modelReferencePath = path.join(
  process.cwd(),
  "public/images/outfit-try-on-model-reference.png",
);

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
      { message: "Invalid outfit try-on request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = createClient(appEnv.supabaseUrl, appEnv.supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.slice("Bearer ".length);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return NextResponse.json({ message: "Invalid auth token." }, { status: 401 });
  }

  try {
    const report = await loadOwnedReport(supabase, parsed.data.reportId, userData.user.id);
    if (!report) {
      return NextResponse.json({ message: "Assessment report not found." }, { status: 404 });
    }

    const candidate = await loadCandidate(supabase, report.candidate_id);
    if (!candidate) {
      return NextResponse.json(createUnavailableBatch("缺少待买商品截图，暂时无法生成真人搭配。"));
    }

    const reportOutfits = parseOutfitCombinations(report.outfit_combinations);
    const usedModel = readUsedModel(report.retrieved_context);
    const eligibleOutfits = getEligibleTryOnOutfits(
      { usedModel, outfitCombinations: reportOutfits },
      Boolean(candidate.screenshot_path),
    ) as Array<OutfitCombination & { outfitId: string }>;

    if (!eligibleOutfits.length) {
      return NextResponse.json(createUnavailableBatch("当前没有足够可靠的真实搭配依据。"));
    }

    await ensureTryOnRows(
      supabase,
      userData.user.id,
      report.id,
      eligibleOutfits,
    );
    const initialRows = await loadTryOnRows(supabase, report.id);
    const initialRowsByOutfitId = new Map(initialRows.map((row) => [row.outfit_id, row]));
    const tasks = eligibleOutfits.map((outfit, position) => ({
      outfit,
      position,
      row: requireTryOnRow(initialRowsByOutfitId.get(outfit.outfitId)),
    }));

    if (!tasks.every((task) => !needsTryOnGeneration({ status: task.row.status, imagePath: task.row.image_path }))) {
      if (!hasImageEditConfig()) {
        await markUnreadyRowsFailed(supabase, tasks, "image_edit_not_configured");
      } else {
        const imageEditConfig = getAiCapabilityConfig("imageEdit");
        if (!imageEditConfig.model) {
          await markUnreadyRowsFailed(supabase, tasks, "image_edit_model_missing");
        } else {
          const sourceIds = Array.from(
            new Set(tasks.flatMap((task) => task.outfit.closetItemIds ?? [])),
          );
          const [candidateImage, modelImage, closetSources] = await Promise.all([
            downloadStorageImage(supabase, "purchase-screenshots", candidate.screenshot_path),
            readFile(modelReferencePath),
            loadClosetSources(supabase, sourceIds),
          ]);
          const closetSourcesById = new Map(closetSources.map((source) => [source.id, source]));

          await settleTryOnJobs(
            tasks.map((task) => () =>
              !needsTryOnGeneration({ status: task.row.status, imagePath: task.row.image_path })
                ? Promise.resolve()
                : generateTryOn({
                    supabase,
                    userId: userData.user.id,
                    candidate,
                    candidateImage,
                    modelImage,
                    closetSourcesById,
                    task,
                    requestSignal: request.signal,
                    model: imageEditConfig.model as string,
                  }),
            ),
          );
        }
      }
    }

    const finalRows = await loadTryOnRows(supabase, report.id);
    return NextResponse.json(
      await createBatchResponse(supabase, eligibleOutfits, finalRows),
    );
  } catch (error) {
    console.error("[outfit-try-on] route failed", {
      reportId: parsed.data.reportId,
      message: sanitizeAiErrorMessage(error),
    });
    return NextResponse.json(
      { message: "Outfit try-on generation failed." },
      { status: 500 },
    );
  }
}

async function loadOwnedReport(
  supabase: SupabaseClient,
  reportId: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from("assessment_reports")
    .select("id,user_id,candidate_id,outfit_combinations,retrieved_context")
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as AssessmentReportRow | null;
}

async function loadCandidate(supabase: SupabaseClient, candidateId: string) {
  const { data, error } = await supabase
    .from("purchase_candidates")
    .select("id,screenshot_path,product_name,category,color")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  return data as CandidateRow | null;
}

function parseOutfitCombinations(value: unknown): OutfitCombination[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const closetItemIds = Array.isArray(entry.closetItemIds)
      ? entry.closetItemIds.filter((id): id is string => typeof id === "string")
      : [];
    const items = Array.isArray(entry.items)
      ? entry.items.filter((item): item is string => typeof item === "string")
      : [];

    return [{
      outfitId: typeof entry.outfitId === "string" ? entry.outfitId : undefined,
      title: typeof entry.title === "string" ? entry.title : "日常搭配",
      scenario: typeof entry.scenario === "string" ? entry.scenario : "日常",
      summary: typeof entry.summary === "string" ? entry.summary : "",
      items,
      closetItemIds,
      visualIntent: entry.visualIntent === "outfit" ? "outfit" : undefined,
    } satisfies OutfitCombination];
  });
}

function readUsedModel(value: unknown) {
  return isRecord(value) && value.usedModel === true;
}

async function ensureTryOnRows(
  supabase: SupabaseClient,
  userId: string,
  reportId: string,
  outfits: Array<OutfitCombination & { outfitId: string }>,
) {
  const { error } = await supabase.from("outfit_try_on_images").upsert(
    outfits.map((outfit, position) => ({
      user_id: userId,
      report_id: reportId,
      outfit_id: outfit.outfitId,
      position,
      closet_item_ids: outfit.closetItemIds ?? [],
      status: "pending",
    })),
    { onConflict: "report_id,outfit_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

async function loadTryOnRows(supabase: SupabaseClient, reportId: string) {
  const { data, error } = await supabase
    .from("outfit_try_on_images")
    .select(tryOnRowSelect)
    .eq("report_id", reportId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TryOnRow[];
}

async function loadClosetSources(supabase: SupabaseClient, ids: string[]) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("closet_items")
    .select("id,image_path,processed_image_path,display_image_path")
    .in("id", ids);
  if (error) throw error;
  return (data ?? []) as ClosetSourceRow[];
}

async function generateTryOn({
  supabase,
  userId,
  candidate,
  candidateImage,
  modelImage,
  closetSourcesById,
  task,
  requestSignal,
  model,
}: {
  supabase: SupabaseClient;
  userId: string;
  candidate: CandidateRow;
  candidateImage: Buffer;
  modelImage: Buffer;
  closetSourcesById: Map<string, ClosetSourceRow>;
  task: TryOnTask;
  requestSignal: AbortSignal;
  model: string;
}) {
  const { data: claimedRow, error: claimError } = await supabase
    .from("outfit_try_on_images")
    .update({ status: "processing", failure_kind: null, updated_at: new Date().toISOString() })
    .eq("id", task.row.id)
    .in("status", ["pending", "failed"])
    .select("id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimedRow) throw new Error("try_on_generation_not_claimed");

  let uploadedPath: string | undefined;
  try {
    const closetImages = await Promise.all(
      (task.outfit.closetItemIds ?? []).map(async (itemId) => {
        const source = closetSourcesById.get(itemId);
        if (!source) throw new Error(`closet_source_not_found:${itemId}`);
        const imagePath = source.display_image_path ?? source.processed_image_path ?? source.image_path;
        return downloadStorageImage(supabase, "closet-images", imagePath);
      }),
    );
    const referenceImages = [modelImage, candidateImage, ...closetImages].map(
      createImageDataUrlFromBytes,
    );
    const imageOutput = await callImageEdit(
      referenceImages,
      buildOutfitTryOnPrompt(toPromptCandidate(candidate), task.outfit),
      buildOutfitTryOnNegativePrompt(),
      requestSignal,
    );
    const generated = await resolveGeneratedImage(imageOutput);
    const imagePath = `${userId}/try-ons/${crypto.randomUUID()}${generated.extension}`;
    const { error: uploadError } = await supabase.storage
      .from("purchase-screenshots")
      .upload(imagePath, generated.fileBody, {
        cacheControl: "3600",
        contentType: generated.contentType,
        upsert: false,
      });
    if (uploadError) throw uploadError;
    uploadedPath = imagePath;

    const { data: committedRow, error: commitError } = await supabase
      .from("outfit_try_on_images")
      .update({
        image_path: imagePath,
        status: "ready",
        model,
        prompt_version: OUTFIT_TRY_ON_PROMPT_VERSION,
        failure_kind: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.row.id)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (commitError) throw commitError;
    if (!committedRow) throw new Error("try_on_commit_not_owned");
  } catch (error) {
    if (uploadedPath) {
      await supabase.storage.from("purchase-screenshots").remove([uploadedPath]);
    }
    await supabase
      .from("outfit_try_on_images")
      .update({
        status: "failed",
        failure_kind: describeTryOnFailure(error),
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.row.id)
      .eq("status", "processing");
    throw error;
  }
}

async function markUnreadyRowsFailed(
  supabase: SupabaseClient,
  tasks: TryOnTask[],
  failureKind: string,
) {
  const rowIds = tasks
    .filter((task) => task.row.status !== "ready" || !task.row.image_path)
    .map((task) => task.row.id);
  if (!rowIds.length) return;
  const { error } = await supabase
    .from("outfit_try_on_images")
    .update({
      status: "failed",
      failure_kind: failureKind,
      updated_at: new Date().toISOString(),
    })
    .in("id", rowIds);
  if (error) throw error;
}

async function createBatchResponse(
  supabase: SupabaseClient,
  outfits: Array<OutfitCombination & { outfitId: string }>,
  rows: TryOnRow[],
): Promise<OutfitTryOnBatch> {
  const rowsByOutfitId = new Map(rows.map((row) => [row.outfit_id, row]));
  const orderedRows = outfits.map((outfit) => requireTryOnRow(rowsByOutfitId.get(outfit.outfitId)));
  const allReady = orderedRows.every((row) => row.status === "ready" && row.image_path);

  if (!allReady) {
    return {
      status: "failed",
      message: "部分真人搭配生成失败，可以重试未完成的方案。",
      outfits: orderedRows.map((row) => ({
        outfitId: row.outfit_id,
        position: row.position,
        closetItemIds: row.closet_item_ids,
        status: row.status === "ready" && row.image_path ? "ready" : "failed",
        failureKind: row.failure_kind ?? (row.status === "processing" ? "generation_in_progress" : "generation_failed"),
      })),
    };
  }

  const signedUrls = await Promise.all(
    orderedRows.map(async (row) => {
      const { data, error } = await supabase.storage
        .from("purchase-screenshots")
        .createSignedUrl(row.image_path as string, 60 * 60);
      if (error || !data.signedUrl) throw error ?? new Error("try_on_signed_url_missing");
      return data.signedUrl;
    }),
  );

  return {
    status: "ready",
    outfits: orderedRows.map((row, position) => ({
      outfitId: row.outfit_id,
      position: row.position,
      closetItemIds: row.closet_item_ids,
      status: "ready",
      imageUrl: signedUrls[position],
    })),
  };
}

async function downloadStorageImage(
  supabase: SupabaseClient,
  bucket: "purchase-screenshots" | "closet-images",
  imagePath: string,
) {
  const { data, error } = await supabase.storage.from(bucket).download(imagePath);
  if (error || !data) throw error ?? new Error("storage_image_missing");
  return Buffer.from(await data.arrayBuffer());
}

async function callImageEdit(
  imageDataUrls: string[],
  prompt: string,
  negativePrompt: string,
  requestSignal: AbortSignal,
): Promise<ImageEditOutput> {
  const imageEditRequest = createImageEditRequest(imageDataUrls, prompt, negativePrompt);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), imageEditRequest.timeoutMs);
  const abortProviderRequest = () => controller.abort();
  requestSignal.addEventListener("abort", abortProviderRequest, { once: true });
  if (requestSignal.aborted) controller.abort();

  try {
    const response = await fetch(imageEditRequest.endpoint, {
      ...createImageEditRequestInit(imageEditRequest),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`provider_request_failed:${response.status}`);
    const payload = (await response.json()) as unknown;
    const output = extractImageEditOutput(payload);
    if (!output) throw new Error("missing_image_output");
    return output;
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", abortProviderRequest);
  }
}

async function resolveGeneratedImage(output: ImageEditOutput) {
  if (output.kind === "base64") return decodeImageEditBase64(output.value);

  const response = await fetch(output.value);
  if (!response.ok) throw new Error(`generated_image_download_failed:${response.status}`);
  const fileBody = Buffer.from(await response.arrayBuffer());
  const metadata = await sharp(fileBody).metadata();
  const format = metadata.format;
  if (format !== "png" && format !== "jpeg" && format !== "webp") {
    throw new Error("generated_image_format_invalid");
  }
  return {
    fileBody,
    contentType: format === "jpeg" ? "image/jpeg" : `image/${format}`,
    extension: format === "jpeg" ? ".jpg" : `.${format}`,
  };
}

function toPromptCandidate(candidate: CandidateRow): PurchaseCandidateAIProfile {
  return {
    productName: candidate.product_name ?? "待买商品",
    category: candidate.category ?? "衣服",
    color: candidate.color ?? "以参考图为准",
    fit: "unknown",
    styleTags: [],
    possibleScenarios: [],
    sellingPoints: [],
    summary: "",
  };
}

function createUnavailableBatch(message: string): OutfitTryOnBatch {
  return { status: "unavailable", outfits: [], message };
}

function requireTryOnRow(row: TryOnRow | undefined) {
  if (!row) throw new Error("try_on_row_missing");
  return row;
}

function describeTryOnFailure(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "provider_timeout";
  if (error instanceof Error) return error.message.slice(0, 120);
  return "image_generation_or_storage_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
