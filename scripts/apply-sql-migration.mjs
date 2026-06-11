import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(projectRoot, ".env.local");
const migrationArg = process.argv[2];

if (!migrationArg) {
  throw new Error("Usage: node scripts/apply-sql-migration.mjs <migration.sql>");
}

const env = {
  ...parseEnvFile(envPath),
  ...process.env,
};

const databaseUrl = env.DATABASE_URL ?? env.DATABASE_URL3;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is missing from .env.local.");
}

const migrationPath = path.resolve(projectRoot, migrationArg);
const sql = fs.readFileSync(migrationPath, "utf8");

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 1,
  connectionTimeoutMillis: 8000,
  query_timeout: 20000,
});

try {
  await pool.query(sql);
  console.log(`Applied migration: ${path.relative(projectRoot, migrationPath)}`);
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
