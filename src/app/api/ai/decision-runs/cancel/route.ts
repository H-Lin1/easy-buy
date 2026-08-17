import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { dispatchUserDecisionRuns } from "@/lib/decision-runs/runner";
import {
  RequestAuthError,
  authenticateSupabaseRequest,
  createServiceRoleSupabaseClient,
} from "@/lib/server/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  sessionId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const { user } = await authenticateSupabaseRequest(request);
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Invalid decision run cancellation request.", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const admin = createServiceRoleSupabaseClient();
    const { data: session, error: sessionError } = await admin
      .from("chat_sessions")
      .select("id")
      .eq("id", parsed.data.sessionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (sessionError) throw sessionError;
    if (!session) {
      return NextResponse.json({ message: "Chat session not found." }, { status: 404 });
    }

    const { data, error } = await admin.rpc("cancel_decision_runs_for_session", {
      p_user_id: user.id,
      p_session_id: parsed.data.sessionId,
    });
    if (error) throw error;

    after(() =>
      dispatchUserDecisionRuns(user.id).catch((dispatchError) => {
        console.error("[decision-runs] post-cancellation dispatch failed", {
          message: getErrorMessage(dispatchError),
        });
      }),
    );
    return NextResponse.json({ cancelledCount: typeof data === "number" ? data : 0 });
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    console.error("[decision-runs] cancellation failed", {
      message: getErrorMessage(error),
    });
    return NextResponse.json(
      { message: "Decision run cancellation failed." },
      { status: 500 },
    );
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown_error";
}
