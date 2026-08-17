import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";

import {
  requireSupportedAiScriptProvider,
  sanitizeAiScriptError,
} from "./ai-script-utils.mjs";

const env = {
  ...parseEnvFile(path.join(process.cwd(), ".env.local")),
  ...process.env,
};

if (!env.AI_DECISION2_API_KEY) throw new Error("AI_DECISION2_API_KEY is missing.");
const provider = requireSupportedAiScriptProvider(
  "decision",
  env.AI_DECISION2_PROVIDER ?? "tripo",
  ["tripo"],
);

const client = new OpenAI({
  apiKey: env.AI_DECISION2_API_KEY,
  baseURL: env.AI_DECISION2_BASE_URL ?? "https://lumina.tripo3d.com/v1",
  timeout: Number(env.AI_DECISION2_TIMEOUT_MS ?? 60000),
  maxRetries: 0,
});

const startedAt = Date.now();

try {
  const response = await client.chat.completions.create({
    model: env.AI_DECISION2_MODEL ?? "gpt-5.6-terra",
    messages: [
      { role: "system", content: "只输出严格 JSON，不要输出 Markdown。" },
      {
        role: "user",
        content:
          '请输出 {"ok":true,"summary":"模型连通性测试"}，不要添加其他字段。',
      },
    ],
    temperature: 0.1,
    max_tokens: 100,
    response_format: { type: "json_object" },
  });

  console.log(
    JSON.stringify(
      {
        elapsedMs: Date.now() - startedAt,
        provider,
        model: env.AI_DECISION2_MODEL ?? "gpt-5.6-terra",
        content: response.choices[0]?.message?.content,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        elapsedMs: Date.now() - startedAt,
        model: env.AI_DECISION2_MODEL ?? "gpt-5.6-terra",
        error: sanitizeAiScriptError(error, [env.AI_DECISION2_API_KEY]),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
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
