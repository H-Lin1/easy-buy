import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  parsePurchaseImageDataUrl,
} from "@/lib/ai/purchase-candidate-server";
import { type DecisionRunRow } from "@/lib/decision-runs/model";
import { toPublicDecisionRun } from "@/lib/decision-runs/public";
import {
  DECISION_RUN_SELECT,
  dispatchUserDecisionRuns,
} from "@/lib/decision-runs/runner";
import {
  RequestAuthError,
  authenticateSupabaseRequest,
  createServiceRoleSupabaseClient,
} from "@/lib/server/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 300;

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

const createRunSchema = z.object({
  sessionId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  message: z.string().max(1200).default(""),
  imageDataUrl: z.string().startsWith("data:image/"),
  imageName: z.string().max(255).optional(),
  userProfile: profileSchema,
});

const getRunsSchema = z.object({
  sessionId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  let uploadedPath: string | undefined;

  try {
    const { user } = await authenticateSupabaseRequest(request);
    const body = await request.json().catch(() => null);
    const parsed = createRunSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Invalid decision run request.", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const admin = createServiceRoleSupabaseClient();
    const duplicate = await loadRunByClientRequestId(
      admin,
      user.id,
      parsed.data.clientRequestId,
    );
    if (duplicate) {
      if (duplicate.session_id !== parsed.data.sessionId) {
        return NextResponse.json(
          { message: "clientRequestId is already used by another session." },
          { status: 409 },
        );
      }
      const ensuredRun = await ensureUserMessage(
        admin,
        duplicate,
        parsed.data.imageName,
      );
      after(() => dispatchUserDecisionRuns(user.id).catch(logDispatchFailure));
      return NextResponse.json({ run: toPublicDecisionRun(ensuredRun) }, { status: 202 });
    }

    const { data: session, error: sessionError } = await admin
      .from("chat_sessions")
      .select("id")
      .eq("id", parsed.data.sessionId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (sessionError) throw sessionError;
    if (!session) {
      return NextResponse.json({ message: "Chat session not found." }, { status: 404 });
    }

    const image = parsePurchaseImageDataUrl(parsed.data.imageDataUrl);
    const runId = crypto.randomUUID();
    const extension =
      image.mimeType === "image/png"
        ? "png"
        : image.mimeType === "image/webp"
          ? "webp"
          : "jpg";
    uploadedPath = `${user.id}/decision-runs/${runId}.${extension}`;
    const { error: uploadError } = await admin.storage
      .from("purchase-screenshots")
      .upload(uploadedPath, image.buffer, {
        cacheControl: "3600",
        contentType: image.mimeType,
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { data: insertedRun, error: insertError } = await admin
      .from("decision_runs")
      .upsert(
        {
          id: runId,
          user_id: user.id,
          session_id: parsed.data.sessionId,
          client_request_id: parsed.data.clientRequestId,
          input_text: parsed.data.message.trim(),
          screenshot_path: uploadedPath,
          screenshot_mime_type: image.mimeType,
          profile_snapshot: parsed.data.userProfile ?? {},
          stage_data: {},
          status: "queued",
          stage: "queued",
        },
        {
          onConflict: "user_id,client_request_id",
          ignoreDuplicates: true,
        },
      )
      .select(DECISION_RUN_SELECT)
      .maybeSingle();
    if (insertError) {
      // The database may have committed before a transport error; preserve the referenced object.
      uploadedPath = undefined;
      throw insertError;
    }

    let run = insertedRun as DecisionRunRow | null;
    if (!run) {
      run = await loadRunByClientRequestId(
        admin,
        user.id,
        parsed.data.clientRequestId,
      );
      if (!run) throw new Error("decision_run_idempotency_lookup_failed");
      if (run.screenshot_path !== uploadedPath) {
        await admin.storage.from("purchase-screenshots").remove([uploadedPath]);
      }
    }
    uploadedPath = undefined;

    run = await ensureUserMessage(admin, run, parsed.data.imageName);

    await admin
      .from("chat_sessions")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", run.session_id)
      .eq("user_id", user.id);

    after(() => dispatchUserDecisionRuns(user.id).catch(logDispatchFailure));
    return NextResponse.json({ run: toPublicDecisionRun(run) }, { status: 202 });
  } catch (error) {
    if (uploadedPath) {
      try {
        await createServiceRoleSupabaseClient().storage
          .from("purchase-screenshots")
          .remove([uploadedPath]);
      } catch {
        // Cleanup is best-effort; the failed upload is not referenced by a run.
      }
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    console.error("[decision-runs] create failed", { message: getErrorMessage(error) });
    return NextResponse.json({ message: "Decision run creation failed." }, { status: 500 });
  }
}

async function ensureUserMessage(
  admin: ReturnType<typeof createServiceRoleSupabaseClient>,
  run: DecisionRunRow,
  imageName?: string,
) {
  const { error: messageInsertError } = await admin.from("chat_messages").upsert(
    {
      session_id: run.session_id,
      user_id: run.user_id,
      decision_run_id: run.id,
      role: "user",
      content: run.input_text || "我想判断这件衣服是否值得买。",
      image_path: run.screenshot_path,
      metadata: {
        imageName,
        decisionRunId: run.id,
      },
    },
    {
      onConflict: "decision_run_id,role",
      ignoreDuplicates: true,
    },
  );
  if (messageInsertError) throw messageInsertError;

  const { data: userMessage, error: userMessageError } = await admin
    .from("chat_messages")
    .select("id")
    .eq("decision_run_id", run.id)
    .eq("role", "user")
    .single();
  if (userMessageError) throw userMessageError;

  const { data: updatedRun, error: updateError } = await admin
    .from("decision_runs")
    .update({
      user_message_id: userMessage.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("user_id", run.user_id)
    .select(DECISION_RUN_SELECT)
    .single();
  if (updateError) throw updateError;
  return updatedRun as unknown as DecisionRunRow;
}

export async function GET(request: NextRequest) {
  try {
    const { user, supabase } = await authenticateSupabaseRequest(request);
    const parsed = getRunsSchema.safeParse({
      sessionId: request.nextUrl.searchParams.get("sessionId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Invalid decision run query.", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    let query = supabase
      .from("decision_runs")
      .select(DECISION_RUN_SELECT)
      .eq("user_id", user.id);
    if (parsed.data.sessionId) {
      query = query.eq("session_id", parsed.data.sessionId);
    }
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(parsed.data.sessionId ? 20 : 100);
    if (error) throw error;

    const rows = (data ?? []) as unknown as DecisionRunRow[];
    if (rows.some((row) => row.status === "queued" || row.status === "running")) {
      after(() => dispatchUserDecisionRuns(user.id).catch(logDispatchFailure));
    }
    return NextResponse.json({ runs: rows.map(toPublicDecisionRun) });
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    console.error("[decision-runs] query failed", { message: getErrorMessage(error) });
    return NextResponse.json({ message: "Decision run query failed." }, { status: 500 });
  }
}

async function loadRunByClientRequestId(
  supabase: ReturnType<typeof createServiceRoleSupabaseClient>,
  userId: string,
  clientRequestId: string,
) {
  const { data, error } = await supabase
    .from("decision_runs")
    .select(DECISION_RUN_SELECT)
    .eq("user_id", userId)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (error) throw error;
  return data as DecisionRunRow | null;
}

function logDispatchFailure(error: unknown) {
  console.error("[decision-runs] immediate dispatch failed", {
    message: getErrorMessage(error),
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown_error";
}
