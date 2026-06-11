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

const host = new URL(databaseUrl).hostname;

const variants = [
  {
    name: "ssl-object",
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  },
  {
    name: "ssl-object-servername",
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false, servername: host },
  },
  {
    name: "ssl-true",
    connectionString: databaseUrl,
    ssl: true,
  },
  {
    name: "url-sslmode-require",
    connectionString: appendQuery(databaseUrl, "sslmode=require"),
    ssl: undefined,
  },
  {
    name: "url-sslmode-no-verify",
    connectionString: appendQuery(databaseUrl, "sslmode=no-verify"),
    ssl: undefined,
  },
  {
    name: "pgbouncer-flag",
    connectionString: appendQuery(databaseUrl, "pgbouncer=true"),
    ssl: { rejectUnauthorized: false },
  },
];

const results = [];

for (const variant of variants) {
  const pool = new Pool({
    connectionString: variant.connectionString,
    ssl: variant.ssl,
    max: 1,
    connectionTimeoutMillis: 20000,
    query_timeout: 20000,
  });

  const started = performance.now();

  try {
    const result = await pool.query("select 1 as ok");
    results.push({
      name: variant.name,
      ok: result.rows[0]?.ok === 1,
      elapsedMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    results.push({
      name: variant.name,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      message: error instanceof Error ? error.message : "Connection failed.",
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

console.log(JSON.stringify(results, null, 2));

function appendQuery(url, query) {
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
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
