import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getClosetAnalysisProgress, getClosetDisplayProgress } from "./upload-progress.ts";

test("analysis progress keeps queued and processing work visible after local or persisted state updates", () => {
  assert.deepEqual(
    getClosetAnalysisProgress({
      imageQualityFlags: ["closet_analysis_queued"],
      category: "待识别",
    }),
    { state: "in_progress", label: "衣服信息识别中" },
  );

  assert.deepEqual(
    getClosetAnalysisProgress({
      imageQualityFlags: ["closet_analysis_processing", "closet_analysis_failed"],
    }),
    { state: "in_progress", label: "衣服信息识别中" },
  );

  assert.deepEqual(
    getClosetAnalysisProgress({
      imageQualityFlags: ["closet_analysis_queued", "ai_label_ready"],
      category: "短袖T恤",
      styleTags: ["简约"],
    }),
    { state: "complete", label: "衣服信息已识别" },
  );
});

test("analysis progress distinguishes failed and completed results", () => {
  assert.deepEqual(
    getClosetAnalysisProgress({
      imageQualityFlags: ["closet_analysis_failed"],
      category: "待识别",
      styleTags: ["待识别"],
    }),
    { state: "failed", label: "衣服信息识别失败" },
  );

  assert.deepEqual(
    getClosetAnalysisProgress({
      imageQualityFlags: ["ai_label_ready"],
      category: "短袖T恤",
      styleTags: ["简约"],
    }),
    { state: "complete", label: "衣服信息已识别" },
  );
});

test("display progress maps active, completed, failed and waiting states independently", () => {
  assert.deepEqual(getClosetDisplayProgress({ displayImageStatus: "queued" }), {
    state: "in_progress",
    label: "展示图生成中",
  });
  assert.deepEqual(getClosetDisplayProgress({ displayImageStatus: "processing" }), {
    state: "in_progress",
    label: "展示图生成中",
  });
  assert.deepEqual(getClosetDisplayProgress({ displayImageStatus: "ready" }), {
    state: "complete",
    label: "展示图已生成",
  });
  assert.deepEqual(getClosetDisplayProgress({ displayImageStatus: "failed" }), {
    state: "failed",
    label: "展示图生成失败",
  });
  assert.deepEqual(getClosetDisplayProgress({ displayImageStatus: "not_started" }), {
    state: "waiting",
    label: "展示图待生成",
  });
});

test("pending closet cards render one accessible two-row progress region without quality badges", () => {
  const pageSource = readFileSync(new URL("../../app/app/page.tsx", import.meta.url), "utf8");
  const confirmationCardSource = pageSource.slice(
    pageSource.indexOf("function ClosetConfirmationCard"),
    pageSource.indexOf("function LabeledInput"),
  );
  const progressSource = pageSource.slice(
    pageSource.indexOf("function ClosetUploadProgress"),
    pageSource.indexOf("function ClosetCard"),
  );

  assert.match(confirmationCardSource, /<ClosetUploadProgress\s+[\s\S]*analysis=\{analysisProgress\}[\s\S]*display=\{displayProgress\}/);
  assert.doesNotMatch(confirmationCardSource, /visibleQualityFlags|qualityFlagLabel|qualityFlagTone/);

  assert.match(progressSource, /role="status"/);
  assert.match(progressSource, /aria-live="polite"/);
  assert.match(progressSource, /aria-atomic="true"/);
  assert.match(progressSource, /orbState="searching"/);
  assert.match(progressSource, /orbState="shaping"/);
  assert.match(progressSource, /<ThinkingOrb[\s\S]*size=\{20\}[\s\S]*theme="light"[\s\S]*aria-hidden="true"/);
});

test("pending closet cards unify AI-owned fields while analysis is in progress", () => {
  const pageSource = readFileSync(new URL("../../app/app/page.tsx", import.meta.url), "utf8");
  const confirmationCardSource = pageSource.slice(
    pageSource.indexOf("function ClosetConfirmationCard"),
    pageSource.indexOf("function ClosetUploadProgress"),
  );

  assert.match(
    confirmationCardSource,
    /const analysisInProgress = analysisProgress\.state === "in_progress"/,
  );
  assert.match(
    confirmationCardSource,
    /const itemInteractionBusy =[\s\S]*analysisInProgress \|\| isAnalysisBusy/,
  );
  assert.match(
    confirmationCardSource,
    /label="品类"[\s\S]*value=\{analysisInProgress \? "待识别" : draft\.category\}[\s\S]*disabled=\{analysisInProgress\}[\s\S]*muted=\{analysisInProgress\}/,
  );
  assert.match(
    confirmationCardSource,
    /label="颜色"[\s\S]*value=\{analysisInProgress \? "待识别" : draft\.color\}[\s\S]*disabled=\{analysisInProgress\}[\s\S]*muted=\{analysisInProgress\}/,
  );
  assert.match(
    confirmationCardSource,
    /label="版型"[\s\S]*label: "待识别"[\s\S]*disabled=\{analysisInProgress\}[\s\S]*mutedValue=\{analysisInProgress \? "analysis_pending" : undefined\}/,
  );

  for (const label of ["风格标签", "场景标签", "季节标签"]) {
    assert.match(
      confirmationCardSource,
      new RegExp(
        `label="${label}"[\\s\\S]*value=\\{analysisInProgress \\? \\["待识别"\\] : draft\\.[a-zA-Z]+\\}[\\s\\S]*disabled=\\{analysisInProgress\\}[\\s\\S]*muted=\\{analysisInProgress\\}`,
      ),
    );
  }

  assert.match(
    confirmationCardSource,
    /label="名称"[\s\S]*value=\{draft\.name\}/,
  );
  assert.match(
    confirmationCardSource,
    /label="穿着频率"[\s\S]*value=\{draft\.wearFrequency\}[\s\S]*mutedValue="unknown"/,
  );
});
