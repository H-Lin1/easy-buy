import "server-only";

import { Pool, type QueryResultRow } from "pg";

import { appEnv } from "@/lib/env";

declare global {
  var easyBuyPgPool: Pool | undefined;
}

export function getDbPool() {
  if (!appEnv.databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!globalThis.easyBuyPgPool) {
    globalThis.easyBuyPgPool = new Pool({
      connectionString: appEnv.databaseUrl,
      ssl: {
        rejectUnauthorized: false,
      },
      max: 5,
      connectionTimeoutMillis: 5000,
      query_timeout: 8000,
    });
  }

  return globalThis.easyBuyPgPool;
}

export async function queryDb<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
) {
  const pool = getDbPool();
  return pool.query<T>(text, params);
}

export async function canConnectToDb() {
  try {
    const result = await queryDb<{ ok: number }>("select 1 as ok");
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
