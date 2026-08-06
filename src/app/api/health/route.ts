import { NextResponse } from "next/server";

import { appEnv, getAiProviderHealth } from "@/lib/env";
import { canConnectToDb } from "@/lib/server/db";

export const runtime = "nodejs";

export async function GET() {
  const databaseReachable = appEnv.databaseUrl
    ? await Promise.race([
        canConnectToDb(),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 3000);
        }),
      ])
    : false;

  return NextResponse.json({
    ok: true,
    databaseConfigured: Boolean(appEnv.databaseUrl),
    databaseReachable,
    supabaseConfigured: Boolean(appEnv.supabaseUrl && appEnv.supabaseAnonKey),
    ai: getAiProviderHealth(appEnv.ai),
  });
}
