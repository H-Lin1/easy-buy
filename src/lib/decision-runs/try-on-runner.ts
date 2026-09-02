import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

import {
  createImageDataUrlFromBytes,
  createImageEditRequestInit,
  decodeImageEditBase64,
  extractImageEditOutput,
  type ImageEditOutput,
} from "@/lib/ai/image-provider";
import {
  getEligibleTryOnOutfits,
  MAX_TRY_ON_ATTEMPTS,
  needsTryOnGeneration,
  settleTryOnJobs,
  shouldRetryTryOn,
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
} from "@/lib/ai/providers";
import type {
  OutfitCombination,
  OutfitTryOnBatch,
  PurchaseCandidateAIProfile,
} from "@/lib/ai/types";
import type { DecisionRunRow } from "@/lib/decision-runs/model";

type AssessmentReportRow = {
  id: string;
  user_id: string;
  candidate_id: string;
  decision_run_id: string | null;
  outfit_combinations: unknown;
  retrieved_context: unknown;
};

type CandidateRow = {
  id: string;
  user_id: string;
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

export type PersistedTryOnRow = {
  id: string;
  outfit_id: string;
  position: number;
  closet_item_ids: string[];
  image_path: string | null;
  status: "pending" | "processing" | "ready" | "failed" | "cancelled";
  failure_kind: string | null;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: string | null;
};

type TryOnTask = {
  outfit: OutfitCombination & { outfitId: string };
  position: number;
  row: PersistedTryOnRow;
};

type LeaseCallbacks = {
  assertLease: () => Promise<void>;
  renewLease: () => Promise<void>;
};

const tryOnRowSelect =
  "id,outfit_id,position,closet_item_ids,image_path,status,failure_kind,attempt_count,lease_token,lease_expires_at";
const modelReferencePath = path.join(
  process.cwd(),
  "public/images/outfit-try-on-model-reference.png",
);
const childLeaseDurationMs = 10 * 60 * 1000;

export async function generatePersistedDecisionRunTryOns(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  lease: LeaseCallbacks,
) {
  if (!run.report_id || !run.lease_token) {
    throw new Error("decision_run_try_on_context_missing");
  }

  const report = await loadReport(supabase, run.report_id, run.user_id);
  if (!report || report.decision_run_id !== run.id) {
    throw new Error("decision_run_report_not_found");
  }
  const candidate = await loadCandidate(supabase, report.candidate_id, run.user_id);
  if (!candidate) throw new Error("decision_run_candidate_not_found");

  const outfits = getEligibleTryOnOutfits(
    {
      usedModel: readUsedModel(report.retrieved_context),
      outfitCombinations: parseOutfitCombinations(report.outfit_combinations),
    },
    Boolean(candidate.screenshot_path),
  ) as Array<OutfitCombination & { outfitId: string }>;

  if (!outfits.length) return { attempted: 0, ready: 0, failed: 0 };

  await lease.assertLease();
  await ensureTryOnRows(supabase, run, report.id, outfits);
  await recoverRowsOwnedByOlderRunLease(supabase, run);

  let tasks: TryOnTask[] = [];
  let candidateImage: Buffer | undefined;
  let modelImage: Buffer | undefined;
  let closetSourcesById = new Map<string, ClosetSourceRow>();
  let imageEditModel: string | undefined;

  for (let attempt = 0; attempt < MAX_TRY_ON_ATTEMPTS; attempt += 1) {
    const currentRows = await loadTryOnRows(supabase, report.id);
    const rowsByOutfitId = new Map(currentRows.map((row) => [row.outfit_id, row]));
    tasks = outfits.map((outfit, position) => ({
      outfit,
      position,
      row: requireTryOnRow(rowsByOutfitId.get(outfit.outfitId)),
    }));
    const pendingTasks = tasks.filter((task) => {
      const row = {
        status: task.row.status,
        imagePath: task.row.image_path,
      };
      return attempt === 0 ? needsTryOnGeneration(row) : shouldRetryTryOn(attempt - 1, row);
    });

    if (!pendingTasks.length) break;

    await lease.renewLease();
    if (!hasImageEditConfig() || !getAiCapabilityConfig("imageEdit").model) {
      await settleTryOnJobs(
        pendingTasks.map((task) => () =>
          failTryOnWithoutProvider(supabase, run, task, lease),
        ),
      );
      continue;
    }

    const imageEditConfig = getAiCapabilityConfig("imageEdit");
    if (!candidateImage || !modelImage || !imageEditModel) {
      imageEditModel = imageEditConfig.model as string;
      const sourceIds = Array.from(
        new Set(pendingTasks.flatMap((task) => task.outfit.closetItemIds ?? [])),
      );
      [candidateImage, modelImage] = await Promise.all([
        downloadStorageImage(
          supabase,
          "purchase-screenshots",
          candidate.screenshot_path,
        ),
        readFile(modelReferencePath),
      ]);
      const closetSources = await loadClosetSources(supabase, run.user_id, sourceIds);
      closetSourcesById = new Map(closetSources.map((source) => [source.id, source]));
    }

    await settleTryOnJobs(
      pendingTasks.map((task) => () =>
        generateTryOn({
          supabase,
          run,
          candidate,
          candidateImage: candidateImage as Buffer,
          modelImage: modelImage as Buffer,
          closetSourcesById,
          task,
          model: imageEditModel as string,
          lease,
        }),
      ),
    );
  }

  const finalRows = await loadTryOnRows(supabase, report.id);
  return {
    attempted: tasks.length,
    ready: finalRows.filter((row) => row.status === "ready" && row.image_path).length,
    failed: finalRows.filter((row) => row.status === "failed").length,
  };
}

export async function readPersistedDecisionRunTryOnBatch(
  supabase: SupabaseClient,
  report: AssessmentReportRow,
): Promise<OutfitTryOnBatch> {
  const candidate = await loadCandidate(supabase, report.candidate_id, report.user_id);
  if (!candidate) {
    return createUnavailableBatch("缺少待买商品截图，暂时无法生成真人搭配。");
  }

  const outfits = getEligibleTryOnOutfits(
    {
      usedModel: readUsedModel(report.retrieved_context),
      outfitCombinations: parseOutfitCombinations(report.outfit_combinations),
    },
    Boolean(candidate.screenshot_path),
  ) as Array<OutfitCombination & { outfitId: string }>;
  if (!outfits.length) {
    return createUnavailableBatch("当前没有足够可靠的真实搭配依据。");
  }

  const [rowsResult, runResult] = await Promise.all([
    supabase
      .from("outfit_try_on_images")
      .select(tryOnRowSelect)
      .eq("report_id", report.id)
      .order("position", { ascending: true }),
    supabase
      .from("decision_runs")
      .select("status,stage")
      .eq("id", report.decision_run_id as string)
      .maybeSingle(),
  ]);
  if (rowsResult.error) throw rowsResult.error;
  if (runResult.error) throw runResult.error;

  const rows = (rowsResult.data ?? []) as PersistedTryOnRow[];
  const rowsByOutfitId = new Map(rows.map((row) => [row.outfit_id, row]));
  const orderedRows = outfits.map((outfit, position) => ({
    outfit,
    position,
    row: rowsByOutfitId.get(outfit.outfitId),
  }));
  const runIsActive =
    runResult.data?.status === "queued" || runResult.data?.status === "running";
  const hasIncomplete = orderedRows.some(
    ({ row }) => !row || row.status === "pending" || row.status === "processing",
  );
  const signedUrls = new Map<string, string>();

  await Promise.all(
    orderedRows.map(async ({ row }) => {
      if (row?.status !== "ready" || !row.image_path) return;
      const { data, error } = await supabase.storage
        .from("purchase-screenshots")
        .createSignedUrl(row.image_path, 60 * 60);
      if (error || !data.signedUrl) throw error ?? new Error("try_on_signed_url_missing");
      signedUrls.set(row.id, data.signedUrl);
    }),
  );

  const results = orderedRows.map(({ outfit, position, row }) => ({
    outfitId: outfit.outfitId,
    position: row?.position ?? position,
    closetItemIds: row?.closet_item_ids ?? outfit.closetItemIds ?? [],
    status: row?.status === "ready" && row.image_path ? ("ready" as const) : ("failed" as const),
    ...(row?.status === "ready" && row.image_path
      ? { imageUrl: signedUrls.get(row.id) }
      : {
          failureKind:
            row?.failure_kind ??
            (row?.status === "cancelled"
              ? "run_cancelled"
              : runIsActive
                ? "generation_in_progress"
                : "generation_failed"),
        }),
  }));

  if (hasIncomplete && runIsActive) {
    return {
      status: "generating",
      message: "真实搭配生成中。",
      outfits: results,
    };
  }
  if (results.every((item) => item.status === "ready")) {
    return { status: "ready", outfits: results };
  }
  return {
    status: "failed",
    message: "部分真人搭配生成失败，已保留成功的方案。",
    outfits: results,
  };
}

export async function failPendingDecisionRunTryOns(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  error: unknown,
) {
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("outfit_try_on_images")
    .update({
      status: "failed",
      failure_kind: describeTryOnFailure(error),
      lease_token: null,
      lease_expires_at: null,
      completed_at: now,
      updated_at: now,
    })
    .eq("decision_run_id", run.id)
    .eq("status", "pending");
  if (updateError) throw updateError;

  const rows = await loadTryOnRowsForRun(supabase, run.id);
  return {
    attempted: Math.max(rows.length, 1),
    ready: rows.filter((row) => row.status === "ready" && row.image_path).length,
    failed: Math.max(rows.filter((row) => row.status === "failed").length, 1),
  };
}

async function ensureTryOnRows(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  reportId: string,
  outfits: Array<OutfitCombination & { outfitId: string }>,
) {
  const { error } = await supabase.from("outfit_try_on_images").upsert(
    outfits.map((outfit, position) => ({
      user_id: run.user_id,
      report_id: reportId,
      decision_run_id: run.id,
      outfit_id: outfit.outfitId,
      position,
      closet_item_ids: outfit.closetItemIds ?? [],
      status: "pending",
    })),
    {
      onConflict: "decision_run_id,outfit_id",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}

async function recoverRowsOwnedByOlderRunLease(
  supabase: SupabaseClient,
  run: DecisionRunRow,
) {
  const { error } = await supabase
    .from("outfit_try_on_images")
    .update({
      status: "pending",
      lease_token: null,
      lease_expires_at: null,
      failure_kind: "stale_worker_recovered",
      updated_at: new Date().toISOString(),
    })
    .eq("decision_run_id", run.id)
    .eq("status", "processing")
    .neq("lease_token", run.lease_token as string);
  if (error) throw error;
}

async function failTryOnWithoutProvider(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  task: TryOnTask,
  lease: LeaseCallbacks,
) {
  await lease.assertLease();
  const row = await claimTryOnRow(supabase, run, task.row);
  if (!row) return;
  const { error } = await supabase
    .from("outfit_try_on_images")
    .update({
      status: "failed",
      failure_kind: "image_edit_not_configured",
      lease_token: null,
      lease_expires_at: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "processing")
    .eq("lease_token", run.lease_token as string);
  if (error) throw error;
}

async function generateTryOn({
  supabase,
  run,
  candidate,
  candidateImage,
  modelImage,
  closetSourcesById,
  task,
  model,
  lease,
}: {
  supabase: SupabaseClient;
  run: DecisionRunRow;
  candidate: CandidateRow;
  candidateImage: Buffer;
  modelImage: Buffer;
  closetSourcesById: Map<string, ClosetSourceRow>;
  task: TryOnTask;
  model: string;
  lease: LeaseCallbacks;
}) {
  await lease.assertLease();
  const claimedRow = await claimTryOnRow(supabase, run, task.row);
  if (!claimedRow) return;

  let uploadedPath: string | undefined;
  try {
    const closetImages = await Promise.all(
      (task.outfit.closetItemIds ?? []).map(async (itemId) => {
        const source = closetSourcesById.get(itemId);
        if (!source) throw new Error(`closet_source_not_found:${itemId}`);
        const imagePath =
          source.display_image_path ?? source.processed_image_path ?? source.image_path;
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
    );
    const generated = await resolveGeneratedImage(imageOutput);
    const imagePath = `${run.user_id}/try-ons/${claimedRow.id}-${claimedRow.attempt_count}${generated.extension}`;
    const { error: uploadError } = await supabase.storage
      .from("purchase-screenshots")
      .upload(imagePath, generated.fileBody, {
        cacheControl: "3600",
        contentType: generated.contentType,
        upsert: false,
      });
    if (uploadError) throw uploadError;
    uploadedPath = imagePath;

    await lease.assertLease();
    const now = new Date().toISOString();
    const { data: committedRow, error: commitError } = await supabase
      .from("outfit_try_on_images")
      .update({
        image_path: imagePath,
        status: "ready",
        model,
        prompt_version: OUTFIT_TRY_ON_PROMPT_VERSION,
        failure_kind: null,
        lease_token: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .eq("id", claimedRow.id)
      .eq("status", "processing")
      .eq("lease_token", run.lease_token as string)
      .select("id")
      .maybeSingle();
    if (commitError) throw commitError;
    if (!committedRow) throw new Error("try_on_commit_not_owned");
  } catch (error) {
    if (uploadedPath) {
      await supabase.storage.from("purchase-screenshots").remove([uploadedPath]);
    }
    await lease
      .assertLease()
      .then(() => markOwnedTryOnFailed(supabase, run, claimedRow.id, error))
      .catch(() => undefined);
    throw error;
  }
}

async function claimTryOnRow(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  row: PersistedTryOnRow,
) {
  const now = new Date();
  const { data, error } = await supabase
    .from("outfit_try_on_images")
    .update({
      status: "processing",
      failure_kind: null,
      attempt_count: row.attempt_count + 1,
      lease_token: run.lease_token,
      lease_expires_at: new Date(now.getTime() + childLeaseDurationMs).toISOString(),
      last_attempt_started_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", row.id)
    .eq("decision_run_id", run.id)
    .in("status", ["pending", "failed"])
    .select(tryOnRowSelect)
    .maybeSingle();
  if (error) throw error;
  return data as PersistedTryOnRow | null;
}

async function markOwnedTryOnFailed(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  rowId: string,
  error: unknown,
) {
  const now = new Date().toISOString();
  await supabase
    .from("outfit_try_on_images")
    .update({
      status: "failed",
      failure_kind: describeTryOnFailure(error),
      lease_token: null,
      lease_expires_at: null,
      completed_at: now,
      updated_at: now,
    })
    .eq("id", rowId)
    .eq("status", "processing")
    .eq("lease_token", run.lease_token as string);
}

async function loadReport(
  supabase: SupabaseClient,
  reportId: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from("assessment_reports")
    .select(
      "id,user_id,candidate_id,decision_run_id,outfit_combinations,retrieved_context",
    )
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as AssessmentReportRow | null;
}

async function loadCandidate(
  supabase: SupabaseClient,
  candidateId: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from("purchase_candidates")
    .select("id,user_id,screenshot_path,product_name,category,color")
    .eq("id", candidateId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as CandidateRow | null;
}

async function loadTryOnRows(supabase: SupabaseClient, reportId: string) {
  const { data, error } = await supabase
    .from("outfit_try_on_images")
    .select(tryOnRowSelect)
    .eq("report_id", reportId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PersistedTryOnRow[];
}

async function loadTryOnRowsForRun(supabase: SupabaseClient, runId: string) {
  const { data, error } = await supabase
    .from("outfit_try_on_images")
    .select(tryOnRowSelect)
    .eq("decision_run_id", runId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as PersistedTryOnRow[];
}

async function loadClosetSources(
  supabase: SupabaseClient,
  userId: string,
  ids: string[],
) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("closet_items")
    .select("id,image_path,processed_image_path,display_image_path")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw error;
  return (data ?? []) as ClosetSourceRow[];
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

    return [
      {
        outfitId:
          typeof entry.outfitId === "string" ? entry.outfitId : undefined,
        title: typeof entry.title === "string" ? entry.title : "日常搭配",
        scenario: typeof entry.scenario === "string" ? entry.scenario : "日常",
        summary: typeof entry.summary === "string" ? entry.summary : "",
        items,
        closetItemIds,
        visualIntent: entry.visualIntent === "outfit" ? "outfit" : undefined,
      } satisfies OutfitCombination,
    ];
  });
}

function readUsedModel(value: unknown) {
  return isRecord(value) && value.usedModel === true;
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
): Promise<ImageEditOutput> {
  const request = createImageEditRequest(imageDataUrls, prompt, negativePrompt);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

  try {
    const response = await fetch(request.endpoint, {
      ...createImageEditRequestInit(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`provider_request_failed:${response.status}`);
    const payload = (await response.json()) as unknown;
    const output = extractImageEditOutput(payload);
    if (!output) throw new Error("missing_image_output");
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveGeneratedImage(output: ImageEditOutput) {
  if (output.kind === "base64") return decodeImageEditBase64(output.value);

  const response = await fetch(output.value);
  if (!response.ok) {
    throw new Error(`generated_image_download_failed:${response.status}`);
  }
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

function requireTryOnRow(row: PersistedTryOnRow | undefined) {
  if (!row) throw new Error("try_on_row_missing");
  return row;
}

function describeTryOnFailure(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "provider_timeout";
  }
  if (error instanceof Error) return error.message.slice(0, 120);
  return "image_generation_or_storage_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
