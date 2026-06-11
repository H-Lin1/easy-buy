import { NextRequest, NextResponse } from "next/server";

import { decisionItems } from "@/lib/mock-data";
import { queryDb } from "@/lib/server/db";
import { getOptionalUserId, mapDecisionStatusToDb } from "@/lib/server/request";

export const runtime = "nodejs";

type DecisionItemRow = {
  id: string;
  status: string;
  snapshot_summary: string | null;
  snapshot_outfit_tips: string[] | null;
  snapshot_risks: string[] | null;
  reminder_at: string | null;
  created_at: string;
  updated_at: string;
  product_name: string | null;
  color: string | null;
  size: string | null;
  estimated_price: string | null;
};

export async function GET(request: NextRequest) {
  const userId = getOptionalUserId(request);
  const status = request.nextUrl.searchParams.get("status");

  if (!userId) {
    return NextResponse.json({
      items:
        status && status !== "all"
          ? decisionItems.filter((item) => item.status === status)
          : decisionItems,
      source: "mock",
    });
  }

  const result = await queryDb<DecisionItemRow>(
    `
      select
        di.id,
        di.status,
        di.snapshot_summary,
        di.snapshot_outfit_tips,
        di.snapshot_risks,
        di.reminder_at,
        di.created_at,
        di.updated_at,
        coalesce(pc.summary, pc.category) as product_name,
        pc.color,
        null::text as size,
        pc.estimated_price
      from public.decision_items di
      join public.purchase_candidates pc on pc.id = di.candidate_id
      where di.user_id = $1
        and ($2::text is null or di.status = $2)
      order by di.updated_at desc
      limit 50
    `,
    [userId, status && status !== "all" ? status : null],
  );

  return NextResponse.json({
    items: result.rows,
    source: "database",
  });
}

export async function POST(request: NextRequest) {
  const userId = getOptionalUserId(request);
  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
  };
  const status = body.status ? mapDecisionStatusToDb(body.status) : null;

  if (!body.id || !status) {
    return NextResponse.json(
      { message: "Missing decision item id or valid status." },
      { status: 400 },
    );
  }

  if (!userId) {
    return NextResponse.json({
      item: {
        id: body.id,
        status,
        reminderAt: status === "saved_for_later" ? "24 小时后" : null,
      },
      source: "mock",
    });
  }

  const result = await queryDb<DecisionItemRow>(
    `
      update public.decision_items
      set
        status = $3,
        reminder_at = case when $3 = 'saved_for_later' then now() + interval '24 hours' else null end,
        updated_at = now()
      where id = $1 and user_id = $2
      returning
        id,
        status,
        snapshot_summary,
        snapshot_outfit_tips,
        snapshot_risks,
        reminder_at,
        created_at,
        updated_at,
        null::text as product_name,
        null::text as color,
        null::text as size,
        null::numeric as estimated_price
    `,
    [body.id, userId, status],
  );

  if (!result.rows[0]) {
    return NextResponse.json({ message: "Decision item not found." }, { status: 404 });
  }

  return NextResponse.json(
    {
      item: result.rows[0],
      source: "database",
    },
    { status: 200 },
  );
}
