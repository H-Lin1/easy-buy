import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};
const appUrl = env.TEST_APP_URL ?? "http://127.0.0.1:3000";
const testEmail = env.test_User ?? env.TEST_USER;
const testPassword = env.test_Password ?? env.TEST_PASSWORD;
const imagePath =
  process.argv[2] ??
  path.join(projectRoot, "resources", "closet", "微信图片_20260610124204_332_2.jpg");

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  throw new Error("Supabase browser env is missing.");
}
if (!testEmail || !testPassword) {
  throw new Error("test_User/test_Password is missing.");
}
if (!fs.existsSync(imagePath)) {
  throw new Error(`Image does not exist: ${imagePath}`);
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { data, error } = await supabase.auth.signInWithPassword({
  email: testEmail,
  password: testPassword,
});

if (error || !data.session) {
  throw new Error(`Sign in failed: ${error?.message ?? "missing session"}`);
}

const startedAt = Date.now();
const response = await fetch(`${appUrl.replace(/\/$/, "")}/api/ai/assess-purchase`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    message:
      "这件衣服值得买吗？请只判断它能否和我的真实衣橱形成自然、可复用的搭配组合，不要讨论重复购买或替代灵感。",
    imageDataUrl: imageToDataUrl(imagePath),
  }),
});
const elapsedMs = Date.now() - startedAt;
const text = await response.text();
let result;
try {
  result = JSON.parse(text);
} catch {
  throw new Error(`Response is not JSON: ${text.slice(0, 500)}`);
}

if (!response.ok) {
  throw new Error(`Request failed ${response.status}: ${result.message ?? text.slice(0, 500)}`);
}

const report = result.report;
console.log(
  JSON.stringify(
    {
      elapsedMs,
      elapsedSeconds: Number((elapsedMs / 1000).toFixed(1)),
      usedModel: report?.usedModel,
      decision: report?.decision,
      decisionLabel: report?.decisionLabel,
      candidate: report?.candidate
        ? {
            productName: report.candidate.productName,
            category: report.candidate.category,
            color: report.candidate.color,
            fit: report.candidate.fit,
          }
        : null,
      closetItemCount: result.closetItemCount,
      closetMatches: report?.retrievedClosetItems?.length,
      knowledgeTopics: report?.knowledgeSnippets?.slice(0, 8).map((item) => item.topic),
      summary: report?.summary,
    },
    null,
    2,
  ),
);

function imageToDataUrl(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const result = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
