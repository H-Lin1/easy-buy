import { NextRequest, NextResponse } from "next/server";

import { closetItems } from "@/lib/mock-data";
import { queryDb } from "@/lib/server/db";
import { getOptionalUserId } from "@/lib/server/request";

export const runtime = "nodejs";

type ClosetItemRow = {
  id: string;
  image_path: string;
  category: string;
  color: string | null;
  fit: string | null;
  style_tags: string[] | null;
  scenario_tags: string[] | null;
  wear_frequency: string | null;
  status: string | null;
  summary: string | null;
  ai_confidence: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(request: NextRequest) {
  const userId = getOptionalUserId(request);

  if (!userId) {
    return NextResponse.json({
      items: closetItems,
      source: "mock",
    });
  }

  const result = await queryDb<ClosetItemRow>(
    `
      select
        id,
        image_path,
        category,
        color,
        fit,
        style_tags,
        scenario_tags,
        wear_frequency,
        status,
        summary,
        ai_confidence,
        created_at,
        updated_at
      from public.closet_items
      where user_id = $1 and status <> 'archived'
      order by updated_at desc
      limit 100
    `,
    [userId],
  );

  return NextResponse.json({
    items: result.rows,
    source: "database",
  });
}
