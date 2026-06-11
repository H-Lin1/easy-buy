import { NextRequest, NextResponse } from "next/server";

import { recentChats } from "@/lib/mock-data";
import { queryDb } from "@/lib/server/db";
import { getOptionalUserId } from "@/lib/server/request";

export const runtime = "nodejs";

type ChatSessionRow = {
  id: string;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export async function GET(request: NextRequest) {
  const userId = getOptionalUserId(request);

  if (!userId) {
    return NextResponse.json({
      items: recentChats,
      source: "mock",
    });
  }

  const result = await queryDb<ChatSessionRow>(
    `
      select id, title, status, created_at, updated_at
      from public.chat_sessions
      where user_id = $1
      order by updated_at desc
      limit 30
    `,
    [userId],
  );

  return NextResponse.json({
    items: result.rows,
    source: "database",
  });
}

export async function POST(request: NextRequest) {
  const userId = getOptionalUserId(request);
  const body = (await request.json().catch(() => ({}))) as { title?: string };

  if (!userId) {
    return NextResponse.json(
      {
        message: "Chat endpoint is ready. Provide x-user-id after auth is connected to persist data.",
      },
      { status: 202 },
    );
  }

  const result = await queryDb<ChatSessionRow>(
    `
      insert into public.chat_sessions (user_id, title)
      values ($1, $2)
      returning id, title, status, created_at, updated_at
    `,
    [userId, body.title ?? "新的决策对话"],
  );

  return NextResponse.json(
    {
      item: result.rows[0],
    },
    { status: 201 },
  );
}
