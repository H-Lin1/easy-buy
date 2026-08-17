import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  RequestAuthError,
  authenticateSupabaseRequest,
  createServiceRoleSupabaseClient,
} from "@/lib/server/supabase-server";

export const runtime = "nodejs";

const requestSchema = z.object({
  sessionId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  try {
    const { user } = await authenticateSupabaseRequest(request);
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Invalid chat session archive request.", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin.rpc(
      "archive_chat_session_with_decision_runs",
      {
        p_user_id: user.id,
        p_session_id: parsed.data.sessionId,
      },
    );
    if (error) throw error;
    if (data !== true) {
      return NextResponse.json({ message: "Chat session not found." }, { status: 404 });
    }

    return NextResponse.json({ archived: true });
  } catch (error) {
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    console.error("[chat-session] archive failed", {
      message: error instanceof Error ? error.message : "unknown_error",
    });
    return NextResponse.json({ message: "Chat session archive failed." }, { status: 500 });
  }
}
