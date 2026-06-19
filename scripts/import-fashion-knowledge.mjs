import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
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

const cardsPath = path.join(projectRoot, "knowledge", "fashion-knowledge.cards.v1.json");
const deck = JSON.parse(fs.readFileSync(cardsPath, "utf8"));
const cards = deck.cards;
const embeddingDimensions = Number(env.AI_EMBEDDING_DIMENSIONS ?? 1024);

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 1,
  connectionTimeoutMillis: Number(env.DATABASE_CONNECT_TIMEOUT_MS ?? 15000),
  query_timeout: Number(env.DATABASE_QUERY_TIMEOUT_MS ?? 60000),
});

try {
  const embeddings = await createEmbeddings(cards.map((card) => card.embedding_text));

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const tags = unique([
      ...(card.category_tags ?? []),
      ...(card.color_tags ?? []),
      ...(card.style_tags ?? []),
      ...(card.scenario_tags ?? []),
      ...(card.fit_tags ?? []),
      ...(card.fabric_tags ?? []),
      ...(card.risk_tags ?? []),
      ...(card.value_tags ?? []),
    ]);

    await pool.query(
      `
        insert into public.fashion_knowledge (
          card_id,
          topic,
          tags,
          content,
          source_type,
          embedding_text,
          embedding,
          knowledge_type,
          locale,
          taxonomy_version,
          category_tags,
          color_tags,
          style_tags,
          scenario_tags,
          fit_tags,
          fabric_tags,
          risk_tags,
          value_tags,
          applicable_items,
          not_applicable_items,
          decision_points,
          outfit_suggestions,
          risk_signals,
          decision_bias,
          source_refs,
          metadata,
          priority,
          status,
          updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24::jsonb, $25, $26::jsonb, $27, $28, now()
        )
        on conflict (card_id) where card_id is not null do update set
          topic = excluded.topic,
          tags = excluded.tags,
          content = excluded.content,
          source_type = excluded.source_type,
          embedding_text = excluded.embedding_text,
          embedding = excluded.embedding,
          knowledge_type = excluded.knowledge_type,
          locale = excluded.locale,
          taxonomy_version = excluded.taxonomy_version,
          category_tags = excluded.category_tags,
          color_tags = excluded.color_tags,
          style_tags = excluded.style_tags,
          scenario_tags = excluded.scenario_tags,
          fit_tags = excluded.fit_tags,
          fabric_tags = excluded.fabric_tags,
          risk_tags = excluded.risk_tags,
          value_tags = excluded.value_tags,
          applicable_items = excluded.applicable_items,
          not_applicable_items = excluded.not_applicable_items,
          decision_points = excluded.decision_points,
          outfit_suggestions = excluded.outfit_suggestions,
          risk_signals = excluded.risk_signals,
          decision_bias = excluded.decision_bias,
          source_refs = excluded.source_refs,
          metadata = excluded.metadata,
          priority = excluded.priority,
          status = excluded.status,
          updated_at = now()
      `,
      [
        card.card_id,
        card.topic,
        tags,
        card.content,
        card.source_type ?? "curated",
        card.embedding_text,
        toPgVector(embeddings[index]),
        card.knowledge_type,
        card.locale,
        card.taxonomy_version,
        card.category_tags ?? [],
        card.color_tags ?? [],
        card.style_tags ?? [],
        card.scenario_tags ?? [],
        card.fit_tags ?? [],
        card.fabric_tags ?? [],
        card.risk_tags ?? [],
        card.value_tags ?? [],
        card.applicable_items ?? [],
        card.not_applicable_items ?? [],
        card.decision_points ?? [],
        card.outfit_suggestions ?? [],
        card.risk_signals ?? [],
        JSON.stringify(card.decision_bias ?? {}),
        card.source_refs ?? [],
        JSON.stringify({
          deckVersion: deck.version,
          deckStatus: deck.status,
          importedFrom: "knowledge/fashion-knowledge.cards.v1.json",
        }),
        100,
        "active",
      ],
    );
  }

  const count = await pool.query(
    "select count(*)::int as count from public.fashion_knowledge where taxonomy_version = 'v1' and status = 'active'",
  );
  console.log(
    JSON.stringify(
      {
        imported: cards.length,
        activeV1KnowledgeRows: count.rows[0]?.count,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}

async function createEmbeddings(texts) {
  if (!env.SILICONFLOW_API_KEY) {
    return texts.map((text) => createDeterministicEmbedding(text, embeddingDimensions));
  }

  const client = new OpenAI({
    apiKey: env.SILICONFLOW_API_KEY,
    baseURL: env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1",
    maxRetries: 0,
    timeout: Number(env.AI_PROVIDER_TIMEOUT_MS ?? 30000),
  });

  try {
    const result = [];
    const batchSize = Number(env.KNOWLEDGE_EMBEDDING_BATCH_SIZE ?? 16);

    for (let index = 0; index < texts.length; index += batchSize) {
      const batch = texts.slice(index, index + batchSize);
      const response = await client.embeddings.create({
        model: env.AI_EMBEDDING_MODEL ?? "BAAI/bge-m3",
        input: batch,
      });
      result.push(
        ...response.data.map((item) =>
          normalizeEmbedding(item.embedding ?? [], embeddingDimensions),
        ),
      );
    }

    if (result.length === texts.length) return result;
  } catch (error) {
    console.warn("[knowledge-import] embedding fallback used", {
      message: error instanceof Error ? error.message : "Embedding request failed.",
    });
  }

  return texts.map((text) => createDeterministicEmbedding(text, embeddingDimensions));
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function createDeterministicEmbedding(text, dimensions) {
  const values = new Array(dimensions).fill(0);

  for (let index = 0; index < text.length; index += 1) {
    const bucket = index % dimensions;
    values[bucket] += (text.charCodeAt(index) % 97) / 97;
  }

  return normalizeEmbedding(values, dimensions);
}

function normalizeEmbedding(embedding, dimensions) {
  if (embedding.length === dimensions) return embedding;
  if (embedding.length > dimensions) return embedding.slice(0, dimensions);

  return [...embedding, ...new Array(dimensions - embedding.length).fill(0)];
}

function toPgVector(embedding) {
  return `[${embedding.map((value) => Number(value.toFixed(8))).join(",")}]`;
}
