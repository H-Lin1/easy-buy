import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, "resources", "ai-workflow-test", "outfit-prompt-ab");
const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
  email: env.test_User ?? env.TEST_USER,
  password: env.test_Password ?? env.TEST_PASSWORD,
});
if (authError || !authData.session || !authData.user) {
  throw new Error(`Sign-in failed: ${authError?.message ?? "missing session"}`);
}

const authedSupabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${authData.session.access_token}` } },
});

const { data: reports, error: reportsError } = await authedSupabase
  .from("assessment_reports")
  .select("id,candidate_id,outfit_combinations,retrieved_context,created_at")
  .eq("user_id", authData.user.id)
  .order("created_at", { ascending: false })
  .limit(30);
if (reportsError) throw reportsError;

const selectedReport = (reports ?? []).find((report) =>
  Array.isArray(report.outfit_combinations) &&
  report.outfit_combinations.some(
    (outfit) => Array.isArray(outfit?.closetItemIds) && outfit.closetItemIds.length > 0,
  ),
);
if (!selectedReport) throw new Error("No report with an outfit and closet sources was found.");

const selectedOutfit = selectedReport.outfit_combinations.find(
  (outfit) => Array.isArray(outfit?.closetItemIds) && outfit.closetItemIds.length > 0,
);
const sourceIds = selectedOutfit.closetItemIds.filter((value) => typeof value === "string");

const [{ data: candidate, error: candidateError }, { data: closetItems, error: closetError }] =
  await Promise.all([
    authedSupabase
      .from("purchase_candidates")
      .select("id,screenshot_path,product_name,category,color")
      .eq("id", selectedReport.candidate_id)
      .maybeSingle(),
    authedSupabase
      .from("closet_items")
      .select("id,image_path,processed_image_path,display_image_path,category,color,summary")
      .in("id", sourceIds),
  ]);
if (candidateError) throw candidateError;
if (closetError) throw closetError;
if (!candidate) throw new Error("Candidate not found.");

const selectedClosetItems = sourceIds
  .map((id) => closetItems.find((item) => item.id === id))
  .filter(Boolean);
if (selectedClosetItems.length !== sourceIds.length) throw new Error("Some closet sources are missing.");

const [modelBuffer, candidateBuffer, ...closetBuffers] = await Promise.all([
  fsp.readFile(path.join(projectRoot, "public/images/outfit-try-on-model-reference.png")),
  downloadImage(authedSupabase, "purchase-screenshots", candidate.screenshot_path),
  ...selectedClosetItems.map((item) =>
    downloadImage(
      authedSupabase,
      "closet-images",
      item.display_image_path ?? item.processed_image_path ?? item.image_path,
    ),
  ),
]);

const promptModule = await import(
  pathToFileURL(path.join(projectRoot, "src/lib/ai/outfit-try-on-prompt.ts")),
);
const promptArgs = {
  candidate: {
    productName: candidate.product_name ?? "待买商品",
    category: candidate.category ?? "衣服",
    color: candidate.color ?? "以参考图为准",
  },
  outfit: {
    title: selectedOutfit.title ?? "日常搭配",
    scenario: selectedOutfit.scenario ?? "日常",
    summary: selectedOutfit.summary ?? "",
  },
};
const imageInputs = [modelBuffer, candidateBuffer, ...closetBuffers];
const oldPrompt = buildLegacyPrompt(candidate, selectedOutfit);
const oldNegativePrompt = buildLegacyNegativePrompt();
const newPrompt = promptModule.buildOutfitTryOnPrompt(promptArgs.candidate, promptArgs.outfit);
const newNegativePrompt = promptModule.buildOutfitTryOnNegativePrompt();

await fsp.mkdir(outputDir, { recursive: true });
await fsp.writeFile(
  path.join(outputDir, "inputs.json"),
  JSON.stringify(
    {
      reportId: selectedReport.id,
      reportCreatedAt: selectedReport.created_at,
      outfitTitle: selectedOutfit.title,
      sourceIds,
      sourcePaths: selectedClosetItems.map((item) => ({
        closetItemId: item.id,
        name: item.summary ?? item.category ?? "衣橱单品",
        path: item.display_image_path ?? item.processed_image_path ?? item.image_path,
      })),
      request: {
        provider: env.AI_IMAGE_EDIT_PROVIDER,
        model: env.AI_IMAGE_EDIT_MODEL,
        imageCount: imageInputs.length,
        quality: "provider default (unchanged for prompt A/B)",
        size: "provider default (unchanged for prompt A/B)",
      },
    },
    null,
    2,
  ),
);

const results = await Promise.all([
  runGeneration("legacy", oldPrompt, oldNegativePrompt),
  runGeneration("v3-lifestyle", newPrompt, newNegativePrompt),
]);
await fsp.writeFile(path.join(outputDir, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ outputDir, reportId: selectedReport.id, sourceIds, results }, null, 2));

async function runGeneration(label, prompt, negativePrompt) {
  const formData = new FormData();
  formData.append("model", env.AI_IMAGE_EDIT_MODEL);
  formData.append(
    "prompt",
    `${prompt.trim()}\n\nAdditional negative constraints (must not appear):\n${negativePrompt.trim()}`,
  );
  imageInputs.forEach((buffer, index) => {
    const extension = index === 0 ? ".png" : ".jpg";
    const mimeType = index === 0 ? "image/png" : "image/jpeg";
    formData.append("image[]", new Blob([buffer], { type: mimeType }), `input-${index + 1}${extension}`);
  });

  const startedAt = Date.now();
  const response = await fetch(`${env.AI_IMAGE_EDIT_BASE_URL.replace(/\/$/, "")}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AI_IMAGE_EDIT_API_KEY}` },
    body: formData,
    signal: AbortSignal.timeout(Number(env.AI_IMAGE_EDIT_TIMEOUT_MS ?? 180000)),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${label} request failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  const output = findOutput(payload);
  if (!output) throw new Error(`${label} response did not contain an image.`);
  const fileBody = output.kind === "base64"
    ? Buffer.from(output.value.replace(/^data:image\/\w+;base64,/, ""), "base64")
    : Buffer.from(await (await fetch(output.value)).arrayBuffer());
  const outputPath = path.join(outputDir, `${label}.png`);
  await fsp.writeFile(outputPath, fileBody);
  const metadata = await sharp(fileBody).metadata();
  return {
    label,
    elapsedMs: Date.now() - startedAt,
    outputPath,
    width: metadata.width,
    height: metadata.height,
    bytes: fileBody.length,
  };
}

async function downloadImage(client, bucket, imagePath) {
  const { data, error } = await client.storage.from(bucket).download(imagePath);
  if (error || !data) throw error ?? new Error(`Missing storage object: ${bucket}/${imagePath}`);
  return Buffer.from(await data.arrayBuffer());
}

function findOutput(payload) {
  for (const field of ["images", "data"]) {
    if (!Array.isArray(payload?.[field])) continue;
    for (const entry of payload[field]) {
      if (typeof entry?.url === "string" && entry.url.trim()) return { kind: "url", value: entry.url.trim() };
      if (typeof entry?.b64_json === "string" && entry.b64_json.trim()) return { kind: "base64", value: entry.b64_json };
    }
  }
  return undefined;
}

function buildLegacyPrompt(candidate, outfit) {
  return [
    "Create one photorealistic full-body fashion try-on photograph from the supplied image references.",
    "Image 1 is the identity, body proportion, pose, framing, lighting, and background reference only. Preserve this exact adult model's face, hair, body proportions, neutral standing pose, camera angle, full head-to-toe framing, studio lighting, and warm light-gray background. Completely ignore and replace every garment and shoe originally worn in Image 1; their colors, shapes, and materials are not outfit references.",
    "Image 2 is the candidate garment and its pixels are the primary visual source of truth. Preserve its exact visible color and undertone under neutral studio lighting, plus its material, texture, pattern, collar or neckline, sleeve length, hem length, silhouette, and distinctive construction details. Do not normalize, reinterpret, or borrow its color from Image 1 or from text metadata.",
    "Images 3 onward are wardrobe garments for this outfit, in source order. Use every supplied wardrobe garment exactly once and preserve the visible appearance of each corresponding image.",
    `Candidate garment: ${candidate.product_name ?? "待买商品"}; category: ${candidate.category ?? "衣服"}; catalog color metadata: ${candidate.color ?? "以参考图为准"}.`,
    `Outfit: ${outfit.title ?? "日常搭配"}; scenario: ${outfit.scenario ?? "日常"}. ${outfit.summary ?? ""}`,
    "When text metadata conflicts with a garment image, follow the garment image pixels. Do not invent, omit, recolor, replace, or duplicate garments, and do not add unreferenced accessories.",
    "Resolve natural layering according to garment category. Produce only the final clean studio photograph, never the input images, labels, panels, product grids, or a collage.",
    "This is a styling visualization, not a body-shape or size-fit guarantee.",
  ].join("\n");
}

function buildLegacyNegativePrompt() {
  return [
    "different person, changed face, changed hair, altered body shape, cropped head, cropped feet",
    "extra person, extra limbs, malformed hands, duplicate garment, missing garment, invented accessory",
    "inherited model-reference clothing, changed garment color, changed undertone, changed pattern, changed fabric, changed silhouette, logo, text, watermark",
    "collage, split screen, reference board, product grid, labels, captions, frame, border",
    "dramatic pose, seated pose, runway background, outdoor background, mirror selfie",
  ].join(", ");
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex < 0) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
