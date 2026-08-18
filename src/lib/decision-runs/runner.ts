import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { buildPurchaseEmbeddingText } from "@/lib/ai/purchase-analysis";
import {
  analyzePurchaseCandidateSafely,
  stripUnsupportedPrice,
} from "@/lib/ai/purchase-candidate-server";
import {
  embedText,
  sanitizeAiErrorMessage,
  toPgVector,
} from "@/lib/ai/providers";
import type {
  PurchaseCandidateAIProfile,
  PurchaseDecisionReport,
  UserStyleProfile,
} from "@/lib/ai/types";
import { parseCandidateFromMessage, runPurchaseAssessment } from "@/lib/ai/workflow";
import {
  failPendingDecisionRunTryOns,
  generatePersistedDecisionRunTryOns,
} from "@/lib/decision-runs/try-on-runner";
import {
  getDecisionRunCompletionStatus,
  type TryOnExecutionSummary,
} from "@/lib/decision-runs/execution-policy";
import type { DecisionRunRow, DecisionRunStage } from "@/lib/decision-runs/model";
import { createSignedImageUrl, loadRealClosetItems } from "@/lib/server/closet-data";
import { createServiceRoleSupabaseClient } from "@/lib/server/supabase-server";

export const DECISION_RUN_SELECT = [
  "id",
  "user_id",
  "session_id",
  "client_request_id",
  "input_text",
  "screenshot_path",
  "screenshot_mime_type",
  "profile_snapshot",
  "stage_data",
  "status",
  "stage",
  "user_message_id",
  "assistant_message_id",
  "candidate_id",
  "report_id",
  "error_code",
  "error_message",
  "attempt_count",
  "recovery_count",
  "available_at",
  "lease_token",
  "lease_expires_at",
  "last_claimed_at",
  "last_heartbeat_at",
  "last_recovered_at",
  "started_at",
  "decision_ready_at",
  "finished_at",
  "cancelled_at",
  "created_at",
  "updated_at",
].join(",");

type CandidatePersistenceRow = {
  id: string;
  product_name: string | null;
  screenshot_path: string;
  category: string | null;
  color: string | null;
  secondary_colors: string[] | null;
  fit: PurchaseCandidateAIProfile["fit"] | null;
  style_tags: string[] | null;
  estimated_price: number | null;
  detected_text: string | null;
  selling_points: string[] | null;
  possible_scenarios: string[] | null;
  summary: string | null;
  embedding_text: string | null;
  embedding: string | number[] | null;
  ai_confidence: number | null;
};

type ReportPersistenceRow = {
  id: string;
};

type MessagePersistenceRow = {
  id: string;
  metadata: Record<string, unknown> | null;
};

type CandidateContext = {
  run: DecisionRunRow;
  candidate: PurchaseCandidateAIProfile;
  candidateEmbedding: number[];
  candidateId: string;
};

export class DecisionRunLeaseLostError extends Error {
  constructor() {
    super("decision_run_lease_lost");
    this.name = "DecisionRunLeaseLostError";
  }
}

const leaseSeconds = 10 * 60;
const maxRunAttempts = 3;

export async function dispatchUserDecisionRuns(userId: string) {
  const supabase = createServiceRoleSupabaseClient();
  let claimed = 0;
  let completed = 0;

  // A bounded second round immediately fills a slot released by a short run.
  for (let round = 0; round < 2; round += 1) {
    const runs: DecisionRunRow[] = [];
    for (let slot = 0; slot < 2; slot += 1) {
      const run = await claimNextDecisionRun(supabase, userId);
      if (!run) break;
      runs.push(run);
    }
    if (!runs.length) break;

    claimed += runs.length;
    const results = await Promise.allSettled(
      runs.map((run) => executeClaimedDecisionRun(supabase, run)),
    );
    completed += results.filter((result) => result.status === "fulfilled").length;
  }

  return { claimed, completed };
}

export async function recoverDecisionRunQueue(limit = 100) {
  const supabase = createServiceRoleSupabaseClient();
  const [runRecovery, tryOnRecovery] = await Promise.all([
    supabase.rpc("recover_expired_decision_runs", { p_limit: limit }),
    supabase.rpc("recover_expired_outfit_try_on_images", { p_limit: limit }),
  ]);
  if (runRecovery.error) throw runRecovery.error;
  if (tryOnRecovery.error) throw tryOnRecovery.error;

  const { data: queuedRows, error: queuedError } = await supabase
    .from("decision_runs")
    .select("user_id")
    .eq("status", "queued")
    .lte("available_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (queuedError) throw queuedError;

  return {
    recoveredRuns: Array.isArray(runRecovery.data) ? runRecovery.data.length : 0,
    recoveredTryOns: Array.isArray(tryOnRecovery.data) ? tryOnRecovery.data.length : 0,
    userIds: Array.from(
      new Set(
        (queuedRows ?? [])
          .map((row) => row.user_id)
          .filter((value): value is string => typeof value === "string"),
      ),
    ),
  };
}

async function executeClaimedDecisionRun(
  supabase: SupabaseClient,
  claimedRun: DecisionRunRow,
) {
  let run = claimedRun;

  try {
    run = await renewRunLease(supabase, run);
    run = await ensureRunUserMessage(supabase, run);
    const candidateContext = await ensureCandidate(supabase, run);
    run = candidateContext.run;

    const decisionContext = await ensureDecisionReport(
      supabase,
      run,
      candidateContext,
    );
    run = decisionContext.run;

    run = await renewRunLease(supabase, run);
    run = await transitionRunStage(supabase, run, "generating_try_ons");
    let activeRun = run;
    const tryOnLease = {
      assertLease: () => assertRunLease(supabase, activeRun),
      renewLease: async () => {
        activeRun = await renewRunLease(supabase, activeRun);
      },
    };
    let tryOnError: unknown;
    let tryOnSummary: TryOnExecutionSummary;
    try {
      tryOnSummary = await generatePersistedDecisionRunTryOns(
        supabase,
        run,
        tryOnLease,
      );
    } catch (error) {
      if (error instanceof DecisionRunLeaseLostError) throw error;
      tryOnError = error;
      await tryOnLease.assertLease();
      tryOnSummary = await failPendingDecisionRunTryOns(supabase, run, error);
      console.warn("[decision-run] try-on batch completed with errors", {
        runId: run.id,
        message: sanitizeAiErrorMessage(error),
      });
    }
    run = activeRun;

    await assertRunLease(supabase, run);
    const finalStatus = getDecisionRunCompletionStatus(tryOnSummary);
    await guardedRunUpdate(supabase, run, {
      status: finalStatus,
      stage: "completed",
      stage_data: mergeStageData(run, { tryOnSummary }),
      error_code: tryOnError ? "try_on_failed" : null,
      error_message: tryOnError
        ? sanitizeAiErrorMessage(tryOnError).slice(0, 300)
        : null,
      finished_at: new Date().toISOString(),
      lease_token: null,
      lease_expires_at: null,
    });
  } catch (error) {
    if (error instanceof DecisionRunLeaseLostError) {
      console.info("[decision-run] stopped after lease loss", { runId: run.id });
      return;
    }

    console.error("[decision-run] execution failed", {
      runId: run.id,
      attempt: run.attempt_count,
      message: sanitizeAiErrorMessage(error),
    });
    await handleRunFailure(supabase, run, error);
  }
}

async function ensureRunUserMessage(
  supabase: SupabaseClient,
  run: DecisionRunRow,
) {
  await assertRunLease(supabase, run);
  const { error: insertError } = await supabase.from("chat_messages").upsert(
    {
      session_id: run.session_id,
      user_id: run.user_id,
      decision_run_id: run.id,
      role: "user",
      content: run.input_text || "我想判断这件衣服是否值得买。",
      image_path: run.screenshot_path,
      metadata: { decisionRunId: run.id },
    },
    { onConflict: "decision_run_id,role", ignoreDuplicates: true },
  );
  if (insertError) throw insertError;

  const { data, error } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("decision_run_id", run.id)
    .eq("role", "user")
    .single();
  if (error) throw error;
  if (run.user_message_id === data.id) return run;
  return guardedRunUpdate(supabase, run, { user_message_id: data.id });
}

async function ensureCandidate(
  supabase: SupabaseClient,
  run: DecisionRunRow,
): Promise<CandidateContext> {
  const persisted = await loadCandidateByRun(supabase, run);
  const stageCandidate = readStageCandidate(run.stage_data.candidate);

  if (persisted) {
    const screenshotUrl = await createSignedImageUrl(
      supabase,
      "purchase-screenshots",
      run.screenshot_path,
    );
    const persistedCandidate =
      stageCandidate ?? mapPersistedCandidate(persisted, run.screenshot_path, screenshotUrl);
    const refreshedCandidate = {
      ...persistedCandidate,
      screenshotPath: run.screenshot_path,
      screenshotUrl,
    };
    const candidateEmbedding = readStageEmbedding(run.stage_data.candidateEmbedding)
      ?? parsePgVector(persisted.embedding);
    const nextRun = await guardedRunUpdate(supabase, run, {
      candidate_id: persisted.id,
      stage_data: mergeStageData(run, {
        candidate: refreshedCandidate,
        candidateEmbedding,
      }),
    });
    return {
      run: nextRun,
      candidate: refreshedCandidate,
      candidateEmbedding,
      candidateId: persisted.id,
    };
  }

  run = await transitionRunStage(supabase, run, "analyzing_candidate");
  const imageBytes = await downloadStorageImage(
    supabase,
    "purchase-screenshots",
    run.screenshot_path,
  );
  const mimeType = run.screenshot_mime_type ?? "image/jpeg";
  const imageDataUrl = `data:${mimeType};base64,${imageBytes.toString("base64")}`;
  const screenshotUrl = await createSignedImageUrl(
    supabase,
    "purchase-screenshots",
    run.screenshot_path,
  );
  const candidate = stripUnsupportedPrice(
    await analyzePurchaseCandidateSafely(
      run.input_text,
      imageDataUrl,
      run.screenshot_path,
      screenshotUrl,
    ),
    run.input_text,
  );
  const embeddingText = candidate.embeddingText ?? buildPurchaseEmbeddingText(candidate);
  const candidateWithEmbeddingText = { ...candidate, embeddingText };
  const candidateEmbedding = await embedText(embeddingText);

  await assertRunLease(supabase, run);
  const { error: insertError } = await supabase
    .from("purchase_candidates")
    .upsert(
      {
        user_id: run.user_id,
        session_id: run.session_id,
        decision_run_id: run.id,
        screenshot_path: run.screenshot_path,
        user_intent: run.input_text,
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
        embedding_text: embeddingText,
        embedding: toPgVector(candidateEmbedding),
        ai_confidence: candidate.aiConfidence,
      },
      { onConflict: "decision_run_id", ignoreDuplicates: true },
    );
  if (insertError) throw insertError;

  const candidateRow = await loadCandidateByRun(supabase, run);
  if (!candidateRow) throw new Error("decision_run_candidate_persistence_failed");
  const nextRun = await guardedRunUpdate(supabase, run, {
    candidate_id: candidateRow.id,
    stage_data: mergeStageData(run, {
      candidate: candidateWithEmbeddingText,
      candidateEmbedding,
    }),
  });

  return {
    run: nextRun,
    candidate: candidateWithEmbeddingText,
    candidateEmbedding,
    candidateId: candidateRow.id,
  };
}

function mapPersistedCandidate(
  row: CandidatePersistenceRow,
  screenshotPath: string,
  screenshotUrl?: string,
): PurchaseCandidateAIProfile {
  const inferred = parseCandidateFromMessage(
    [row.product_name, row.color, row.category].filter(Boolean).join(" "),
  );
  return {
    ...inferred,
    productName: row.product_name ?? inferred.productName,
    category: row.category ?? inferred.category,
    color: row.color ?? inferred.color,
    secondaryColors: row.secondary_colors ?? [],
    fit: row.fit ?? "unknown",
    styleTags: row.style_tags ?? [],
    possibleScenarios: row.possible_scenarios ?? [],
    estimatedPrice: row.estimated_price ?? undefined,
    detectedText: row.detected_text ?? undefined,
    sellingPoints: row.selling_points ?? [],
    summary: row.summary ?? inferred.summary,
    embeddingText: row.embedding_text ?? inferred.embeddingText,
    aiConfidence: row.ai_confidence ?? undefined,
    screenshotPath,
    screenshotUrl,
  };
}

async function ensureDecisionReport(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  candidateContext: CandidateContext,
) {
  const existingReport = await loadReportByRun(supabase, run);
  const existingAssistant = await loadAssistantMessageByRun(supabase, run);

  if (existingReport && existingAssistant) {
    const resultPatch = {
      candidate_id: candidateContext.candidateId,
      report_id: existingReport.id,
      assistant_message_id: existingAssistant.id,
      decision_ready_at: run.decision_ready_at ?? new Date().toISOString(),
    };
    const nextRun =
      run.stage === "generating_try_ons"
        ? await guardedRunUpdate(supabase, run, resultPatch)
        : await transitionRunStage(supabase, run, "decision_ready", resultPatch);
    return { run: nextRun, reportId: existingReport.id };
  }

  const stagedReport = readStageReport(run.stage_data.decisionReport);
  if (stagedReport) {
    return persistDecisionOutcome(
      supabase,
      run,
      candidateContext.candidateId,
      stagedReport,
      readPositiveInteger(run.stage_data.decisionElapsedSeconds) ??
        calculateDecisionElapsedSeconds(run),
      existingReport?.id,
      existingAssistant?.id,
    );
  }

  let currentRun =
    run.stage === "deciding"
      ? run
      : await transitionRunStage(supabase, run, "retrieving_context");
  const [closetItems, decisionImageBytes] = await Promise.all([
    loadRealClosetItems(supabase, run.user_id),
    downloadStorageImage(supabase, "purchase-screenshots", run.screenshot_path),
  ]);
  const decisionImageDataUrl = `data:${run.screenshot_mime_type ?? "image/jpeg"};base64,${decisionImageBytes.toString("base64")}`;
  currentRun = await renewRunLease(supabase, currentRun);
  currentRun = await transitionRunStage(supabase, currentRun, "deciding", {
    stage_data: mergeStageData(currentRun, {
      closetItemCount: closetItems.length,
    }),
  });

  const report = await runPurchaseAssessment({
    message: run.input_text,
    imageDataUrl: decisionImageDataUrl,
    userProfile: normalizeUserProfile(run.profile_snapshot),
    candidate: candidateContext.candidate,
    candidateEmbedding: candidateContext.candidateEmbedding,
    closetItems,
  });
  await assertRunLease(supabase, currentRun);
  const elapsedSeconds = calculateDecisionElapsedSeconds(currentRun);
  currentRun = await guardedRunUpdate(supabase, currentRun, {
    stage_data: mergeStageData(currentRun, {
      decisionReport: report,
      decisionElapsedSeconds: elapsedSeconds,
    }),
  });

  return persistDecisionOutcome(
    supabase,
    currentRun,
    candidateContext.candidateId,
    report,
    elapsedSeconds,
  );
}

async function persistDecisionOutcome(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  candidateId: string,
  report: PurchaseDecisionReport,
  elapsedSeconds: number,
  existingReportId?: string,
  existingAssistantId?: string,
) {
  const reportId =
    existingReportId ??
    (await persistAssessmentReport(supabase, run, candidateId, report));
  const assistantId =
    existingAssistantId ??
    (await persistAssistantMessage(
      supabase,
      run,
      candidateId,
      reportId,
      report,
      elapsedSeconds,
    ));
  await updateUserMessageResultLinks(supabase, run, candidateId, reportId);
  await updateChatSessionResultLinks(supabase, run, candidateId, reportId);

  const nextRun = await transitionRunStage(supabase, run, "decision_ready", {
    candidate_id: candidateId,
    report_id: reportId,
    assistant_message_id: assistantId,
    decision_ready_at: run.decision_ready_at ?? new Date().toISOString(),
    stage_data: {
      ...omitStageDataKey(run.stage_data, "decisionReport"),
      decisionElapsedSeconds: elapsedSeconds,
    },
  });
  return { run: nextRun, reportId };
}

async function persistAssessmentReport(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  candidateId: string,
  report: PurchaseDecisionReport,
) {
  await assertRunLease(supabase, run);
  const { error } = await supabase.from("assessment_reports").upsert(
    {
      user_id: run.user_id,
      session_id: run.session_id,
      decision_run_id: run.id,
      candidate_id: candidateId,
      decision: report.decision,
      decision_label: report.decisionLabel,
      scores: report.scores,
      summary: report.summary,
      styling_inspirations: report.outfitCombinations
        .map((item) => item.summary)
        .slice(0, 3),
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
    },
    { onConflict: "decision_run_id", ignoreDuplicates: true },
  );
  if (error) throw error;

  const persisted = await loadReportByRun(supabase, run);
  if (!persisted) throw new Error("decision_run_report_persistence_failed");
  return persisted.id;
}

async function persistAssistantMessage(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  candidateId: string,
  reportId: string,
  report: PurchaseDecisionReport,
  decisionElapsedSeconds: number,
) {
  await assertRunLease(supabase, run);
  const { error } = await supabase.from("chat_messages").upsert(
    {
      session_id: run.session_id,
      user_id: run.user_id,
      decision_run_id: run.id,
      role: "assistant",
      content: report.summary,
      image_path: null,
      candidate_id: candidateId,
      report_id: reportId,
      metadata: {
        report,
        decisionElapsedSeconds,
        decisionRunId: run.id,
      },
    },
    {
      onConflict: "decision_run_id,role",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;

  const message = await loadAssistantMessageByRun(supabase, run);
  if (!message) throw new Error("decision_run_assistant_message_persistence_failed");
  return message.id;
}

async function updateUserMessageResultLinks(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  candidateId: string,
  reportId: string,
) {
  await assertRunLease(supabase, run);
  const { error } = await supabase
    .from("chat_messages")
    .update({ candidate_id: candidateId, report_id: reportId })
    .eq("decision_run_id", run.id)
    .eq("role", "user");
  if (error) throw error;
}

async function updateChatSessionResultLinks(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  candidateId: string,
  reportId: string,
) {
  await assertRunLease(supabase, run);
  const { error } = await supabase
    .from("chat_sessions")
    .update({
      last_candidate_id: candidateId,
      last_report_id: reportId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.session_id)
    .eq("user_id", run.user_id)
    .eq("status", "active");
  if (error) throw error;
}

async function claimNextDecisionRun(
  supabase: SupabaseClient,
  userId: string,
) {
  const { data, error } = await supabase.rpc("claim_next_decision_run", {
    p_user_id: userId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? (row as DecisionRunRow) : null;
}

async function renewRunLease(
  supabase: SupabaseClient,
  run: DecisionRunRow,
) {
  if (!run.lease_token) throw new DecisionRunLeaseLostError();
  const { data, error } = await supabase.rpc("renew_decision_run_lease", {
    p_run_id: run.id,
    p_lease_token: run.lease_token,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw error;
  if (data !== true) throw new DecisionRunLeaseLostError();

  const current = await loadOwnedRun(supabase, run.id, run.lease_token);
  if (!current) throw new DecisionRunLeaseLostError();
  return current;
}

async function assertRunLease(
  supabase: SupabaseClient,
  run: DecisionRunRow,
) {
  if (!run.lease_token) throw new DecisionRunLeaseLostError();
  const current = await loadOwnedRun(supabase, run.id, run.lease_token);
  if (!current) throw new DecisionRunLeaseLostError();
}

async function loadOwnedRun(
  supabase: SupabaseClient,
  runId: string,
  leaseToken: string,
) {
  const { data, error } = await supabase
    .from("decision_runs")
    .select(DECISION_RUN_SELECT)
    .eq("id", runId)
    .eq("status", "running")
    .eq("lease_token", leaseToken)
    .gt("lease_expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return data as unknown as DecisionRunRow | null;
}

async function transitionRunStage(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  stage: DecisionRunStage,
  patch: Record<string, unknown> = {},
) {
  return guardedRunUpdate(supabase, run, { ...patch, stage });
}

async function guardedRunUpdate(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  patch: Record<string, unknown>,
) {
  if (!run.lease_token) throw new DecisionRunLeaseLostError();
  const { data, error } = await supabase
    .from("decision_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", run.id)
    .eq("status", "running")
    .eq("lease_token", run.lease_token)
    .gt("lease_expires_at", new Date().toISOString())
    .select(DECISION_RUN_SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new DecisionRunLeaseLostError();
  return data as unknown as DecisionRunRow;
}

async function handleRunFailure(
  supabase: SupabaseClient,
  run: DecisionRunRow,
  error: unknown,
) {
  const message = sanitizeAiErrorMessage(error).slice(0, 300);
  const code = classifyRunError(error);

  try {
    if (run.attempt_count < maxRunAttempts) {
      const owned = await guardedRunUpdate(supabase, run, {
        error_code: code,
        error_message: message,
      });
      const { error: releaseError } = await supabase.rpc(
        "release_decision_run_lease",
        {
          p_run_id: owned.id,
          p_lease_token: owned.lease_token,
        },
      );
      if (releaseError) throw releaseError;
      return;
    }

    await guardedRunUpdate(supabase, run, {
      status: "failed",
      error_code: code,
      error_message: message,
      finished_at: new Date().toISOString(),
      lease_token: null,
      lease_expires_at: null,
    });
  } catch (failureError) {
    if (!(failureError instanceof DecisionRunLeaseLostError)) throw failureError;
  }
}

async function loadCandidateByRun(
  supabase: SupabaseClient,
  run: DecisionRunRow,
) {
  const { data, error } = await supabase
    .from("purchase_candidates")
    .select(
      "id,product_name,screenshot_path,category,color,secondary_colors,fit,style_tags,estimated_price,detected_text,selling_points,possible_scenarios,summary,embedding_text,embedding,ai_confidence",
    )
    .eq("decision_run_id", run.id)
    .eq("user_id", run.user_id)
    .maybeSingle();
  if (error) throw error;
  return data as CandidatePersistenceRow | null;
}

async function loadReportByRun(
  supabase: SupabaseClient,
  run: DecisionRunRow,
) {
  const { data, error } = await supabase
    .from("assessment_reports")
    .select("id")
    .eq("decision_run_id", run.id)
    .eq("user_id", run.user_id)
    .maybeSingle();
  if (error) throw error;
  return data as ReportPersistenceRow | null;
}

async function loadAssistantMessageByRun(
  supabase: SupabaseClient,
  run: DecisionRunRow,
) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id,metadata")
    .eq("decision_run_id", run.id)
    .eq("user_id", run.user_id)
    .eq("role", "assistant")
    .maybeSingle();
  if (error) throw error;
  return data as MessagePersistenceRow | null;
}

async function downloadStorageImage(
  supabase: SupabaseClient,
  bucket: "purchase-screenshots",
  imagePath: string,
) {
  const { data, error } = await supabase.storage.from(bucket).download(imagePath);
  if (error || !data) throw error ?? new Error("storage_image_missing");
  return Buffer.from(await data.arrayBuffer());
}

function readStageCandidate(value: unknown): PurchaseCandidateAIProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PurchaseCandidateAIProfile>;
  if (
    typeof candidate.productName !== "string" ||
    typeof candidate.category !== "string" ||
    typeof candidate.color !== "string" ||
    !Array.isArray(candidate.styleTags) ||
    !Array.isArray(candidate.possibleScenarios) ||
    !Array.isArray(candidate.sellingPoints)
  ) {
    return undefined;
  }
  return candidate as PurchaseCandidateAIProfile;
}

function readStageReport(value: unknown): PurchaseDecisionReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Partial<PurchaseDecisionReport>;
  if (
    (report.decision !== "buy" &&
      report.decision !== "save" &&
      report.decision !== "skip") ||
    typeof report.summary !== "string" ||
    typeof report.decisionLabel !== "string" ||
    !report.candidate ||
    !Array.isArray(report.outfitCombinations) ||
    !Array.isArray(report.retrievedClosetItems) ||
    !Array.isArray(report.knowledgeSnippets)
  ) {
    return undefined;
  }
  return report as PurchaseDecisionReport;
}

function readPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function calculateDecisionElapsedSeconds(run: DecisionRunRow) {
  return Math.max(
    1,
    Math.round(
      (Date.now() - new Date(run.started_at ?? run.created_at).getTime()) / 1000,
    ),
  );
}

function omitStageDataKey(
  stageData: Record<string, unknown>,
  key: string,
) {
  const next = { ...stageData };
  delete next[key];
  return next;
}

function readStageEmbedding(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const embedding = value.map(Number).filter(Number.isFinite);
  return embedding.length ? embedding : undefined;
}

function parsePgVector(value: string | number[] | null) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(Number.isFinite);
}

function normalizeUserProfile(value: Record<string, unknown>): UserStyleProfile | undefined {
  const profile: UserStyleProfile = {};
  if (typeof value.heightCm === "number") profile.heightCm = value.heightCm;
  if (typeof value.weightKg === "number") profile.weightKg = value.weightKg;
  if (typeof value.bmi === "number") profile.bmi = value.bmi;
  if (Array.isArray(value.stylePreferences)) {
    profile.stylePreferences = value.stylePreferences.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (Array.isArray(value.commonScenarios)) {
    profile.commonScenarios = value.commonScenarios.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (
    value.budgetSensitivity === "low" ||
    value.budgetSensitivity === "medium" ||
    value.budgetSensitivity === "high"
  ) {
    profile.budgetSensitivity = value.budgetSensitivity;
  }
  return Object.keys(profile).length ? profile : undefined;
}

function mergeStageData(run: DecisionRunRow, patch: Record<string, unknown>) {
  return { ...(run.stage_data ?? {}), ...patch };
}

function classifyRunError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("storage")) return "storage_failed";
  if (message.includes("candidate")) return "candidate_failed";
  if (message.includes("report")) return "decision_failed";
  return "worker_failed";
}
