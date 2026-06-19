import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.join(projectRoot, "resources", "closet");
const outputDir = path.join(projectRoot, "resources", "ai-workflow-test");
const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

const appUrl = env.TEST_APP_URL ?? "http://127.0.0.1:3000";
const imageFiles = fs
  .readdirSync(resourcesDir)
  .filter((fileName) => [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(fileName).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, "zh-CN"))
  .slice(0, 3)
  .map((fileName) => path.join(resourcesDir, fileName));

assertRequiredEnv([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SILICONFLOW_API_KEY",
  "AUTODL_API_KEY",
]);

const testEmail = env.test_User ?? env.TEST_USER;
const testPassword = env.test_Password ?? env.TEST_PASSWORD;
if (!testEmail || !testPassword) {
  throw new Error("test_User/test_Password is missing from .env.local.");
}

if (imageFiles.length < 3) {
  throw new Error(`Need at least 3 test images in ${resourcesDir}.`);
}

fs.mkdirSync(outputDir, { recursive: true });

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const serviceSupabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const report = {
  testedAt: new Date().toISOString(),
  appUrl,
  images: imageFiles.map((filePath) => path.basename(filePath)),
  keepData: env.E2E_KEEP_DATA === "true",
  checks: {},
  createdClosetItemIds: [],
  createdStoragePaths: [],
};

try {
  report.checks.health = await checkHealth();
  report.checks.knowledge = await checkKnowledgeRetrieval();

  const authData = await signIn();
  report.userId = authData.user.id;
  report.cleanupBefore = await cleanupE2eClosetData(authData.user.id);

  const closetResults = [];
  for (let index = 0; index < 2; index += 1) {
    closetResults.push(await testClosetImage(authData, imageFiles[index], index === 0));
  }
  report.checks.closet = closetResults;

  report.checks.purchaseDecision = await testPurchaseDecision(authData, imageFiles[2]);
  report.summary = buildSummary(report);
  if (!report.keepData) {
    report.cleanupAfter = await cleanupE2eClosetData(authData.user.id);
  }

  const outputPath = path.join(outputDir, `ai-workflow-e2e-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(path.join(outputDir, "latest.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Full report saved: ${outputPath}`);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  if (report.userId && !report.keepData) {
    report.cleanupAfterFailure = await cleanupE2eClosetData(report.userId).catch((cleanupError) => ({
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    }));
  }
  const outputPath = path.join(outputDir, `ai-workflow-e2e-failed-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.error(JSON.stringify({ error: report.error, reportPath: outputPath }, null, 2));
  process.exitCode = 1;
}

async function cleanupE2eClosetData(userId) {
  const prefix = `${userId}/e2e-ai-workflow/%`;
  const { data: rows, error: selectError } = await serviceSupabase
    .from("closet_items")
    .select("id,image_path,processed_image_path,display_image_path")
    .eq("user_id", userId)
    .like("image_path", prefix);

  if (selectError) throw selectError;

  const ids = (rows ?? []).map((row) => row.id);
  const storagePaths = [
    ...new Set(
      (rows ?? [])
        .flatMap((row) => [row.image_path, row.processed_image_path, row.display_image_path])
        .filter(Boolean),
    ),
  ];

  for (let index = 0; index < storagePaths.length; index += 100) {
    const batch = storagePaths.slice(index, index + 100);
    if (!batch.length) continue;
    const { error } = await serviceSupabase.storage.from("closet-images").remove(batch);
    if (error) {
      console.warn(`[e2e-cleanup] storage cleanup warning: ${error.message}`);
    }
  }

  if (ids.length) {
    const { error: deleteError } = await serviceSupabase.from("closet_items").delete().in("id", ids);
    if (deleteError) throw deleteError;
  }

  return {
    removedClosetRows: ids.length,
    removedStorageObjects: storagePaths.length,
  };
}

async function checkHealth() {
  const response = await fetch(`${appUrl.replace(/\/$/, "")}/api/health`);
  const data = await parseJsonResponse(response, "health");

  if (!data.ok || !data.databaseReachable || !data.supabaseConfigured) {
    throw new Error(`Health check failed: ${JSON.stringify(data)}`);
  }

  return data;
}

async function checkKnowledgeRetrieval() {
  const { count, error: countError } = await serviceSupabase
    .from("fashion_knowledge")
    .select("card_id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("taxonomy_version", "v1");

  if (countError) throw countError;
  if (!count || count < 80) {
    throw new Error(`Knowledge table has too few active v1 cards: ${count}`);
  }

  const embedding = await embedQuery("米白 背心 重复购买 通勤 日常 长期主义 搭配");
  const { data, error } = await serviceSupabase.rpc("match_fashion_knowledge", {
    query_embedding: toPgVector(embedding),
    match_count: 8,
  });

  if (error) throw error;
  if (!data?.length) {
    throw new Error("match_fashion_knowledge returned no rows.");
  }

  return {
    activeV1Count: count,
    rpcReturned: data.length,
    topTopics: data.slice(0, 5).map((item) => ({
      cardId: item.card_id,
      topic: item.topic,
      similarity: Number(item.similarity?.toFixed?.(4) ?? item.similarity),
      tags: item.tags?.slice?.(0, 8) ?? [],
    })),
    hasLongTermKnowledge: data.some((item) =>
      `${item.topic} ${(item.tags ?? []).join(" ")}`.includes("长期"),
    ),
  };
}

async function signIn() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });

  if (error || !data.user || !data.session) {
    throw new Error(`Test account sign-in failed: ${error?.message ?? "missing session"}`);
  }

  return data;
}

async function testClosetImage(authData, imagePath, shouldGenerateDisplayImage) {
  const inserted = await createClosetItem(authData.user.id, imagePath);
  let display = null;

  if (shouldGenerateDisplayImage) {
    display = await callRoute("/api/ai/generate-closet-display-image", authData.session.access_token, {
      closetItemId: inserted.id,
      imagePath: inserted.image_path,
      imageDataUrl: imageToDataUrl(imagePath),
    });

    if (!display.item?.display_image_path || display.item?.display_image_status !== "ready") {
      throw new Error(`Display image generation did not persist ready state: ${JSON.stringify(display.item)}`);
    }
    report.createdStoragePaths.push(display.item.display_image_path);
  }

  const displayImageDataUrl = display?.item?.display_image_path
    ? await storagePathToDataUrl("closet-images", display.item.display_image_path)
    : undefined;

  const analysis = await callRoute("/api/ai/analyze-closet-item", authData.session.access_token, {
    closetItemId: inserted.id,
    imagePath: inserted.image_path,
    originalImageDataUrl: imageToDataUrl(imagePath),
    displayImageDataUrl,
    fileName: path.basename(imagePath),
  });

  if (!analysis.item || analysis.item.category === "待识别" || !analysis.item.embedding_text) {
    throw new Error(`Closet analysis did not persist usable labels: ${JSON.stringify(analysis.item)}`);
  }

  const draft = {
    name: analysis.analysis.itemName ?? analysis.item.summary ?? path.basename(imagePath, path.extname(imagePath)),
    category: analysis.analysis.category ?? analysis.item.category,
    color: analysis.analysis.color ?? analysis.item.color ?? "unknown",
    fit: analysis.analysis.fit ?? analysis.item.fit ?? "unknown",
    styleTags: normalizeTags(analysis.analysis.styleTags ?? analysis.item.style_tags, ["休闲"]),
    scenarioTags: normalizeTags(analysis.analysis.scenarioTags ?? analysis.item.scenario_tags, ["日常出街"]),
    seasonTags: normalizeTags(analysis.analysis.season ?? analysis.item.season, ["all-season"]),
    wearFrequency: "often",
  };

  const confirmation = await callRoute("/api/ai/confirm-closet-item", authData.session.access_token, {
    closetItemId: inserted.id,
    draft,
  });

  if (!confirmation.item?.user_corrected || !confirmation.item?.embedding_text) {
    throw new Error(`Closet confirmation did not write embedding/user_corrected: ${JSON.stringify(confirmation.item)}`);
  }

  return {
    fileName: path.basename(imagePath),
    closetItemId: inserted.id,
    displayImageStatus: display?.item?.display_image_status ?? "not_tested",
    analysis: {
      itemName: analysis.analysis.itemName,
      category: analysis.analysis.category,
      color: analysis.analysis.color,
      fit: analysis.analysis.fit,
      styleTags: analysis.analysis.styleTags,
      scenarioTags: analysis.analysis.scenarioTags,
      materialGuess: analysis.analysis.materialGuess,
      confidence: analysis.analysis.aiConfidence,
      imageQualityFlags: analysis.analysis.imageQualityFlags,
      reviewReasons: analysis.analysis.reviewReasons,
    },
    confirmation: {
      userCorrected: confirmation.item.user_corrected,
      hasEmbeddingText: Boolean(confirmation.item.embedding_text),
      embeddingText: confirmation.embeddingText,
      flags: confirmation.item.image_quality_flags,
    },
  };
}

async function testPurchaseDecision(authData, imagePath) {
  const response = await callRoute("/api/ai/assess-purchase", authData.session.access_token, {
    message:
      "这件衣服值得买吗？请从长期主义、是否能和我的真实衣橱搭配、是否重复购买、是否有新的穿搭灵感来判断。",
    imageDataUrl: imageToDataUrl(imagePath),
  });

  const reportData = response.report;
  if (!reportData) throw new Error(`Purchase decision did not return report: ${JSON.stringify(response)}`);
  if (!reportData.usedModel) {
    throw new Error("Purchase decision fell back to rule-only report; expected decision model to run.");
  }
  if (!reportData.knowledgeSnippets?.length) {
    throw new Error("Purchase decision did not include retrieved knowledge snippets.");
  }
  if (!reportData.retrievedClosetItems?.length) {
    throw new Error("Purchase decision did not retrieve real closet matches.");
  }

  return {
    candidate: {
      productName: reportData.candidate?.productName,
      category: reportData.candidate?.category,
      color: reportData.candidate?.color,
      fit: reportData.candidate?.fit,
      styleTags: reportData.candidate?.styleTags,
      possibleScenarios: reportData.candidate?.possibleScenarios,
    },
    decision: reportData.decision,
    decisionLabel: reportData.decisionLabel,
    usedModel: reportData.usedModel,
    confidence: reportData.confidence,
    scores: reportData.scores,
    summary: reportData.summary,
    reasonsToBuy: reportData.reasonsToBuy,
    reasonsToSave: reportData.reasonsToSave,
    risks: reportData.risks,
    closetItemCount: response.closetItemCount,
    retrievedClosetItems: reportData.retrievedClosetItems.slice(0, 8).map((match) => ({
      name: match.item?.name,
      category: match.item?.category,
      matchType: match.matchType,
      score: match.score,
      reason: match.reason,
    })),
    knowledgeSnippets: reportData.knowledgeSnippets.slice(0, 8).map((snippet) => ({
      cardId: snippet.cardId,
      topic: snippet.topic,
      tags: snippet.tags?.slice(0, 10),
      score: snippet.score,
      decisionPoints: snippet.decisionPoints?.slice(0, 3),
      riskSignals: snippet.riskSignals?.slice(0, 3),
      outfitSuggestions: snippet.outfitSuggestions?.slice(0, 3),
    })),
    outfitCombinations: reportData.outfitCombinations?.map((combination) => ({
      title: combination.title,
      scenario: combination.scenario,
      items: combination.items,
      summary: combination.summary,
      visualItemCount: combination.visualItems?.length ?? 0,
    })),
  };
}

async function createClosetItem(userId, imagePath) {
  const extension = path.extname(imagePath).toLowerCase();
  const storagePath = `${userId}/e2e-ai-workflow/${crypto.randomUUID()}${extension}`;
  const imageBuffer = fs.readFileSync(imagePath);

  const { error: uploadError } = await supabase.storage.from("closet-images").upload(storagePath, imageBuffer, {
    cacheControl: "3600",
    contentType: getMimeType(imagePath),
    upsert: false,
  });
  if (uploadError) throw uploadError;
  report.createdStoragePaths.push(storagePath);

  const { data, error } = await supabase
    .from("closet_items")
    .insert({
      user_id: userId,
      image_path: storagePath,
      processed_image_path: null,
      display_image_path: null,
      display_image_status: "queued",
      display_image_model: null,
      display_image_prompt_version: null,
      image_quality_flags: ["original_saved", "display_image_queued", "closet_analysis_queued", "needs_ai_label_confirmation"],
      category: "待识别",
      color: "待识别",
      fit: "unknown",
      style_tags: ["待识别"],
      scenario_tags: [],
      season: [],
      wear_frequency: "unknown",
      status: "active",
      summary: path.basename(imagePath, path.extname(imagePath)),
      embedding_text: null,
      ai_confidence: null,
      user_corrected: false,
    })
    .select("id,image_path")
    .single();

  if (error) throw error;
  report.createdClosetItemIds.push(data.id);
  return data;
}

async function callRoute(route, accessToken, body) {
  const response = await fetch(`${appUrl.replace(/\/$/, "")}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return parseJsonResponse(response, route);
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label} response is not JSON: ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`${label} failed ${response.status}: ${data?.message ?? text.slice(0, 500)}`);
  }

  return data;
}

async function storagePathToDataUrl(bucket, storagePath) {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) throw error;

  const buffer = Buffer.from(await data.arrayBuffer());
  const extension = path.extname(storagePath).toLowerCase();
  const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function embedQuery(text) {
  const client = new OpenAI({
    apiKey: env.SILICONFLOW_API_KEY,
    baseURL: env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1",
    timeout: Number(env.AI_PROVIDER_TIMEOUT_MS ?? 30000),
    maxRetries: 0,
  });

  const response = await client.embeddings.create({
    model: env.AI_EMBEDDING_MODEL ?? "BAAI/bge-m3",
    input: text,
  });

  const embedding = response.data[0]?.embedding;
  if (!embedding?.length) throw new Error("Embedding API returned no vector.");
  return normalizeEmbedding(embedding, Number(env.AI_EMBEDDING_DIMENSIONS ?? 1024));
}

function buildSummary(fullReport) {
  const purchase = fullReport.checks.purchaseDecision;
  return {
    healthOk: Boolean(fullReport.checks.health?.ok),
    knowledge: fullReport.checks.knowledge,
    closetNodes: fullReport.checks.closet.map((item) => ({
      fileName: item.fileName,
      displayImageStatus: item.displayImageStatus,
      category: item.analysis.category,
      color: item.analysis.color,
      confidence: item.analysis.confidence,
      confirmedWithEmbedding: item.confirmation.userCorrected && item.confirmation.hasEmbeddingText,
    })),
    purchaseDecision: {
      candidate: purchase.candidate,
      decision: purchase.decision,
      decisionLabel: purchase.decisionLabel,
      usedModel: purchase.usedModel,
      knowledgeTopics: purchase.knowledgeSnippets.map((snippet) => snippet.topic),
      closetMatches: purchase.retrievedClosetItems.slice(0, 5),
      outfitCombinations: purchase.outfitCombinations,
    },
  };
}

function imageToDataUrl(filePath) {
  const base64 = fs.readFileSync(filePath).toString("base64");
  return `data:${getMimeType(filePath)};base64,${base64}`;
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function normalizeTags(values, fallback) {
  const tags = [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].filter(
    (value) => value !== "待识别" && value !== "unknown",
  );
  return tags.length ? tags : fallback;
}

function normalizeEmbedding(embedding, dimensions) {
  if (embedding.length === dimensions) return embedding;
  if (embedding.length > dimensions) return embedding.slice(0, dimensions);
  return [...embedding, ...new Array(dimensions - embedding.length).fill(0)];
}

function toPgVector(embedding) {
  return `[${embedding.map((value) => Number(value.toFixed(8))).join(",")}]`;
}

function assertRequiredEnv(names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required env: ${missing.join(", ")}`);
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
