import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

const databaseUrl = env.DATABASE_URL ?? env.DATABASE_URL3;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is missing from .env.local.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 1,
  connectionTimeoutMillis: Number(env.DATABASE_CONNECT_TIMEOUT_MS ?? 15000),
  query_timeout: Number(env.DATABASE_QUERY_TIMEOUT_MS ?? 15000),
});

try {
  const started = performance.now();
  const result = await pool.query("select 1 as ok");
  const elapsedMs = Math.round(performance.now() - started);
  console.log(
    JSON.stringify(
      {
        ok: result.rows[0]?.ok === 1,
        elapsedMs,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Database connection failed.",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const result = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
