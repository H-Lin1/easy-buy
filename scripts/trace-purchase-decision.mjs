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
const args = parseArgs(process.argv.slice(2));
const appUrl = args.appUrl ?? env.TEST_APP_URL ?? "http://127.0.0.1:3000";
const outputDir = path.resolve(projectRoot, args.out ?? path.join("resources", "purchase-trace"));
const message =
  args.message ??
  "这件衣服值得买吗？请展示完整决策链路，特别是它能和我的衣橱形成哪些真实搭配组合。";
const imagePath = args.noImage ? undefined : resolveImagePath(args.image ?? args._[0]);
const testEmail = env.test_User ?? env.TEST_USER;
const testPassword = env.test_Password ?? env.TEST_PASSWORD;

assertRequiredEnv(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
if (!testEmail || !testPassword) {
  throw new Error("缺少测试账号：请在 .env.local 中配置 test_User/test_Password 或 TEST_USER/TEST_PASSWORD。");
}

fs.mkdirSync(outputDir, { recursive: true });

console.log("正在检查本地服务...");
await checkHealth();

console.log("正在登录测试账号...");
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { data, error } = await supabase.auth.signInWithPassword({
  email: testEmail,
  password: testPassword,
});

if (error || !data.session) {
  throw new Error(`测试账号登录失败：${error?.message ?? "missing session"}`);
}

console.log("正在运行真实购买决策链路 trace，这一步会调用视觉识别、衣橱 RAG、知识库 RAG 和决策模型...");
const startedAt = Date.now();
const response = await fetch(`${appUrl.replace(/\/$/, "")}/api/ai/assess-purchase`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${data.session.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    message,
    imageDataUrl: imagePath ? imageToDataUrl(imagePath) : undefined,
    trace: true,
  }),
});
const elapsedMs = Date.now() - startedAt;
const result = await parseJsonResponse(response, "purchase trace");
const sanitized = sanitizeTracePayload({
  generatedAt: new Date().toISOString(),
  appUrl,
  elapsedMs,
  elapsedSeconds: Number((elapsedMs / 1000).toFixed(1)),
  request: {
    message,
    imagePath,
    hasImage: Boolean(imagePath),
  },
  result,
});
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outputDir, `purchase-trace-${timestamp}.json`);
const markdownPath = path.join(outputDir, `purchase-trace-${timestamp}.md`);
const latestJsonPath = path.join(outputDir, "latest.json");
const latestMarkdownPath = path.join(outputDir, "latest.md");

fs.writeFileSync(jsonPath, JSON.stringify(sanitized, null, 2), "utf8");
fs.writeFileSync(latestJsonPath, JSON.stringify(sanitized, null, 2), "utf8");
const markdown = renderMarkdown(sanitized);
fs.writeFileSync(markdownPath, markdown, "utf8");
fs.writeFileSync(latestMarkdownPath, markdown, "utf8");

console.log(
  JSON.stringify(
    {
      elapsedSeconds: sanitized.elapsedSeconds,
      usedModel: sanitized.result.report?.usedModel,
      decision: sanitized.result.report?.decision,
      decisionLabel: sanitized.result.report?.decisionLabel,
      closetItemCount: sanitized.result.closetItemCount,
      routeStepCount: sanitized.result.trace?.routeSteps?.length ?? 0,
      workflowStepCount: sanitized.result.trace?.workflowSteps?.length ?? 0,
      markdownPath,
      jsonPath,
    },
    null,
    2,
  ),
);

function renderMarkdown(payload) {
  const report = payload.result.report;
  const trace = payload.result.trace ?? {};
  const routeSteps = trace.routeSteps ?? [];
  const workflowSteps = trace.workflowSteps ?? [];
  const closetStep = workflowSteps.find((step) => step.id === "retrieve_closet");
  const knowledgeStep = workflowSteps.find((step) => step.id === "retrieve_knowledge");
  const assessStep = workflowSteps.find((step) => step.id === "assess_purchase");

  const lines = [
    "# 购买决策链路 Trace",
    "",
    `- 生成时间：${payload.generatedAt}`,
    `- 总耗时：${payload.elapsedSeconds}s`,
    `- 是否调用决策模型：${report?.usedModel ? "是" : "否"}`,
    `- 最终结论：${report?.decisionLabel ?? report?.decision ?? "未知"}`,
    `- 衣橱参与数量：${payload.result.closetItemCount ?? 0}`,
    `- 输入图片：${payload.request.imagePath ?? "未提供图片，仅文本判断"}`,
    "",
    "## 一句话看懂链路",
    "",
    "这次决策先识别待买商品，随后用候选商品的品类、颜色、风格、场景和 embedding 去检索真实衣橱中的可搭配候选；RAG 返回的是 Top K 候选，不等于最终搭配。决策模型会结合穿搭知识库二次筛选，只有真的能形成自然穿着组合的衣服才进入搭配板。",
    "",
  ];

  if (report?.candidate) {
    lines.push("## 待买商品识别结果", "", jsonBlock(pick(report.candidate, [
      "productName",
      "category",
      "color",
      "secondaryColors",
      "fit",
      "styleTags",
      "possibleScenarios",
      "estimatedPrice",
      "sellingPoints",
      "summary",
      "embeddingText",
      "aiConfidence",
    ])), "");
  }

  if (closetStep?.output?.byMatchType) {
    lines.push("## 衣橱 RAG 检索结果", "");
    lines.push("| 类型 | 含义 | 数量 | Top 命中 |");
    lines.push("| --- | --- | ---: | --- |");
    for (const group of closetStep.output.byMatchType) {
      lines.push(
        `| ${group.matchType} | ${matchTypeMeaning(group.matchType)} | ${group.count} | ${(group.topItems ?? [])
          .map((item) => `${item.name}(${item.score})`)
          .join("<br>")} |`,
      );
    }
    lines.push("");
  }

  if (report?.retrievedClosetItems?.length) {
    lines.push("### Top 衣橱证据明细", "");
    lines.push("| 类型 | 分数 | 衣服 | 品类/颜色 | 入选原因 |");
    lines.push("| --- | ---: | --- | --- | --- |");
    for (const match of report.retrievedClosetItems.slice(0, 12)) {
      lines.push(
        `| ${match.matchType} | ${match.score} | ${match.item?.name ?? ""} | ${match.item?.category ?? ""} / ${
          match.item?.color ?? ""
        } | ${match.reason ?? ""} |`,
      );
    }
    lines.push("");
  }

  if (knowledgeStep?.output?.snippets?.length) {
    lines.push("## 知识库 RAG 输出", "");
    lines.push("| 知识卡 | 主题 | 标签 | 决策点 | 风险信号 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const snippet of knowledgeStep.output.snippets) {
      lines.push(
        `| ${snippet.cardId ?? ""} | ${snippet.topic ?? ""} | ${(snippet.tags ?? []).join("、")} | ${(
          snippet.decisionPoints ?? []
        ).join("<br>")} | ${(snippet.riskSignals ?? []).join("<br>")} |`,
      );
    }
    lines.push("");
  }

  if (report?.outfitCombinations?.length) {
    lines.push("## 真实搭配板怎么生成", "");
    for (const board of report.outfitCombinations) {
      lines.push(`### ${board.title}`, "", `- 场景：${board.scenario}`, `- 类型：${board.visualIntent ?? "未标记"}`, `- 总结：${board.summary}`, "");
      lines.push("| 角色 | 衣服 | 品类 | 原因 |");
      lines.push("| --- | --- | --- | --- |");
      lines.push(`| 待买衣服 | ${report.candidate?.productName ?? ""} | ${report.candidate?.category ?? ""} | 本次判断核心商品 |`);
      for (const item of board.visualItems ?? []) {
        lines.push(`| ${item.role ?? item.badge ?? ""} | ${item.name ?? ""} | ${item.category ?? ""} | ${item.reason ?? ""} |`);
      }
      lines.push("");
    }
  }

  if (assessStep) {
    lines.push("## 决策模型输入摘要", "", jsonBlock({
      promptChars: assessStep.input?.promptChars,
      userMessage: assessStep.input?.prompt?.userMessage,
      candidate: assessStep.input?.prompt?.candidate,
      closetEvidence: assessStep.input?.prompt?.closetEvidence,
      knowledge: assessStep.input?.prompt?.knowledge,
      safety: assessStep.input?.prompt?.safety,
    }), "");
  }

  if (report) {
    lines.push("## 最终输出", "", jsonBlock({
      decision: report.decision,
      decisionStatus: report.decisionStatus,
      decisionLabel: report.decisionLabel,
      confidence: report.confidence,
      scores: report.scores,
      summary: report.summary,
      reasonsToBuy: report.reasonsToBuy,
      reasonsToSave: report.reasonsToSave,
      risks: report.risks,
      nextStep: report.nextStep,
    }), "");
  }

  lines.push("## 全部步骤输入/输出", "");
  [...routeSteps, ...workflowSteps].forEach((step, index) => {
    lines.push(`### ${index + 1}. ${step.title} (${step.id})`, "", `- 耗时：${step.elapsedMs}ms`, "", "输入：", "", jsonBlock(step.input), "", "输出：", "", jsonBlock(step.output), "");
  });

  return `${lines.join("\n")}\n`;
}

function matchTypeMeaning(matchType) {
  if (matchType === "outfit") return "RAG 返回的可搭配候选，后续仍需决策模型二次筛选";
  return "";
}

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value?.[key]]));
}

async function checkHealth() {
  const response = await fetch(`${appUrl.replace(/\/$/, "")}/api/health`);
  const data = await parseJsonResponse(response, "health");
  if (!data.ok) {
    throw new Error(`本地服务健康检查失败：${JSON.stringify(data)}`);
  }
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回的不是 JSON：${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`${label} 请求失败 ${response.status}：${data?.message ?? text.slice(0, 500)}`);
  }

  return data;
}

function sanitizeTracePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeTracePayload);
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "duplicateRisk") {
      continue;
    }
    if (/Url$/.test(key) || key === "imageDataUrl") {
      result[key] = entry ? "[omitted-url]" : entry;
      continue;
    }
    if (key === "embedding" || key === "candidateEmbedding") {
      result[key] = Array.isArray(entry) ? `[vector:${entry.length}]` : entry;
      continue;
    }
    result[key] = sanitizeTracePayload(entry);
  }
  return result;
}

function resolveImagePath(inputPath) {
  if (inputPath) {
    const resolved = path.resolve(process.cwd(), inputPath);
    if (!fs.existsSync(resolved)) throw new Error(`图片不存在：${resolved}`);
    return resolved;
  }

  const closetDir = path.join(projectRoot, "resources", "closet");
  if (!fs.existsSync(closetDir)) return undefined;
  const firstImage = fs
    .readdirSync(closetDir)
    .filter((fileName) => [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(fileName).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))[0];
  return firstImage ? path.join(closetDir, firstImage) : undefined;
}

function imageToDataUrl(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      parsed._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (key === "no-image") {
      parsed.noImage = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function assertRequiredEnv(names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`缺少环境变量：${missing.join(", ")}`);
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
