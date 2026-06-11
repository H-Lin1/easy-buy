import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultImage = path.join(
  projectRoot,
  "resources",
  "closet",
  "微信图片_20260610124204_332_2.jpg",
);

const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const testEmail = env.test_User ?? env.TEST_USER;
const testPassword = env.test_Password ?? env.TEST_PASSWORD;
const appUrl = env.TEST_APP_URL ?? "http://127.0.0.1:3000";
const inputImage = path.resolve(process.argv[2] ?? defaultImage);

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.");
}

if (!testEmail || !testPassword) {
  throw new Error("test_User or test_Password is missing from .env.local.");
}

if (!fs.existsSync(inputImage)) {
  throw new Error(`Input image does not exist: ${inputImage}`);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
  email: testEmail,
  password: testPassword,
});

if (authError || !authData.user || !authData.session) {
  throw new Error(`Test account sign-in failed: ${authError?.message ?? "missing session"}`);
}

const userId = authData.user.id;
const imagePath = `${userId}/analysis-e2e/${crypto.randomUUID()}${path.extname(inputImage).toLowerCase()}`;
const imageBuffer = fs.readFileSync(inputImage);

const { error: uploadError } = await supabase.storage.from("closet-images").upload(imagePath, imageBuffer, {
  cacheControl: "3600",
  contentType: getMimeType(inputImage),
  upsert: false,
});

if (uploadError) throw uploadError;

const { data: inserted, error: insertError } = await supabase
  .from("closet_items")
  .insert({
    user_id: userId,
    image_path: imagePath,
    processed_image_path: null,
    display_image_path: null,
    display_image_status: "not_started",
    display_image_model: null,
    display_image_prompt_version: null,
    image_quality_flags: ["original_saved", "closet_analysis_queued", "needs_ai_label_confirmation"],
    category: "待识别",
    color: "待识别",
    fit: "unknown",
    style_tags: ["待识别"],
    scenario_tags: [],
    season: [],
    wear_frequency: "unknown",
    status: "active",
    summary: path.basename(inputImage, path.extname(inputImage)),
    embedding_text: null,
    ai_confidence: null,
    user_corrected: false,
  })
  .select("id,image_path")
  .single();

if (insertError) throw insertError;

const response = await fetch(`${appUrl.replace(/\/$/, "")}/api/ai/analyze-closet-item`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${authData.session.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    closetItemId: inserted.id,
    imagePath: inserted.image_path,
    originalImageDataUrl: imageToDataUrl(inputImage),
    fileName: path.basename(inputImage),
  }),
});

const text = await response.text();
let result;

try {
  result = JSON.parse(text);
} catch {
  throw new Error(`Route response is not JSON: ${text.slice(0, 500)}`);
}

if (!response.ok) {
  throw new Error(`Route failed ${response.status}: ${result?.message ?? text.slice(0, 500)}`);
}

const item = result.item;
if (!item || item.category === "待识别" || !Array.isArray(item.style_tags) || !item.style_tags.length) {
  throw new Error(`Analysis result was not persisted correctly: ${JSON.stringify(item)}`);
}

console.log("Closet analysis route test passed.");
console.log(
  JSON.stringify(
    {
      closetItemId: item.id,
      summary: item.summary,
      category: item.category,
      color: item.color,
      fit: item.fit,
      styleTags: item.style_tags,
      scenarioTags: item.scenario_tags,
      aiConfidence: item.ai_confidence,
      userCorrected: item.user_corrected,
      imageQualityFlags: item.image_quality_flags,
    },
    null,
    2,
  ),
);

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
