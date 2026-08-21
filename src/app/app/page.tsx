"use client";

import {
  Bookmark,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  ImagePlus,
  Info,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shirt,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Upload,
  UserRound,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { DragEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";

import { getEligibleTryOnOutfits, withStableOutfitIds } from "@/lib/ai/outfit-try-on";
import type { OutfitTryOnBatch, PurchaseDecisionReport } from "@/lib/ai/types";
import { hasDecisionTryOnImage, selectDecisionTryOnResult } from "@/lib/decision-list/preview";
import { runWithConcurrency } from "@/lib/closet/concurrency";
import {
  createEmptyClosetFilters,
  filterClosetItems,
  getClosetFilterOptions,
  hasActiveClosetFilters,
  type ClosetFilterOption,
  type ClosetFilters,
} from "@/lib/closet/filter-items";
import {
  applyClosetAnalysisResult,
  applyClosetConfirmationResult,
  applyClosetDisplayPatch,
  applyClosetReanalysisResult,
  filterLegacyDisplayImageFlags,
  formatDisplayCompletionNoticeSummary,
  mergeDisplayCompletionNotices,
  type ClosetDisplayPatch,
  type DisplayCompletionNotice,
  type DisplayCompletionNoticeSummary,
} from "@/lib/closet/display-workflow";
import {
  collectClosetStorageCleanupPaths,
  restoreClosetItemAtIndex,
} from "@/lib/closet/deletion-workflow";
import {
  getClosetAnalysisProgress,
  getClosetDisplayProgress,
  type ClosetUploadTaskProgress,
} from "@/lib/closet/upload-progress";
import { normalizeClosetSeasons } from "@/lib/closet/season";
import {
  DECISION_RUN_POLL_INTERVAL_MS,
  getStableDecisionSubmission,
  indexLatestDecisionRuns,
  isDecisionRunActive,
  isDecisionRunTerminal,
  mapDecisionRunRow,
  mergeDecisionRun,
  mergeDecisionRuns,
  type DecisionRun,
  type DecisionRunRow,
  type PendingDecisionSubmission,
} from "@/lib/decision-runs";
import { getGarmentEvidenceRole } from "@/lib/garment/category";
import {
  createTimingTrace,
  emitTimingSummary,
  type TimingOutcome,
  type TimingSpanHandle,
  type TimingTrace,
} from "@/lib/performance/timing";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  AppView,
  BudgetSensitivity,
  ChatSession,
  ClothingItem,
  DecisionItem,
  DecisionOutfitCombination,
  DecisionStatus,
  UserProfile,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const statusConfig: Record<
  DecisionStatus,
  { label: string; tone: string; icon: LucideIcon }
> = {
  decided_to_buy: {
    label: "决定买",
    tone: "border-[#b6c0b8] bg-[#edf0ed] text-[#617066]",
    icon: CheckCircle2,
  },
  saved_for_later: {
    label: "先收藏",
    tone: "border-[#cbbac6] bg-[#e6dde3] text-[#76576f]",
    icon: Bookmark,
  },
  not_considering: {
    label: "暂不考虑",
    tone: "border-[#d7cfd1] bg-[#faf8f4] text-[#777078]",
    icon: XCircle,
  },
};

type ProfileRow = {
  id: string;
  user_id: string;
  height_cm: number | null;
  weight_kg: number | null;
  bmi: number | null;
  bmi_band: UserProfile["bmiBand"];
  style_preferences: string[] | null;
  disliked_categories: string[] | null;
  common_scenarios: string[] | null;
  budget_sensitivity: BudgetSensitivity | null;
};

type ClosetItemRow = {
  id: string;
  image_path: string;
  processed_image_path: string | null;
  display_image_path: string | null;
  display_image_status: ClothingItem["displayImageStatus"] | null;
  display_image_model: string | null;
  display_image_prompt_version: string | null;
  image_quality_flags: string[] | null;
  category: string;
  color: string | null;
  fit: ClothingItem["fit"] | null;
  style_tags: string[] | null;
  season: string[] | null;
  scenario_tags: string[] | null;
  wear_frequency: ClothingItem["wearFrequency"] | null;
  status: ClothingItem["status"] | null;
  summary: string | null;
  embedding_text: string | null;
  ai_confidence: number | null;
  user_corrected: boolean | null;
};

type ClosetDisplayImageRow = {
  id: string;
  display_image_path: string | null;
  display_image_status: ClothingItem["displayImageStatus"] | null;
  display_image_model: string | null;
  display_image_prompt_version: string | null;
};

const closetItemSelect =
  "id,image_path,processed_image_path,display_image_path,display_image_status,display_image_model,display_image_prompt_version,image_quality_flags,category,color,fit,style_tags,season,scenario_tags,wear_frequency,status,summary,embedding_text,ai_confidence,user_corrected";

type ClosetConfirmationDraft = {
  name: string;
  category: string;
  color: string;
  fit: ClothingItem["fit"];
  styleTags: string[];
  scenarioTags: string[];
  seasonTags: string[];
  wearFrequency: ClothingItem["wearFrequency"];
};

type ClosetUploadTraceContext = {
  trace: TimingTrace;
  sessionEpoch: number;
  fileBytes: number;
  batchSize: number;
  dataUrlChars?: number;
  itemId?: string;
  analysisRequestId?: string;
  analysisServerTiming?: string;
  displayRequestId?: string;
  displayServerTiming?: string;
  analysisSucceeded?: boolean;
  displaySucceeded?: boolean;
  displayImageUrl?: string;
  displayImageLoadOutcome?: TimingOutcome;
  displayImageLoadPromise: Promise<TimingOutcome>;
  beginDisplayImageLoad: (url?: string) => void;
  finishDisplayImageLoad: (outcome: TimingOutcome) => boolean;
  finalized: boolean;
};

type ClosetImageLoadHandler = (
  itemId: string,
  imageUrl: string,
  outcome: Extract<TimingOutcome, "success" | "failure">,
) => void;

type ClosetBusyOperation = "analysis" | "confirmation" | "display" | "deletion";
type ClosetAbortableOperation = "analysis" | "display";

type ClosetBusyItemIds = Record<ClosetBusyOperation, string[]>;

function createEmptyClosetBusyItemIds(): ClosetBusyItemIds {
  return {
    analysis: [],
    confirmation: [],
    display: [],
    deletion: [],
  };
}

function createClosetBusyCountMaps(): Record<ClosetBusyOperation, Map<string, number>> {
  return {
    analysis: new Map(),
    confirmation: new Map(),
    display: new Map(),
    deletion: new Map(),
  };
}

function createClosetUploadTraceContext(
  file: File,
  batchSize: number,
  sessionEpoch: number,
): ClosetUploadTraceContext {
  const trace = createTimingTrace({
    operation: "closet_upload",
    traceId: crypto.randomUUID(),
  });
  let resolveDisplayImageLoad!: (outcome: TimingOutcome) => void;
  const displayImageLoadPromise = new Promise<TimingOutcome>((resolve) => {
    resolveDisplayImageLoad = resolve;
  });
  let displayImageLoadSpan: TimingSpanHandle | undefined;
  let displayImageLoadFinished = false;

  const context: ClosetUploadTraceContext = {
    trace,
    sessionEpoch,
    fileBytes: file.size,
    batchSize,
    displayImageLoadPromise,
    beginDisplayImageLoad(url) {
      if (!url || displayImageLoadFinished || displayImageLoadSpan) return;
      context.displayImageUrl = url;
      displayImageLoadSpan = trace.startSpan("display_image_load");
    },
    finishDisplayImageLoad(outcome) {
      if (displayImageLoadFinished) return false;
      displayImageLoadFinished = true;
      context.displayImageLoadOutcome = outcome;
      displayImageLoadSpan?.finish(outcome);
      resolveDisplayImageLoad(outcome);
      return true;
    },
    finalized: false,
  };

  return context;
}

async function finalizeClosetUploadTrace(context: ClosetUploadTraceContext) {
  if (context.finalized) return;
  context.finalized = true;

  if (!context.displaySucceeded) {
    context.finishDisplayImageLoad("failure");
  }

  const displayImageOutcome = await context.displayImageLoadPromise;
  const outcome: TimingOutcome =
    context.analysisSucceeded === false || context.displaySucceeded === false
      ? "failure"
      : displayImageOutcome;

  emitTimingSummary(
    context.trace.summarize(outcome, {
      fileBytes: context.fileBytes,
      batchSize: context.batchSize,
      dataUrlChars: context.dataUrlChars,
      analysisRequestId: context.analysisRequestId,
      analysisServerTiming: context.analysisServerTiming,
      displayRequestId: context.displayRequestId,
      displayServerTiming: context.displayServerTiming,
    }),
  );
}

async function measureWithTrace<T>(
  trace: TimingTrace | undefined,
  name: string,
  task: () => PromiseLike<T>,
  classify?: (result: T) => TimingOutcome,
) {
  return trace ? trace.measure(name, task, classify) : await task();
}

function measureSyncWithTrace<T>(
  trace: TimingTrace | undefined,
  name: string,
  task: () => T,
  classify?: (result: T) => TimingOutcome,
) {
  return trace ? trace.measureSync(name, task, classify) : task();
}

type ChatSessionRow = {
  id: string;
  title: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
};

type ChatMessageRow = {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  image_path: string | null;
  candidate_id: string | null;
  report_id: string | null;
  decision_run_id?: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type DecisionItemRow = {
  id: string;
  status: DecisionStatus;
  report_id: string | null;
  session_id: string | null;
  size_label: string | null;
  snapshot_summary: string | null;
  snapshot_outfit_tips: string[] | null;
  snapshot_risks: string[] | null;
  reminder_at: string | null;
  created_at: string;
  updated_at: string;
  candidate:
    | {
        id: string;
        product_name: string | null;
        summary: string | null;
        category: string | null;
        color: string | null;
        estimated_price: number | string | null;
        screenshot_path: string | null;
      }
    | null;
  report:
    | {
        id: string;
        summary: string | null;
        outfit_combinations: DecisionOutfitCombination[] | null;
      }
    | null;
};

type DecisionReportMessageRow = {
  session_id: string;
  report_id: string | null;
  role: "assistant";
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type DecisionTryOnImageRow = {
  report_id: string;
  outfit_id: string;
  position: number;
  image_path: string | null;
  status: "pending" | "processing" | "ready" | "failed" | "cancelled";
};

type DecisionClosetImageRow = {
  id: string;
  image_path: string | null;
  processed_image_path: string | null;
  display_image_path: string | null;
  summary: string | null;
  category: string | null;
  color: string | null;
  style_tags: string[] | null;
  scenario_tags: string[] | null;
};

type DecisionClosetImageInfo = {
  imageUrl?: string;
  name?: string;
  category?: string;
  tags: string[];
};

type DecisionChatState = {
  message: string;
  lastUserMessage: string;
  assistantMessage?: string;
  purchaseImageDataUrl?: string;
  purchaseImageName?: string;
  assessment: PurchaseDecisionReport | null;
  decisionElapsedSeconds?: number;
  selectedDecisionStatus?: DecisionStatus;
  candidateId?: string;
  reportId?: string;
  decisionRunId?: string;
  error: string;
  notice: string;
};

const composerPlaceholder = "请上传您需要决策的衣服，也可以补充价格、场景或犹豫点。";

const fitOptions: Array<{ value: ClothingItem["fit"]; label: string }> = [
  { value: "slim", label: "修身" },
  { value: "regular", label: "常规" },
  { value: "oversized", label: "宽松" },
  { value: "unknown", label: "待确认" },
];

const wearFrequencyOptions: Array<{ value: ClothingItem["wearFrequency"]; label: string }> = [
  { value: "often", label: "常穿" },
  { value: "sometimes", label: "偶尔穿" },
  { value: "rarely", label: "闲置" },
  { value: "unknown", label: "待确认" },
];

const closetDisplayStatusLabels: Record<
  NonNullable<ClothingItem["displayImageStatus"]>,
  string
> = {
  not_started: "展示图待生成",
  queued: "展示图排队中",
  processing: "展示图生成中",
  ready: "展示图已完成",
  failed: "展示图生成失败",
};

type ClosetFilterKey = keyof ClosetFilters;

const closetFilterLabels: Record<ClosetFilterKey, string> = {
  categories: "品类",
  styles: "风格",
  colors: "颜色",
  seasons: "季节",
  statuses: "状态",
};

const decisionProgressSteps = [
  "识别待买商品",
  "检索你的衣橱",
  "匹配可搭配候选",
  "筛选真实搭配组合",
  "补充穿搭知识",
  "长期主义决策思考",
];

const decisionProgressOrbStates: OrbState[] = [
  "searching",
  "connecting",
  "weaving",
  "solving",
  "composing",
  "working",
];

function createEmptyProfile(userId: string): UserProfile {
  return {
    userId,
    heightCm: null,
    weightKg: null,
    bmi: null,
    bmiBand: null,
    stylePreferences: ["简约", "通勤", "休闲"],
    dislikedCategories: ["紧身 / 勒身", "易皱"],
    commonScenarios: ["上班 / 通勤", "日常出街"],
    budgetSensitivity: "medium",
  };
}

function isProfileIncomplete(profile: UserProfile) {
  return (
    !profile.heightCm ||
    !profile.weightKg ||
    profile.stylePreferences.length === 0 ||
    profile.commonScenarios.length === 0
  );
}

function mapProfileFromDb(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    userId: row.user_id,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    bmi: row.bmi,
    bmiBand: row.bmi_band,
    stylePreferences: row.style_preferences ?? [],
    dislikedCategories: row.disliked_categories ?? [],
    commonScenarios: row.common_scenarios ?? [],
    budgetSensitivity: row.budget_sensitivity ?? "medium",
  };
}

async function mapClosetItemFromDb(
  supabase: SupabaseClient,
  row: ClosetItemRow,
  timing?: { trace: TimingTrace; prefix: string },
): Promise<ClothingItem> {
  const { data: originalImage } = await measureWithTrace(
    timing?.trace,
    `${timing?.prefix ?? "closet"}_original_signed_url`,
    () => supabase.storage.from("closet-images").createSignedUrl(row.image_path, 60 * 60),
    (result) => (result.error ? "failure" : "success"),
  );
  const { data: processedImage } = row.processed_image_path
    ? await measureWithTrace(
        timing?.trace,
        `${timing?.prefix ?? "closet"}_processed_signed_url`,
        () =>
          supabase.storage
            .from("closet-images")
            .createSignedUrl(row.processed_image_path as string, 60 * 60),
        (result) => (result.error ? "failure" : "success"),
      )
    : { data: null };
  const { data: displayImage } = row.display_image_path
    ? await measureWithTrace(
        timing?.trace,
        `${timing?.prefix ?? "closet"}_display_signed_url`,
        () =>
          supabase.storage
            .from("closet-images")
            .createSignedUrl(row.display_image_path as string, 60 * 60),
        (result) => (result.error ? "failure" : "success"),
      )
    : { data: null };

  return {
    id: row.id,
    name: row.summary || row.category || "未命名衣服",
    category: row.category || "待识别",
    color: row.color || "待识别",
    fit: row.fit ?? "unknown",
    styleTags: row.style_tags?.length ? row.style_tags : ["待识别"],
    seasonTags: normalizeClosetSeasons(row.season),
    scenarioTags: row.scenario_tags ?? [],
    wearFrequency: row.wear_frequency ?? "unknown",
    status: row.status ?? "active",
    palette: getPaletteByColor(row.color),
    imagePath: row.image_path,
    processedImagePath: row.processed_image_path ?? undefined,
    displayImagePath: row.display_image_path ?? undefined,
    displayImageStatus: row.display_image_status ?? "not_started",
    displayImageModel: row.display_image_model ?? undefined,
    displayImagePromptVersion: row.display_image_prompt_version ?? undefined,
    imageUrl: displayImage?.signedUrl ?? processedImage?.signedUrl ?? originalImage?.signedUrl,
    displayImageUrl: displayImage?.signedUrl,
    originalImageUrl: originalImage?.signedUrl,
    imageQualityFlags: filterLegacyDisplayImageFlags(row.image_quality_flags),
    aiConfidence: row.ai_confidence ?? undefined,
    userCorrected: row.user_corrected ?? false,
    embeddingText: row.embedding_text ?? undefined,
    summary: row.summary ?? undefined,
  };
}

async function createStorageSignedUrl(
  supabase: SupabaseClient,
  bucket: "closet-images" | "purchase-screenshots",
  path?: string | null,
) {
  if (!path) return undefined;
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  return data?.signedUrl;
}

function createDecisionProductName(
  productName?: string | null,
  summary?: string | null,
  color?: string | null,
  category?: string | null,
) {
  const cleanProductName = productName?.trim();
  if (cleanProductName) return cleanProductName;

  const cleanColor = color && !/未知|待确认|unknown/i.test(color) ? color.trim() : "";
  const cleanCategory = category && !/未知|待确认|unknown/i.test(category) ? category.trim() : "";
  const combined = `${cleanColor}${cleanCategory}`.trim();
  if (combined) return combined;

  const cleanSummary = summary?.replace(/\s+/g, " ").trim();
  if (cleanSummary && cleanSummary.length <= 18 && !/[，。；,.]/.test(cleanSummary)) {
    return cleanSummary;
  }

  return "咨询商品";
}

function getReportProductNameFromMetadata(metadata?: Record<string, unknown> | null) {
  const report = metadata?.report as PurchaseDecisionReport | undefined;
  return report?.candidate?.productName?.trim() || undefined;
}

function collectDecisionOutfitClosetIds(rows: DecisionItemRow[]) {
  return Array.from(
    new Set(
      rows.flatMap((item) =>
        (item.report?.outfit_combinations ?? []).flatMap((outfit) => [
          ...(outfit.visualItems?.map((visualItem) => visualItem.id) ?? []),
        ]),
      ),
    ),
  ).filter((id) => /^[0-9a-f-]{32,36}$/i.test(id));
}

function hydrateDecisionOutfitImages(
  outfits: DecisionOutfitCombination[],
  closetImagesById: Map<string, DecisionClosetImageInfo>,
) {
  return outfits.map((outfit) => ({
    ...outfit,
    visualItems: (outfit.visualItems ?? []).map((visualItem) => {
      const closetImage = closetImagesById.get(visualItem.id);
      if (!closetImage) return visualItem;

      return {
        ...visualItem,
        name: visualItem.name || closetImage.name || "衣橱单品",
        category: visualItem.category || closetImage.category || "衣服",
        imageUrl: closetImage.imageUrl ?? visualItem.imageUrl,
        tags: visualItem.tags?.length ? visualItem.tags : closetImage.tags,
      };
    }),
  }));
}

function isKnownDecisionPrice(value?: number | string | null) {
  if (value === null || value === undefined || value === "") return false;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
}

function parseDecisionPriceInput(value: string) {
  const cleaned = value.replace(/[^\d.]/g, "").trim();
  if (!cleaned) return null;
  const numericValue = Number(cleaned);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function hydrateReportForDisplay(
  report: PurchaseDecisionReport | undefined,
  closetItems: ClothingItem[],
  candidateImageUrl?: string,
): PurchaseDecisionReport | undefined {
  if (!report) return undefined;

  const closetById = new Map(closetItems.map((item) => [item.id, item]));

  return {
    ...report,
    candidate: {
      ...report.candidate,
      screenshotUrl: candidateImageUrl ?? report.candidate.screenshotUrl,
    },
    outfitCombinations: report.outfitCombinations.map((combination) => {
      const existingVisualItems = combination.visualItems ?? [];
      const existingVisualById = new Map(existingVisualItems.map((item) => [item.id, item]));
      const ids = combination.closetItemIds?.length
        ? combination.closetItemIds
        : existingVisualItems.map((item) => item.id);
      const hydratedVisualItems = ids
        .map((itemId) => {
          const closetItem = closetById.get(itemId);
          const existing = existingVisualById.get(itemId);

          if (!closetItem) return existing;

          return {
            id: closetItem.id,
            name: existing?.name ?? closetItem.name,
            category: existing?.category ?? closetItem.category,
            imageUrl: closetItem.displayImageUrl ?? closetItem.imageUrl ?? closetItem.originalImageUrl ?? existing?.imageUrl,
            matchType: existing?.matchType ?? "outfit",
            role: existing?.role ?? getGarmentEvidenceRole(closetItem.category, report.candidate.category),
            badge: existing?.badge ?? getGarmentEvidenceRole(closetItem.category, report.candidate.category),
            reason:
              existing?.reason ??
              `可用于${combination.scenario || "日常"}搭配，和待买衣服在风格或场景上能自然衔接。`,
            tags: existing?.tags?.length
              ? existing.tags
              : [...closetItem.styleTags, ...closetItem.scenarioTags].slice(0, 4),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      return {
        ...combination,
        closetItemIds: hydratedVisualItems.map((item) => item.id),
        items: [report.candidate.productName, ...hydratedVisualItems.map((item) => item.name)],
        visualItems: hydratedVisualItems,
      };
    }),
  };
}

function getPaletteByColor(color?: string | null) {
  if (!color) return "from-[#f2eee7] to-[#d7c4ad]";
  if (color.includes("黑")) return "from-[#171313] to-[#77706b]";
  if (color.includes("白")) return "from-[#fbfaf5] to-[#e8ded2]";
  if (color.includes("蓝")) return "from-[#426987] to-[#b2c7d4]";
  if (color.includes("灰")) return "from-[#a7a7a3] to-[#e2e0dc]";
  if (color.includes("卡其") || color.includes("棕")) return "from-[#c9a47d] to-[#f3dfc8]";
  if (color.includes("米")) return "from-[#ead9c2] to-[#f8efe2]";
  return "from-[#f5dcd2] to-[#fff8ef]";
}

function createConfirmationDraft(item: ClothingItem): ClosetConfirmationDraft {
  return {
    name: item.name || item.summary || "待确认衣服",
    category: item.category === "识别中" ? "待确认" : item.category,
    color: item.color === "待识别" ? "待确认" : item.color,
    fit: item.fit,
    styleTags: item.styleTags.filter((tag) => tag !== "待识别" && tag !== "AI 识别中"),
    scenarioTags: item.scenarioTags,
    seasonTags: normalizeClosetSeasons(item.seasonTags),
    wearFrequency: item.wearFrequency,
  };
}

function createEmptyChatState(): DecisionChatState {
  return {
    message: "",
    lastUserMessage: "",
    assessment: null,
    error: "",
    notice: "",
  };
}

function getPersistedDecisionProgressIndex(run?: DecisionRun) {
  if (!run || run.stage === "queued") return 0;
  if (run.stage === "analyzing_candidate") return 0;
  if (run.stage === "retrieving_context") return 2;
  return decisionProgressSteps.length - 1;
}

function getDecisionRunElapsedSeconds(run?: DecisionRun) {
  if (!run?.startedAt) return undefined;
  const end = run.decisionReadyAt ?? run.finishedAt;
  if (!end) return undefined;
  const elapsedMs = new Date(end).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  return Math.max(1, Math.round(elapsedMs / 1000));
}

function createChatTitle(message: string, hasImage?: boolean) {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return hasImage ? "图片购买决策" : "新的决策对话";
  return normalized.length > 16 ? `${normalized.slice(0, 16)}...` : normalized;
}

function getMessagePreview(message: string | null | undefined) {
  const normalized = message?.replace(/\s+/g, " ").trim();
  if (!normalized) return "图片购买决策";
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized;
}

function formatRelativeTime(value?: string | null) {
  if (!value) return "刚刚";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "刚刚";
  const diffMs = Date.now() - timestamp;
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

function formatDecisionElapsedTime(totalSeconds: number) {
  if (totalSeconds < 60) return `耗时 ${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `耗时 ${minutes} 分 ${seconds} 秒`;
}

function readDecisionElapsedSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

function formatReminderLabel(value?: string | null) {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  const diffMs = timestamp - Date.now();
  if (diffMs <= 0) return "现在";
  const hours = Math.ceil(diffMs / 3600000);
  if (hours <= 24) return `${hours} 小时后`;
  return `${Math.ceil(hours / 24)} 天后`;
}

function splitTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[,，、\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function mergeImageQualityFlags(
  current: string[] | undefined,
  add: string[],
  remove: string[] = [],
) {
  const removeSet = new Set(remove);

  return Array.from(
    new Set([
      ...(current ?? []).filter((flag) => flag && !removeSet.has(flag)),
      ...add.filter((flag) => flag && !removeSet.has(flag)),
    ]),
  );
}

function needsClosetConfirmation(item: ClothingItem) {
  const flags = filterLegacyDisplayImageFlags(item.imageQualityFlags);
  const pending =
    item.category === "待识别" ||
    item.category === "识别中" ||
    item.styleTags.includes("待识别") ||
    item.styleTags.includes("AI 识别中");

  return (
    !item.userCorrected &&
    (flags.includes("needs_ai_label_confirmation") ||
      flags.includes("closet_analysis_failed") ||
      pending)
  );
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

async function fetchImageAsDataUrl(imageUrl: string) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error("原图读取失败，无法重新生成展示图。");
  }

  return blobToDataUrl(await response.blob());
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function calculateBmi(heightCm: number | null, weightKg: number | null) {
  if (!heightCm || !weightKg || heightCm <= 0 || weightKg <= 0) return null;
  const heightM = heightCm / 100;
  return Number((weightKg / (heightM * heightM)).toFixed(1));
}

function getBmiBand(bmi: number | null): UserProfile["bmiBand"] {
  if (!bmi) return null;
  if (bmi < 18.5) return "underweight";
  if (bmi < 24) return "normal";
  if (bmi < 28) return "overweight";
  return "obese";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function loadImageResource(url: string, timeoutMs = 30_000): Promise<TimingOutcome> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const timeoutId = window.setTimeout(() => finish("timeout"), timeoutMs);

    function finish(outcome: TimingOutcome) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      resolve(outcome);
    }

    image.decoding = "async";
    image.onload = () => finish("success");
    image.onerror = () => finish("failure");
    image.src = url;
  });
}

function getBmiLabel(bmi: number | null) {
  if (!bmi) return "待完善";
  const band = getBmiBand(bmi);
  const labels: Record<NonNullable<UserProfile["bmiBand"]>, string> = {
    underweight: "偏低",
    normal: "正常",
    overweight: "偏高",
    obese: "较高",
  };
  return `${bmi}（${band ? labels[band] : "待完善"}）`;
}

function parseOptionalNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export default function Home() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<AppView>("chat");
  const [decisionItems, setDecisionItems] = useState<DecisionItem[]>([]);
  const [filter, setFilter] = useState<DecisionStatus | "all">("all");
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | undefined>();
  const [chatState, setChatState] = useState<DecisionChatState>(() => createEmptyChatState());
  const [decisionRunsBySessionId, setDecisionRunsBySessionId] = useState<
    Record<string, DecisionRun>
  >({});
  const [userClosetItems, setUserClosetItems] = useState<ClothingItem[]>([]);
  const [closetLoading, setClosetLoading] = useState(false);
  const [closetUploadBusy, setClosetUploadBusy] = useState(false);
  const [closetMessage, setClosetMessage] = useState("");
  const [displayCompletionNotices, setDisplayCompletionNotices] = useState<
    DisplayCompletionNotice[]
  >([]);
  const [busyClosetItemIds, setBusyClosetItemIds] = useState<ClosetBusyItemIds>(
    createEmptyClosetBusyItemIds,
  );
  const [queuedAnalysisItemIds, setQueuedAnalysisItemIds] = useState<string[]>([]);
  const analysisQueueRef = useRef<
    Array<{ item: ClothingItem; userFeedback?: string; sessionEpoch: number }>
  >([]);
  const activeAnalysisCountRef = useRef(0);
  const activeAnalysisIdsRef = useRef(new Set<string>());
  const queuedAnalysisIdsRef = useRef(new Set<string>());
  const deletedClosetItemIdsRef = useRef(new Set<string>());
  const closetRequestControllersRef = useRef<
    Record<ClosetAbortableOperation, Map<string, Set<AbortController>>>
  >({
    analysis: new Map(),
    display: new Map(),
  });
  const busyItemCountsRef = useRef(createClosetBusyCountMaps());
  const closetUploadBusyRef = useRef(false);
  const closetUploadTracesRef = useRef(new Map<string, ClosetUploadTraceContext>());
  const activeClosetUploadTracesRef = useRef(new Set<ClosetUploadTraceContext>());
  const activeUserIdRef = useRef<string | null>(null);
  const closetSessionEpochRef = useRef(0);
  const closetLoadRequestRef = useRef(0);
  const chatHydrationRequestRef = useRef(0);
  const chatNavigationEpochRef = useRef(0);
  const hydratedDecisionRunFingerprintRef = useRef<string | null>(null);
  const openChatSessionRef = useRef<
    (sessionId: string, options?: { navigate?: boolean }) => Promise<void>
  >(async () => undefined);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  const displayCompletionSummary = useMemo(
    () => formatDisplayCompletionNoticeSummary(displayCompletionNotices, userClosetItems),
    [displayCompletionNotices, userClosetItems],
  );

  const resetActiveChatState = useCallback(() => {
    chatNavigationEpochRef.current += 1;
    chatHydrationRequestRef.current += 1;
    hydratedDecisionRunFingerprintRef.current = null;
    activeChatIdRef.current = undefined;
    setActiveChatId(undefined);
    setChatState(createEmptyChatState());
  }, []);

  const flushClosetUploadTraces = useCallback(() => {
    activeClosetUploadTracesRef.current.forEach((context) => {
      context.finishDisplayImageLoad("timeout");
      void finalizeClosetUploadTrace(context);
    });
    activeClosetUploadTracesRef.current.clear();
    closetUploadTracesRef.current.clear();
  }, []);

  const clearClosetTransientState = useCallback(() => {
    closetLoadRequestRef.current += 1;
    setDisplayCompletionNotices([]);
    setBusyClosetItemIds(createEmptyClosetBusyItemIds());
    busyItemCountsRef.current = createClosetBusyCountMaps();
    setQueuedAnalysisItemIds([]);
    activeAnalysisIdsRef.current.clear();
    queuedAnalysisIdsRef.current.clear();
    deletedClosetItemIdsRef.current.clear();
    Object.values(closetRequestControllersRef.current).forEach((controllersByItem) => {
      controllersByItem.forEach((controllers) =>
        controllers.forEach((controller) => controller.abort()),
      );
      controllersByItem.clear();
    });
    analysisQueueRef.current = [];
    activeAnalysisCountRef.current = 0;
    closetUploadBusyRef.current = false;
    setClosetUploadBusy(false);
    setClosetLoading(false);
    setClosetMessage("");
    flushClosetUploadTraces();
  }, [flushClosetUploadTraces]);

  const updateAuthenticatedUser = useCallback(
    (nextUser: User | null) => {
      const nextUserId = nextUser?.id ?? null;
      const userChanged = activeUserIdRef.current !== nextUserId;

      if (userChanged) {
        activeUserIdRef.current = nextUserId;
        closetSessionEpochRef.current += 1;
        clearClosetTransientState();
      }
      setUser(nextUser);
      return userChanged;
    },
    [clearClosetTransientState],
  );

  function isCurrentClosetSession(sessionEpoch: number) {
    return closetSessionEpochRef.current === sessionEpoch && activeUserIdRef.current !== null;
  }

  function isActiveClosetItem(itemId: string, sessionEpoch: number) {
    return (
      isCurrentClosetSession(sessionEpoch) && !deletedClosetItemIdsRef.current.has(itemId)
    );
  }

  function createClosetRequestController(
    operation: ClosetAbortableOperation,
    itemId: string,
  ) {
    const controller = new AbortController();
    const controllersByItem = closetRequestControllersRef.current[operation];
    const controllers = controllersByItem.get(itemId) ?? new Set<AbortController>();
    controllers.add(controller);
    controllersByItem.set(itemId, controllers);
    return controller;
  }

  function releaseClosetRequestController(
    operation: ClosetAbortableOperation,
    itemId: string,
    controller: AbortController,
  ) {
    const controllersByItem = closetRequestControllersRef.current[operation];
    const controllers = controllersByItem.get(itemId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) controllersByItem.delete(itemId);
  }

  function abortClosetItemRequests(itemId: string) {
    (Object.keys(closetRequestControllersRef.current) as ClosetAbortableOperation[]).forEach(
      (operation) => {
        const controllers = closetRequestControllersRef.current[operation].get(itemId);
        controllers?.forEach((controller) => controller.abort());
        closetRequestControllersRef.current[operation].delete(itemId);
      },
    );
  }

  useEffect(() => {
    if (!displayCompletionNotices.length) return;

    const timeoutId = window.setTimeout(() => {
      setDisplayCompletionNotices([]);
    }, 8_000);

    return () => window.clearTimeout(timeoutId);
  }, [displayCompletionNotices]);

  const loadProfile = useCallback(
    async (userId: string) => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (activeUserIdRef.current !== userId) return;

      if (error) {
        console.error(error);
        setProfile(createEmptyProfile(userId));
        return;
      }

      setProfile(data ? mapProfileFromDb(data) : createEmptyProfile(userId));
    },
    [supabase],
  );

  const loadClosetItems = useCallback(
    async (userId: string) => {
      if (activeUserIdRef.current !== userId) return;
      const requestId = closetLoadRequestRef.current + 1;
      closetLoadRequestRef.current = requestId;
      const sessionEpoch = closetSessionEpochRef.current;
      const isCurrentLoad = () =>
        activeUserIdRef.current === userId &&
        closetSessionEpochRef.current === sessionEpoch &&
        closetLoadRequestRef.current === requestId;

      setClosetLoading(true);
      setClosetMessage("");

      const { data, error } = await supabase
        .from("closet_items")
        .select(closetItemSelect)
        .eq("user_id", userId)
        .neq("status", "archived")
        .order("updated_at", { ascending: false });

      if (!isCurrentLoad()) return;

      if (error) {
        console.error(error);
        setUserClosetItems([]);
        setClosetMessage("衣橱读取失败，请稍后再试。");
        setClosetLoading(false);
        return;
      }

      const mappedItems = await Promise.all(
        ((data ?? []) as ClosetItemRow[]).map((item) => mapClosetItemFromDb(supabase, item)),
      );
      if (!isCurrentLoad()) return;
      setUserClosetItems(mappedItems);
      setClosetLoading(false);
    },
    [supabase],
  );

  const loadChatSessions = useCallback(
    async (userId: string) => {
      const { data: sessionsData, error: sessionsError } = await supabase
        .from("chat_sessions")
        .select("id,title,status,created_at,updated_at")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(30);

      if (activeUserIdRef.current !== userId) return;

      if (sessionsError) {
        console.error(sessionsError);
        setChatSessions([]);
        return;
      }

      const sessions = (sessionsData ?? []) as ChatSessionRow[];
      const sessionIds = sessions.map((session) => session.id);
      let messages: ChatMessageRow[] = [];

      if (sessionIds.length) {
        const { data: messagesData, error: messagesError } = await supabase
          .from("chat_messages")
          .select("id,session_id,role,content,image_path,candidate_id,report_id,metadata,created_at")
          .in("session_id", sessionIds)
          .order("created_at", { ascending: false });

        if (messagesError) {
          console.error(messagesError);
        } else {
          messages = (messagesData ?? []) as ChatMessageRow[];
        }
      }

      const messagesBySession = new Map<string, ChatMessageRow[]>();
      messages.forEach((message) => {
        const list = messagesBySession.get(message.session_id) ?? [];
        list.push(message);
        messagesBySession.set(message.session_id, list);
      });

      const mappedSessions = await Promise.all(
        sessions.map(async (session) => {
          const sessionMessages = messagesBySession.get(session.id) ?? [];
          const latestUserMessage = sessionMessages.find((message) => message.role === "user");
          const latestAssistantMessage = sessionMessages.find((message) => message.role === "assistant");
          const imagePath = latestUserMessage?.image_path;
          const thumbnailUrl = await createStorageSignedUrl(
            supabase,
            "purchase-screenshots",
            imagePath,
          );

          return {
            id: session.id,
            title: session.title || createChatTitle(latestUserMessage?.content ?? "", Boolean(imagePath)),
            subtitle: `${getMessagePreview(latestAssistantMessage?.content ?? latestUserMessage?.content)} · ${formatRelativeTime(session.updated_at)}`,
            palette: getPaletteByColor(undefined),
            thumbnailUrl,
            imagePath: imagePath ?? undefined,
            updatedAt: session.updated_at,
          } satisfies ChatSession;
        }),
      );

      if (activeUserIdRef.current !== userId) return;
      setChatSessions(mappedSessions);
    },
    [supabase],
  );

  const loadDecisionRuns = useCallback(
    async (userId: string) => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token || activeUserIdRef.current !== userId) return;

      const response = await fetch("/api/ai/decision-runs", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("决策任务状态读取失败。");
      }

      const result = (await response.json()) as { runs?: DecisionRun[] };
      if (activeUserIdRef.current !== userId) return;
      const latestRuns = Object.values(indexLatestDecisionRuns(result.runs ?? []));
      setDecisionRunsBySessionId((current) => mergeDecisionRuns(current, latestRuns));
    },
    [supabase],
  );

  const loadDecisionItems = useCallback(
    async (userId: string) => {
      const { data, error } = await supabase
        .from("decision_items")
        .select(
          "id,status,report_id,session_id,size_label,snapshot_summary,snapshot_outfit_tips,snapshot_risks,reminder_at,created_at,updated_at,candidate:purchase_candidates(id,product_name,summary,category,color,estimated_price,screenshot_path),report:assessment_reports(id,summary,outfit_combinations)",
        )
        .eq("user_id", userId)
        .neq("status", "not_considering")
        .order("updated_at", { ascending: false })
        .limit(80);

      if (activeUserIdRef.current !== userId) return;

      if (error) {
        console.error(error);
        setDecisionItems([]);
        return;
      }

      const rows = (data ?? []) as unknown as DecisionItemRow[];
      const sessionIds = Array.from(
        new Set(rows.map((item) => item.session_id).filter((id): id is string => Boolean(id))),
      );
      const reportNamesByReportId = new Map<string, string>();
      const reportNamesBySessionId = new Map<string, string>();
      const closetImagesById = new Map<string, DecisionClosetImageInfo>();
      const tryOnResultsByReportId = new Map<
        string,
        NonNullable<DecisionItem["tryOnResults"]>
      >();

      if (sessionIds.length) {
        const { data: messageData, error: messageError } = await supabase
          .from("chat_messages")
          .select("session_id,report_id,role,metadata,created_at")
          .in("session_id", sessionIds)
          .eq("role", "assistant")
          .order("created_at", { ascending: false });

        if (messageError) {
          console.error(messageError);
        } else {
          ((messageData ?? []) as unknown as DecisionReportMessageRow[]).forEach((message) => {
            const productName = getReportProductNameFromMetadata(message.metadata);
            if (!productName) return;
            if (message.report_id && !reportNamesByReportId.has(message.report_id)) {
              reportNamesByReportId.set(message.report_id, productName);
            }
            if (!reportNamesBySessionId.has(message.session_id)) {
              reportNamesBySessionId.set(message.session_id, productName);
            }
          });
        }
      }

      const reportIds = Array.from(
        new Set(rows.map((item) => item.report_id ?? item.report?.id).filter((id): id is string => Boolean(id))),
      );
      if (reportIds.length) {
        const { data: tryOnData, error: tryOnError } = await supabase
          .from("outfit_try_on_images")
          .select("report_id,outfit_id,position,image_path,status")
          .in("report_id", reportIds)
          .order("position", { ascending: true });

        if (tryOnError) {
          console.error(tryOnError);
        } else {
          await Promise.all(
            ((tryOnData ?? []) as unknown as DecisionTryOnImageRow[]).map(async (tryOn) => {
              const imageUrl =
                tryOn.status === "ready"
                  ? await createStorageSignedUrl(supabase, "purchase-screenshots", tryOn.image_path)
                  : undefined;
              const existing = tryOnResultsByReportId.get(tryOn.report_id) ?? [];
              existing.push({
                outfitId: tryOn.outfit_id,
                position: tryOn.position,
                status: tryOn.status === "ready" && imageUrl ? "ready" : "failed",
                imageUrl,
              });
              tryOnResultsByReportId.set(tryOn.report_id, existing);
            }),
          );
        }
      }

      const outfitClosetIds = collectDecisionOutfitClosetIds(rows);
      if (outfitClosetIds.length) {
        const { data: closetImageData, error: closetImageError } = await supabase
          .from("closet_items")
          .select(
            "id,image_path,processed_image_path,display_image_path,summary,category,color,style_tags,scenario_tags",
          )
          .eq("user_id", userId)
          .in("id", outfitClosetIds);

        if (closetImageError) {
          console.error(closetImageError);
        } else {
          await Promise.all(
            ((closetImageData ?? []) as unknown as DecisionClosetImageRow[]).map(async (closetItem) => {
              const imagePath =
                closetItem.display_image_path ??
                closetItem.processed_image_path ??
                closetItem.image_path;
              const imageUrl = await createStorageSignedUrl(supabase, "closet-images", imagePath);

              closetImagesById.set(closetItem.id, {
                imageUrl,
                name: closetItem.summary ?? undefined,
                category: closetItem.category ?? undefined,
                tags: [
                  ...(closetItem.style_tags ?? []),
                  ...(closetItem.scenario_tags ?? []),
                  closetItem.color ?? "",
                ].filter(Boolean).slice(0, 4),
              });
            }),
          );
        }
      }

      const mappedItems = await Promise.all(
        rows.map(async (item) => {
          const candidate = item.candidate;
          const imageUrl = await createStorageSignedUrl(
            supabase,
            "purchase-screenshots",
            candidate?.screenshot_path,
          );
          const priceKnown = isKnownDecisionPrice(candidate?.estimated_price);
          const price = priceKnown ? Number(candidate?.estimated_price) : 0;
          const reportProductName =
            (item.report_id ? reportNamesByReportId.get(item.report_id) : undefined) ??
            (item.session_id ? reportNamesBySessionId.get(item.session_id) : undefined);
          const productName = createDecisionProductName(
            reportProductName ?? candidate?.product_name,
            candidate?.summary,
            candidate?.color,
            candidate?.category,
          );
          const outfitCombinations = Array.isArray(item.report?.outfit_combinations)
            ? hydrateDecisionOutfitImages(
                withStableOutfitIds(
                  item.report.outfit_combinations as unknown as Parameters<
                    typeof withStableOutfitIds
                  >[0],
                ),
                closetImagesById,
              )
            : [];

          return {
            id: item.id,
            candidateId: candidate?.id ?? undefined,
            reportId: item.report_id ?? item.report?.id ?? undefined,
            sessionId: item.session_id ?? undefined,
            productName,
            merchant: "",
            price,
            priceKnown,
            status: item.status,
            color: candidate?.color ?? "待确认",
            size: item.size_label ?? "待确认",
            summary: item.snapshot_summary ?? "已保存一次购买决策，建议后续结合真实穿着场景复盘。",
            outfitTips: item.snapshot_outfit_tips?.length
              ? item.snapshot_outfit_tips
              : ["回看当时的搭配证据", "结合已有衣橱判断复用率"],
            outfitCombinations,
            tryOnResults: item.report_id
              ? tryOnResultsByReportId.get(item.report_id)
              : item.report?.id
                ? tryOnResultsByReportId.get(item.report.id)
                : undefined,
            risks: item.snapshot_risks?.length
              ? item.snapshot_risks
              : ["信息不足时建议先收藏观察"],
            lastAskedAt: formatRelativeTime(item.updated_at),
            reminderAt: formatReminderLabel(item.reminder_at),
            imagePath: candidate?.screenshot_path ?? undefined,
            imageUrl,
            palette: getPaletteByColor(candidate?.color),
          } satisfies DecisionItem;
        }),
      );

      if (activeUserIdRef.current !== userId) return;
      setDecisionItems(mappedItems);
    },
    [supabase],
  );

  useEffect(() => {
    let active = true;
    const authFallbackId = setTimeout(() => {
      if (!active) return;
      console.warn("Auth initialization fallback fired.");
      closetLoadRequestRef.current += 1;
      setAuthLoading(false);
      setClosetLoading(false);
    }, 10000);

    async function loadSession() {
      try {
        const { data } = await withTimeout(
          supabase.auth.getSession(),
          5000,
          "Supabase session initialization",
        );
        if (!active) return;

        const sessionUser = data.session?.user ?? null;
        const userChanged = updateAuthenticatedUser(sessionUser);
        if (sessionUser && userChanged) {
          resetActiveChatState();
          setProfile(null);
          setUserClosetItems([]);
          setChatSessions([]);
          setDecisionItems([]);
          setDecisionRunsBySessionId({});
          const results = await Promise.allSettled([
            withTimeout(loadProfile(sessionUser.id), 8000, "profile load"),
            withTimeout(loadClosetItems(sessionUser.id), 8000, "closet load"),
            withTimeout(loadChatSessions(sessionUser.id), 8000, "chat sessions load"),
            withTimeout(loadDecisionItems(sessionUser.id), 8000, "decision items load"),
            withTimeout(loadDecisionRuns(sessionUser.id), 8000, "decision runs load"),
          ]);

          if (activeUserIdRef.current !== sessionUser.id) return;

          results.forEach((result, index) => {
            if (result.status === "rejected") {
              if (index === 0) setProfile(createEmptyProfile(sessionUser.id));
              if (index === 1) {
                closetLoadRequestRef.current += 1;
                setClosetLoading(false);
                setClosetMessage("衣橱加载较慢，已先进入页面。你可以稍后刷新或重新打开衣橱。");
              }
              if (index === 2) setChatSessions([]);
              if (index === 3) setDecisionItems([]);
              if (index === 4) setDecisionRunsBySessionId({});
              console.error(
                ["profile", "closet", "chats", "decisions", "decision runs"][index],
                result.reason,
              );
            }
          });
        }
      } catch (error) {
        console.error(error);
      } finally {
        if (active) {
          clearTimeout(authFallbackId);
          setAuthLoading(false);
        }
      }
    }

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionUser = session?.user ?? null;
      const userChanged = updateAuthenticatedUser(sessionUser);
      setAuthLoading(false);
      if (sessionUser) {
        if (!userChanged) return;
        resetActiveChatState();
        setProfile(null);
        setUserClosetItems([]);
        setChatSessions([]);
        setDecisionItems([]);
        setDecisionRunsBySessionId({});
        loadProfile(sessionUser.id);
        loadClosetItems(sessionUser.id);
        loadChatSessions(sessionUser.id);
        loadDecisionItems(sessionUser.id);
        loadDecisionRuns(sessionUser.id);
      } else {
        resetActiveChatState();
        setProfile(null);
        setUserClosetItems([]);
        setChatSessions([]);
        setDecisionItems([]);
        setDecisionRunsBySessionId({});
      }
    });

    return () => {
      active = false;
      clearTimeout(authFallbackId);
      listener.subscription.unsubscribe();
      flushClosetUploadTraces();
    };
  }, [
    flushClosetUploadTraces,
    clearClosetTransientState,
    loadChatSessions,
    loadClosetItems,
    loadDecisionItems,
    loadDecisionRuns,
    loadProfile,
    resetActiveChatState,
    supabase,
    updateAuthenticatedUser,
  ]);

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    if (!user) return;

    const userId = user.id;
    const channel = supabase
      .channel(`decision-runs:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "decision_runs",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const nextRow = payload.new as DecisionRunRow;
          if (!nextRow?.id || nextRow.user_id !== userId) return;
          const nextRun = mapDecisionRunRow(nextRow);
          setDecisionRunsBySessionId((current) => mergeDecisionRun(current, nextRun));
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void loadDecisionRuns(userId).catch(console.error);
        }
      });

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadDecisionRuns(userId).catch(console.error);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void supabase.removeChannel(channel);
    };
  }, [loadDecisionRuns, supabase, user]);

  const hasActiveDecisionRuns = useMemo(
    () => Object.values(decisionRunsBySessionId).some((run) => isDecisionRunActive(run.status)),
    [decisionRunsBySessionId],
  );

  useEffect(() => {
    if (!user || !hasActiveDecisionRuns) return;

    const intervalId = window.setInterval(() => {
      void loadDecisionRuns(user.id).catch(console.error);
    }, DECISION_RUN_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [hasActiveDecisionRuns, loadDecisionRuns, user]);

  const filteredDecisions = useMemo(() => {
    if (filter === "all") return decisionItems;
    return decisionItems.filter((item) => item.status === filter);
  }, [decisionItems, filter]);
  const activeDecisionRun = activeChatId
    ? decisionRunsBySessionId[activeChatId]
    : undefined;

  useEffect(() => {
    openChatSessionRef.current = openChatSession;
  });

  useEffect(() => {
    if (!activeChatId || !activeDecisionRun) return;
    if (!activeDecisionRun.reportId && !isDecisionRunTerminal(activeDecisionRun.status)) {
      return;
    }

    const fingerprint = [
      activeDecisionRun.sessionId,
      activeDecisionRun.id,
      activeDecisionRun.reportId ?? "",
      activeDecisionRun.assistantMessageId ?? "",
      activeDecisionRun.status,
      activeDecisionRun.updatedAt,
    ].join(":");
    if (hydratedDecisionRunFingerprintRef.current === fingerprint) return;
    hydratedDecisionRunFingerprintRef.current = fingerprint;
    void openChatSessionRef.current(activeChatId, { navigate: false });
  }, [activeChatId, activeDecisionRun]);

  async function saveProfile(nextProfile: UserProfile) {
    const { data, error } = await supabase
      .from("profiles")
      .upsert(
        {
          user_id: nextProfile.userId,
          height_cm: nextProfile.heightCm,
          weight_kg: nextProfile.weightKg,
          bmi: nextProfile.bmi,
          bmi_band: nextProfile.bmiBand,
          style_preferences: nextProfile.stylePreferences,
          disliked_categories: nextProfile.dislikedCategories,
          common_scenarios: nextProfile.commonScenarios,
          budget_sensitivity: nextProfile.budgetSensitivity,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .select("*")
      .single();

    if (error) throw error;
    setProfile(mapProfileFromDb(data));
  }

  async function signOut() {
    await supabase.auth.signOut();
    updateAuthenticatedUser(null);
    setProfile(null);
    setUserClosetItems([]);
    setChatSessions([]);
    setDecisionItems([]);
    setDecisionRunsBySessionId({});
    resetActiveChatState();
    clearClosetTransientState();
    setView("chat");
  }

  function markItemBusy(
    operation: ClosetBusyOperation,
    itemId: string,
    busy: boolean,
    sessionEpoch?: number,
  ) {
    if (sessionEpoch !== undefined && !isCurrentClosetSession(sessionEpoch)) return;

    const counts = busyItemCountsRef.current[operation];
    const currentCount = counts.get(itemId) ?? 0;

    if (busy) {
      counts.set(itemId, currentCount + 1);
    } else if (currentCount <= 1) {
      counts.delete(itemId);
    } else {
      counts.set(itemId, currentCount - 1);
    }

    setBusyClosetItemIds((current) => ({
      ...current,
      [operation]: [...counts.keys()],
    }));
  }

  function announceDisplayCompletion(
    itemId: string,
    outcome: DisplayCompletionNotice["outcome"],
    sessionEpoch: number,
  ) {
    if (!isActiveClosetItem(itemId, sessionEpoch)) return;
    setDisplayCompletionNotices((current) =>
      mergeDisplayCompletionNotices(current, { itemId, outcome }),
    );
  }

  function recordClosetImageLoad(
    itemId: string,
    imageUrl: string,
    outcome: Extract<TimingOutcome, "success" | "failure">,
  ) {
    const context = closetUploadTracesRef.current.get(itemId);
    if (!context || context.displayImageUrl !== imageUrl) return;
    const accepted = context.finishDisplayImageLoad(outcome);
    if (!accepted) return;

    if (!isActiveClosetItem(itemId, context.sessionEpoch)) return;

    if (outcome === "success") {
      announceDisplayCompletion(itemId, "success", context.sessionEpoch);
    } else {
      setUserClosetItems((items) =>
        items.map((item) =>
          item.id === itemId && item.displayImageUrl === imageUrl
            ? {
                ...item,
                displayImageUrl: undefined,
                imageUrl: item.originalImageUrl ?? item.imageUrl,
              }
            : item,
        ),
      );
      announceDisplayCompletion(itemId, "warning", context.sessionEpoch);
    }
  }

  function setAnalysisQueued(itemId: string, queued: boolean, sessionEpoch?: number) {
    if (sessionEpoch !== undefined && !isCurrentClosetSession(sessionEpoch)) return;
    if (queued && deletedClosetItemIdsRef.current.has(itemId)) return;

    if (queued) {
      queuedAnalysisIdsRef.current.add(itemId);
    } else {
      queuedAnalysisIdsRef.current.delete(itemId);
    }

    setQueuedAnalysisItemIds([...queuedAnalysisIdsRef.current]);
  }

  function setAnalysisActive(itemId: string, active: boolean, sessionEpoch?: number) {
    if (sessionEpoch !== undefined && !isCurrentClosetSession(sessionEpoch)) return;
    if (active && deletedClosetItemIdsRef.current.has(itemId)) return;

    if (active) {
      activeAnalysisIdsRef.current.add(itemId);
    } else {
      activeAnalysisIdsRef.current.delete(itemId);
    }
  }

  function updateLocalItemFlags(
    itemId: string,
    add: string[],
    remove: string[] = [],
    sessionEpoch?: number,
  ) {
    if (
      sessionEpoch !== undefined &&
      (!isCurrentClosetSession(sessionEpoch) || deletedClosetItemIdsRef.current.has(itemId))
    ) {
      return;
    }

    setUserClosetItems((items) =>
      items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              imageQualityFlags: mergeImageQualityFlags(item.imageQualityFlags, add, remove),
            }
          : item,
      ),
    );
  }

  function processAnalysisQueue() {
    while (activeAnalysisCountRef.current < 2 && analysisQueueRef.current.length > 0) {
      const task = analysisQueueRef.current.shift();
      if (!task) return;
      if (!isCurrentClosetSession(task.sessionEpoch)) continue;
      if (deletedClosetItemIdsRef.current.has(task.item.id)) {
        setAnalysisQueued(task.item.id, false, task.sessionEpoch);
        continue;
      }

      setAnalysisQueued(task.item.id, false, task.sessionEpoch);
      setAnalysisActive(task.item.id, true, task.sessionEpoch);
      markItemBusy("analysis", task.item.id, true, task.sessionEpoch);
      updateLocalItemFlags(
        task.item.id,
        ["closet_analysis_processing", "needs_ai_label_confirmation"],
        ["closet_analysis_queued", "closet_analysis_failed"],
        task.sessionEpoch,
      );
      activeAnalysisCountRef.current += 1;

      void runQueuedClosetAnalysis(task.item, task.userFeedback, task.sessionEpoch).finally(() => {
        if (!isCurrentClosetSession(task.sessionEpoch)) return;
        setAnalysisActive(task.item.id, false, task.sessionEpoch);
        markItemBusy("analysis", task.item.id, false, task.sessionEpoch);
        activeAnalysisCountRef.current = Math.max(0, activeAnalysisCountRef.current - 1);
        processAnalysisQueue();
      });
    }
  }

  async function uploadClosetImages(files: File[]) {
    if (!user || files.length === 0) return;
    if (closetUploadBusyRef.current) {
      setClosetMessage("上一批衣服仍在识别，请等待识别完成后再继续上传。");
      return;
    }
    const sessionEpoch = closetSessionEpochRef.current;

    closetUploadBusyRef.current = true;
    setClosetUploadBusy(true);
    setClosetMessage("");
    const traceContexts: ClosetUploadTraceContext[] = [];
    const createdItems: ClothingItem[] = [];
    let preparationFailureCount = 0;
    let firstPreparationError: unknown;
    const displayJobs: Array<{
      item: ClothingItem;
      imageDataUrl: string;
      context: ClosetUploadTraceContext;
      queueSpan: TimingSpanHandle;
    }> = [];
    const analysisJobs: Array<{
      item: ClothingItem;
      imageDataUrl: string;
      fileName: string;
      context: ClosetUploadTraceContext;
      queueSpan: TimingSpanHandle;
    }> = [];

    try {
      for (const file of files) {
        const context = createClosetUploadTraceContext(file, files.length, sessionEpoch);
        traceContexts.push(context);
        activeClosetUploadTracesRef.current.add(context);
        try {
          if (!isCurrentClosetSession(sessionEpoch)) {
            throw new Error("登录会话已切换，上传流程已停止。");
          }

          const imageDataUrl = await context.trace.measure("file_read", () => fileToDataUrl(file));
          context.dataUrlChars = imageDataUrl.length;
          if (!isCurrentClosetSession(sessionEpoch)) {
            throw new Error("登录会话已切换，上传流程已停止。");
          }

          const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
          const safeExtension = ["jpg", "jpeg", "png", "webp"].includes(extension)
            ? extension
            : "jpg";
          const imagePath = `${user.id}/${crypto.randomUUID()}.${safeExtension}`;

          const { error: uploadError } = await context.trace.measure(
            "original_storage_upload",
            () =>
              supabase.storage.from("closet-images").upload(imagePath, file, {
                cacheControl: "3600",
                contentType: file.type,
                upsert: false,
              }),
            (result) => (result.error ? "failure" : "success"),
          );

          if (uploadError) throw uploadError;
          if (!isCurrentClosetSession(sessionEpoch)) {
            throw new Error("登录会话已切换，上传流程已停止。");
          }

          const { data, error } = await context.trace.measure(
            "item_insert",
            () =>
              supabase
                .from("closet_items")
                .insert({
                  user_id: user.id,
                  image_path: imagePath,
                  processed_image_path: null,
                  display_image_path: null,
                  display_image_status: "queued",
                  display_image_model: null,
                  display_image_prompt_version: null,
                  image_quality_flags: [
                    "original_saved",
                    "closet_analysis_queued",
                    "needs_ai_label_confirmation",
                  ],
                  category: "待识别",
                  color: "待识别",
                  fit: "unknown",
                  style_tags: ["待识别"],
                  scenario_tags: [],
                  season: [],
                  wear_frequency: "unknown",
                  status: "active",
                  summary: file.name.replace(/\.[^.]+$/, "") || "新上传衣服",
                  embedding_text: null,
                  ai_confidence: null,
                  user_corrected: false,
                })
                .select(closetItemSelect)
                .single(),
            (result) => (result.error || !result.data ? "failure" : "success"),
          );

          if (error) throw error;
          if (!isCurrentClosetSession(sessionEpoch)) {
            throw new Error("登录会话已切换，上传流程已停止。");
          }

          const mappedItem = await mapClosetItemFromDb(supabase, data as ClosetItemRow, {
            trace: context.trace,
            prefix: "initial",
          });
          if (!isCurrentClosetSession(sessionEpoch)) {
            throw new Error("登录会话已切换，上传流程已停止。");
          }

          context.itemId = mappedItem.id;
          if (!context.finalized) {
            closetUploadTracesRef.current.set(mappedItem.id, context);
          }
          createdItems.push(mappedItem);
          displayJobs.push({
            item: mappedItem,
            imageDataUrl,
            context,
            queueSpan: context.trace.startSpan("display_queue_wait"),
          });
          analysisJobs.push({
            item: mappedItem,
            imageDataUrl,
            fileName: file.name,
            context,
            queueSpan: context.trace.startSpan("analysis_queue_wait"),
          });
        } catch (itemError) {
          preparationFailureCount += 1;
          firstPreparationError ??= itemError;
          context.analysisSucceeded = false;
          context.displaySucceeded = false;
          context.finishDisplayImageLoad("failure");
          void finalizeClosetUploadTrace(context).finally(() => {
            activeClosetUploadTracesRef.current.delete(context);
            if (context.itemId) closetUploadTracesRef.current.delete(context.itemId);
          });
          console.error("[closet-upload] item preparation failed", itemError);

          if (!isCurrentClosetSession(sessionEpoch)) throw itemError;
        }
      }

      if (createdItems.length === 0) {
        throw firstPreparationError ?? new Error("上传失败，请稍后再试。");
      }

      if (!isCurrentClosetSession(sessionEpoch)) {
        throw new Error("登录会话已切换，上传流程已停止。");
      }
      setUserClosetItems((items) => [...createdItems, ...items]);
      setClosetMessage(
        `已上传 ${createdItems.length} 件衣服${preparationFailureCount ? `，另有 ${preparationFailureCount} 件未完成上传` : ""}。正在并行生成展示图和识别衣服标签，原图已保留作为事实来源。`,
      );

      let analysisSuccessCount = 0;
      const displayPromise = runWithConcurrency(
        displayJobs,
        2,
        async (job) => {
          job.queueSpan.finish();
          if (deletedClosetItemIdsRef.current.has(job.item.id)) {
            job.context.displaySucceeded = false;
            job.context.finishDisplayImageLoad("failure");
            return;
          }
          const result = await generateClosetDisplayImage(job.item, job.imageDataUrl, job.context);
          job.context.displaySucceeded = result.ok;
        },
        {
          onQueued: (job) =>
            markItemBusy("display", job.item.id, true, job.context.sessionEpoch),
          onSettled: (job) =>
            markItemBusy("display", job.item.id, false, job.context.sessionEpoch),
        },
      ).catch((error) => {
        console.error("[closet-upload] display workflow failed", error);
        displayJobs.forEach((job) => {
          if (job.context.displaySucceeded === undefined) {
            job.context.displaySucceeded = false;
            job.context.finishDisplayImageLoad("failure");
          }
        });
      });
      const analysisPromise = runWithConcurrency(
        analysisJobs,
        2,
        async (job) => {
          job.queueSpan.finish();
          if (deletedClosetItemIdsRef.current.has(job.item.id)) {
            job.context.analysisSucceeded = false;
            return;
          }
          const result = await analyzeClosetItem(
            job.item,
            job.imageDataUrl,
            { fileName: job.fileName },
            job.context,
          );
          job.context.analysisSucceeded = result.ok;
          if (result.ok) analysisSuccessCount += 1;
        },
        {
          onQueued: (job) => setAnalysisQueued(job.item.id, true, job.context.sessionEpoch),
          onStarted: (job) => setAnalysisQueued(job.item.id, false, job.context.sessionEpoch),
          onSettled: (job) => setAnalysisQueued(job.item.id, false, job.context.sessionEpoch),
        },
      ).catch((error) => {
        console.error("[closet-upload] analysis workflow failed", error);
        analysisJobs.forEach((job) => {
          if (job.context.analysisSucceeded === undefined) {
            job.context.analysisSucceeded = false;
          }
        });
      });

      void Promise.all([analysisPromise, displayPromise]).then(() => {
        traceContexts.forEach((context) => {
          void finalizeClosetUploadTrace(context).finally(() => {
            activeClosetUploadTracesRef.current.delete(context);
            if (context.itemId) closetUploadTracesRef.current.delete(context.itemId);
          });
        });
      });

      await analysisPromise;

      if (!isCurrentClosetSession(sessionEpoch)) return;

      const activeCreatedItems = createdItems.filter(
        (item) => !deletedClosetItemIdsRef.current.has(item.id),
      );
      if (activeCreatedItems.length === 0) {
        setClosetMessage("已删除本次上传的衣服。");
        return;
      }

      if (analysisSuccessCount === activeCreatedItems.length) {
        setClosetMessage(
          `已识别 ${analysisSuccessCount} 件衣服，可以立即确认保存${preparationFailureCount ? `；另有 ${preparationFailureCount} 件未完成上传` : ""}。展示图会继续生成，完成后会通知你。`,
        );
      } else {
        setClosetMessage(
          `已上传 ${activeCreatedItems.length} 件衣服，其中 ${analysisSuccessCount} 件已完成识别，可以先确认保存；识别失败项可在卡片中重试${preparationFailureCount ? `，另有 ${preparationFailureCount} 件未完成上传` : ""}。展示图会继续生成。`,
        );
      }
    } catch (error) {
      displayJobs.forEach((job) => job.queueSpan.finish("failure"));
      analysisJobs.forEach((job) => job.queueSpan.finish("failure"));
      traceContexts.forEach((context) => {
        context.analysisSucceeded = false;
        context.displaySucceeded = false;
        context.finishDisplayImageLoad("failure");
        void finalizeClosetUploadTrace(context).finally(() => {
          activeClosetUploadTracesRef.current.delete(context);
          if (context.itemId) closetUploadTracesRef.current.delete(context.itemId);
        });
      });
      console.error(error);
      if (isCurrentClosetSession(sessionEpoch)) {
        setClosetMessage(error instanceof Error ? error.message : "上传失败，请稍后再试。");
      }
    } finally {
      if (isCurrentClosetSession(sessionEpoch)) {
        closetUploadBusyRef.current = false;
        setClosetUploadBusy(false);
      }
    }
  }

  async function generateClosetDisplayImage(
    item: ClothingItem,
    imageDataUrl: string,
    traceContext?: ClosetUploadTraceContext,
    expectedSessionEpoch = traceContext?.sessionEpoch ?? closetSessionEpochRef.current,
  ) {
    const trace = traceContext?.trace;
    const sessionEpoch = expectedSessionEpoch;

    if (!isActiveClosetItem(item.id, sessionEpoch)) {
      traceContext?.finishDisplayImageLoad("failure");
      return { ok: false, cancelled: true, message: "任务已取消。" };
    }

    const branchSpan = trace?.startSpan("display_branch_total");
    const requestController = createClosetRequestController("display", item.id);
    let branchOutcome: TimingOutcome = "failure";
    markItemBusy("display", item.id, true, sessionEpoch);
    setUserClosetItems((items) =>
      items.map((currentItem) =>
        currentItem.id === item.id
          ? applyClosetDisplayPatch(currentItem, { displayImageStatus: "processing" })
          : currentItem,
      ),
    );

    try {
      if (!item.imagePath) {
        throw new Error("原图路径缺失，无法生成展示图。");
      }

      const { data: sessionData } = await measureWithTrace(
        trace,
        "display_auth_session",
        () => supabase.auth.getSession(),
        (result) => (result.data.session?.access_token ? "success" : "failure"),
      );
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("登录状态已过期，请重新登录。");
      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }

      const requestId = crypto.randomUUID();
      const requestBody = measureSyncWithTrace(trace, "display_request_serialize", () =>
        JSON.stringify({
          closetItemId: item.id,
          imagePath: item.imagePath,
          imageDataUrl,
        }),
      );
      const response = await measureWithTrace(
        trace,
        "display_fetch_ttfb",
        () =>
          fetch("/api/ai/generate-closet-display-image", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "X-Closet-Trace-Id": trace?.traceId ?? crypto.randomUUID(),
              "X-Request-Id": requestId,
            },
            body: requestBody,
            signal: requestController.signal,
          }),
        (result) => (result.ok ? "success" : "failure"),
      );

      if (traceContext) {
        traceContext.displayRequestId = response.headers.get("x-request-id") ?? requestId;
        traceContext.displayServerTiming = response.headers.get("server-timing") ?? undefined;
      }

      const result = await measureWithTrace(trace, "display_response_json", () =>
        response.json() as Promise<{ item?: ClosetDisplayImageRow; message?: string }>,
      );

      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        traceContext?.finishDisplayImageLoad("failure");
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }

      if (!response.ok || !result.item) {
        if (response.status === 409) {
          const authoritative = result.item
            ? {
                patch: {
                  displayImagePath: result.item.display_image_path ?? undefined,
                  displayImageStatus: result.item.display_image_status ?? "processing",
                  displayImageModel: result.item.display_image_model ?? undefined,
                  displayImagePromptVersion:
                    result.item.display_image_prompt_version ?? undefined,
                } satisfies ClosetDisplayPatch,
              }
            : await readAuthoritativeClosetDisplayState(item, trace);
          if (!isActiveClosetItem(item.id, sessionEpoch)) {
            traceContext?.finishDisplayImageLoad("failure");
            return { ok: false, cancelled: true, message: "任务已取消。" };
          }

          setUserClosetItems((items) =>
            items.map((currentItem) =>
              currentItem.id === item.id
                ? applyClosetDisplayPatch(
                    currentItem,
                    authoritative?.patch ?? { displayImageStatus: "processing" },
                  )
                : currentItem,
            ),
          );
          traceContext?.finishDisplayImageLoad("failure");
          return { ok: false, conflict: true, message: result.message ?? "展示图正在生成。" };
        }
        throw new Error(result.message ?? "展示图生成失败。");
      }

      if (!result.item.display_image_path) {
        throw new Error("展示图路径缺失。");
      }
      const { data: displayImage, error: displayImageError } = await measureWithTrace(
        trace,
        "display_response_display_signed_url",
        () =>
          supabase.storage
            .from("closet-images")
            .createSignedUrl(result.item!.display_image_path as string, 60 * 60),
        (signedResult) => (signedResult.error || !signedResult.data?.signedUrl ? "failure" : "success"),
      );
      if (displayImageError) {
        console.warn("[closet-display-image] signed URL unavailable", displayImageError.message);
      }
      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        traceContext?.finishDisplayImageLoad("failure");
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }

      const displayPatch = {
        displayImagePath: result.item.display_image_path,
        displayImageStatus: result.item.display_image_status ?? "ready",
        displayImageModel: result.item.display_image_model ?? undefined,
        displayImagePromptVersion: result.item.display_image_prompt_version ?? undefined,
        ...(displayImage?.signedUrl
          ? { displayImageUrl: displayImage.signedUrl, imageUrl: displayImage.signedUrl }
          : {
              displayImageUrl: undefined,
              imageUrl: item.originalImageUrl ?? item.imageUrl,
            }),
      } satisfies ClosetDisplayPatch;
      if (traceContext) {
        if (displayImage?.signedUrl) {
          traceContext.beginDisplayImageLoad(displayImage.signedUrl);
        } else {
          traceContext.finishDisplayImageLoad("failure");
        }
      }
      setUserClosetItems((items) =>
        items.map((currentItem) =>
          currentItem.id === result.item?.id
            ? applyClosetDisplayPatch(currentItem, displayPatch)
            : currentItem,
        ),
      );
      if (displayImage?.signedUrl) {
        const resourceOutcome = await loadImageResource(displayImage.signedUrl);
        const shouldAnnounce = traceContext
          ? traceContext.finishDisplayImageLoad(resourceOutcome)
          : true;
        const verifiedOutcome = traceContext?.displayImageLoadOutcome ?? resourceOutcome;

        if (!isActiveClosetItem(item.id, sessionEpoch)) {
          return { ok: false, cancelled: true, message: "任务已取消。" };
        }

        if (verifiedOutcome !== "success") {
          setUserClosetItems((items) =>
            items.map((currentItem) =>
              currentItem.id === result.item?.id
                ? applyClosetDisplayPatch(currentItem, {
                    displayImageUrl: undefined,
                    imageUrl:
                      currentItem.originalImageUrl ?? item.originalImageUrl ?? item.imageUrl,
                  })
                : currentItem,
            ),
          );
          if (shouldAnnounce) {
            announceDisplayCompletion(result.item.id, "warning", sessionEpoch);
          }
          return {
            ok: false,
            previewUnavailable: true,
            message: "展示图已生成，但预览暂时无法加载，请稍后刷新衣橱。",
          };
        }

        if (shouldAnnounce) {
          announceDisplayCompletion(result.item.id, "success", sessionEpoch);
        }
        branchOutcome = "success";
        return { ok: true };
      }

      announceDisplayCompletion(result.item.id, "warning", sessionEpoch);
      return {
        ok: false,
        previewUnavailable: true,
        message: "展示图已生成，但预览暂时无法加载，请稍后刷新衣橱。",
      };
    } catch (error) {
      if (isAbortError(error) || !isActiveClosetItem(item.id, sessionEpoch)) {
        traceContext?.finishDisplayImageLoad("failure");
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }
      const message = error instanceof Error ? error.message : "展示图生成失败。";
      console.error(error);
      const authoritative = await readAuthoritativeClosetDisplayState(item, trace).catch(
        (reconciliationError) => {
          console.warn("[closet-display-image] state reconciliation failed", reconciliationError);
          return null;
        },
      );
      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        traceContext?.finishDisplayImageLoad("failure");
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }
      const fallbackPatch = {
        displayImagePath: item.displayImagePath,
        displayImageStatus: item.displayImageStatus,
        displayImageModel: item.displayImageModel,
        displayImagePromptVersion: item.displayImagePromptVersion,
        displayImageUrl: item.displayImageUrl,
        imageUrl: item.imageUrl,
      } satisfies ClosetDisplayPatch;
      const authoritativeStatus = authoritative?.status;
      const reconciledPatch = authoritative?.patch ?? fallbackPatch;

      setUserClosetItems((items) =>
        items.map((currentItem) =>
          currentItem.id === item.id
            ? applyClosetDisplayPatch(currentItem, reconciledPatch)
            : currentItem,
        ),
      );

      let reconciledImageOutcome: TimingOutcome | undefined;
      let shouldAnnounceReconciledOutcome = !traceContext;
      if (authoritative?.displayImageUrl) {
        traceContext?.beginDisplayImageLoad(authoritative.displayImageUrl);
        const resourceOutcome = await loadImageResource(authoritative.displayImageUrl);
        shouldAnnounceReconciledOutcome = traceContext
          ? traceContext.finishDisplayImageLoad(resourceOutcome)
          : true;
        reconciledImageOutcome = traceContext?.displayImageLoadOutcome ?? resourceOutcome;
      } else {
        shouldAnnounceReconciledOutcome = traceContext
          ? traceContext.finishDisplayImageLoad("failure")
          : true;
      }

      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }

      const readyImageChanged =
        authoritativeStatus === "ready" &&
        (item.displayImageStatus !== "ready" ||
          authoritative?.patch.displayImagePath !== item.displayImagePath);
      const reconciledSuccess = readyImageChanged && reconciledImageOutcome === "success";
      const reconciledWarning =
        !authoritative ||
        authoritativeStatus === "processing" ||
        (readyImageChanged && reconciledImageOutcome !== "success");
      if (reconciledSuccess) {
        if (shouldAnnounceReconciledOutcome) {
          announceDisplayCompletion(item.id, "success", sessionEpoch);
        }
        branchOutcome = "success";
      } else if (reconciledWarning) {
        if (authoritativeStatus === "ready") {
          setUserClosetItems((items) =>
            items.map((currentItem) =>
              currentItem.id === item.id
                ? applyClosetDisplayPatch(currentItem, {
                    displayImageUrl: undefined,
                    imageUrl:
                      currentItem.originalImageUrl ?? item.originalImageUrl ?? item.imageUrl,
                  })
                : currentItem,
            ),
          );
        }
        if (shouldAnnounceReconciledOutcome) {
          announceDisplayCompletion(item.id, "warning", sessionEpoch);
        }
      } else if (shouldAnnounceReconciledOutcome) {
        announceDisplayCompletion(item.id, "failure", sessionEpoch);
      }
      return reconciledSuccess
        ? { ok: true, reconciled: true }
        : reconciledWarning && authoritativeStatus === "ready"
          ? {
              ok: false,
              previewUnavailable: true,
              message: "展示图已生成，但预览暂时无法加载，请稍后刷新衣橱。",
            }
          : { ok: false, message };
    } finally {
      releaseClosetRequestController("display", item.id, requestController);
      branchSpan?.finish(branchOutcome);
      markItemBusy("display", item.id, false, sessionEpoch);
    }
  }

  async function readAuthoritativeClosetDisplayState(
    item: ClothingItem,
    trace?: TimingTrace,
  ) {
    const { data, error } = await measureWithTrace(
      trace,
      "display_reconcile_db",
      () =>
        supabase
          .from("closet_items")
          .select(
            "id,display_image_path,display_image_status,display_image_model,display_image_prompt_version",
          )
          .eq("id", item.id)
          .maybeSingle<ClosetDisplayImageRow>(),
      (result) => (result.error || !result.data ? "failure" : "success"),
    );
    if (error || !data) return null;

    let displayImageUrl: string | undefined;
    if (data.display_image_status === "ready" && data.display_image_path) {
      const { data: signedImage, error: signedImageError } = await measureWithTrace(
        trace,
        "display_reconcile_signed_url",
        () =>
          supabase.storage
            .from("closet-images")
            .createSignedUrl(data.display_image_path as string, 60 * 60),
        (result) => (result.error || !result.data?.signedUrl ? "failure" : "success"),
      );
      if (signedImageError) {
        console.warn(
          "[closet-display-image] reconciled signed URL unavailable",
          signedImageError.message,
        );
      }
      displayImageUrl = signedImage?.signedUrl;
    }

    const patch = {
      displayImagePath: data.display_image_path ?? undefined,
      displayImageStatus: data.display_image_status ?? "not_started",
      displayImageModel: data.display_image_model ?? undefined,
      displayImagePromptVersion: data.display_image_prompt_version ?? undefined,
      ...(data.display_image_status === "ready"
        ? {
            displayImageUrl,
            imageUrl: displayImageUrl ?? item.originalImageUrl ?? item.imageUrl,
          }
        : {}),
    } satisfies ClosetDisplayPatch;

    return {
      patch,
      status: patch.displayImageStatus,
      displayImageUrl,
    };
  }

  async function analyzeClosetItem(
    item: ClothingItem,
    originalImageDataUrl: string,
    options: {
      displayImageDataUrl?: string;
      fileName?: string;
      userFeedback?: string;
      intent?: "initial_upload" | "user_reanalysis";
    } = {},
    traceContext?: ClosetUploadTraceContext,
    expectedSessionEpoch = traceContext?.sessionEpoch ?? closetSessionEpochRef.current,
  ) {
    const trace = traceContext?.trace;
    const sessionEpoch = expectedSessionEpoch;

    if (!isActiveClosetItem(item.id, sessionEpoch)) {
      return { ok: false, cancelled: true, message: "任务已取消。" };
    }

    const branchSpan = trace?.startSpan("analysis_branch_total");
    const requestController = createClosetRequestController("analysis", item.id);
    let branchOutcome: TimingOutcome = "failure";
    markItemBusy("analysis", item.id, true, sessionEpoch);
    setUserClosetItems((items) =>
      items.map((currentItem) =>
        currentItem.id === item.id
          ? {
              ...currentItem,
              category: currentItem.category === "待识别" ? "识别中" : currentItem.category,
              styleTags: ["AI 识别中"],
              imageQualityFlags: mergeImageQualityFlags(
                currentItem.imageQualityFlags,
                ["closet_analysis_processing", "needs_ai_label_confirmation"],
                ["closet_analysis_queued", "closet_analysis_failed"],
              ),
            }
          : currentItem,
      ),
    );

    try {
      if (!item.imagePath) {
        throw new Error("原图路径缺失，无法识别衣服标签。");
      }

      const { data } = await measureWithTrace(
        trace,
        "analysis_auth_session",
        () => supabase.auth.getSession(),
        (result) => (result.data.session?.access_token ? "success" : "failure"),
      );
      const token = data.session?.access_token;
      if (!token) throw new Error("登录状态已过期，请重新登录。");
      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }

      const requestId = crypto.randomUUID();
      const requestBody = measureSyncWithTrace(trace, "analysis_request_serialize", () =>
        JSON.stringify({
          closetItemId: item.id,
          imagePath: item.imagePath,
          originalImageDataUrl,
          displayImageDataUrl: options.displayImageDataUrl,
          fileName: options.fileName ?? item.name,
          userFeedback: options.userFeedback,
          intent: options.intent ?? "initial_upload",
        }),
      );
      const response = await measureWithTrace(
        trace,
        "analysis_fetch_ttfb",
        () =>
          fetch("/api/ai/analyze-closet-item", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "X-Closet-Trace-Id": trace?.traceId ?? crypto.randomUUID(),
              "X-Request-Id": requestId,
            },
            body: requestBody,
            signal: requestController.signal,
          }),
        (result) => (result.ok ? "success" : "failure"),
      );

      if (traceContext) {
        traceContext.analysisRequestId = response.headers.get("x-request-id") ?? requestId;
        traceContext.analysisServerTiming = response.headers.get("server-timing") ?? undefined;
      }

      const result = await measureWithTrace(trace, "analysis_response_json", () =>
        response.json() as Promise<{
          item?: ClosetItemRow;
          message?: string;
          conflict?:
            | "analysis_already_in_progress"
            | "analysis_superseded_by_confirmation"
            | "analysis_state_changed";
        }>,
      );

      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }

      if (response.status === 409 && result.item) {
        if (result.conflict === "analysis_already_in_progress") {
          branchOutcome = "success";
          return {
            ok: false,
            conflict: true,
            message: "这件衣服已经在识别中，请等待当前识别完成。",
          };
        }

        const mappedItem = await mapClosetItemFromDb(
          supabase,
          result.item,
          trace ? { trace, prefix: "analysis_superseded_response" } : undefined,
        );
        if (!isActiveClosetItem(item.id, sessionEpoch)) {
          return { ok: false, cancelled: true, message: "任务已取消。" };
        }
        setUserClosetItems((items) =>
          items.map((currentItem) =>
            currentItem.id === mappedItem.id
              ? result.conflict === "analysis_state_changed" && !mappedItem.userCorrected
                ? options.intent === "user_reanalysis"
                  ? applyClosetReanalysisResult(currentItem, mappedItem)
                  : applyClosetAnalysisResult(currentItem, mappedItem)
                : applyClosetConfirmationResult(currentItem, mappedItem)
              : currentItem,
          ),
        );
        branchOutcome = "success";
        return {
          ok: false,
          superseded: true,
          message:
            result.conflict === "analysis_state_changed"
              ? "衣服识别状态已被更新，本次重复请求未覆盖最新结果。"
              : "用户确认已优先保留，本次识别结果未覆盖衣橱数据。",
        };
      }

      if (!response.ok || !result.item) {
        throw new Error(result.message ?? "衣服识别失败。");
      }

      const mappedItem = await mapClosetItemFromDb(
        supabase,
        result.item,
        trace ? { trace, prefix: "analysis_response" } : undefined,
      );
      if (!isActiveClosetItem(item.id, sessionEpoch)) {
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }
      setUserClosetItems((items) =>
        items.map((currentItem) =>
          currentItem.id === mappedItem.id
            ? options.intent === "user_reanalysis"
              ? applyClosetReanalysisResult(currentItem, mappedItem)
              : applyClosetAnalysisResult(currentItem, mappedItem)
            : currentItem,
        ),
      );
      branchOutcome = "success";
      return { ok: true };
    } catch (error) {
      if (isAbortError(error) || !isActiveClosetItem(item.id, sessionEpoch)) {
        return { ok: false, cancelled: true, message: "任务已取消。" };
      }
      const message = error instanceof Error ? error.message : "衣服识别失败。";
      console.error(error);
      setUserClosetItems((items) =>
        items.map((currentItem) =>
          currentItem.id !== item.id
            ? currentItem
            : options.intent === "user_reanalysis" && item.userCorrected
              ? applyClosetReanalysisResult(currentItem, item)
              : {
                  ...currentItem,
                  category: currentItem.category === "识别中" ? "待识别" : currentItem.category,
                  styleTags:
                    currentItem.styleTags[0] === "AI 识别中" ? ["待识别"] : currentItem.styleTags,
                  imageQualityFlags: mergeImageQualityFlags(
                    currentItem.imageQualityFlags,
                    ["closet_analysis_failed", "needs_ai_label_confirmation"],
                    ["closet_analysis_queued", "closet_analysis_processing"],
                  ),
                },
        ),
      );
      return { ok: false, message };
    } finally {
      releaseClosetRequestController("analysis", item.id, requestController);
      branchSpan?.finish(branchOutcome);
      markItemBusy("analysis", item.id, false, sessionEpoch);
    }
  }

  async function retryClosetDisplayImage(item: ClothingItem) {
    const sessionEpoch = closetSessionEpochRef.current;

    if (!isActiveClosetItem(item.id, sessionEpoch)) return;

    if (
      (busyItemCountsRef.current.display.get(item.id) ?? 0) > 0 ||
      item.displayImageStatus === "processing"
    ) {
      setClosetMessage(`「${item.name}」的展示图已经在生成中。`);
      return;
    }

    markItemBusy("display", item.id, true, sessionEpoch);

    try {
      if (!item.originalImageUrl) {
        throw new Error("原图暂不可用，无法重新生成展示图。");
      }

      setClosetMessage("正在重新生成展示图，原图仍会保留。");

      const imageDataUrl = await fetchImageAsDataUrl(item.originalImageUrl);
      if (!isActiveClosetItem(item.id, sessionEpoch)) return;
      const result = await generateClosetDisplayImage(
        item,
        imageDataUrl,
        undefined,
        sessionEpoch,
      );

      if ("cancelled" in result && result.cancelled) return;
      if (!isActiveClosetItem(item.id, sessionEpoch)) return;

      setClosetMessage(
        result.ok
          ? "展示图已重新生成。卡片默认会优先显示展示图，也可以切回原图。"
          : "previewUnavailable" in result && result.previewUnavailable
            ? result.message
            : `展示图重新生成失败：${result.message}`,
      );
    } catch (error) {
      console.error(error);
      if (isActiveClosetItem(item.id, sessionEpoch)) {
        setClosetMessage(error instanceof Error ? error.message : "展示图重新生成失败。");
      }
    } finally {
      markItemBusy("display", item.id, false, sessionEpoch);
    }
  }

  async function retryClosetAnalysis(item: ClothingItem, userFeedback?: string) {
    const sessionEpoch = closetSessionEpochRef.current;

    if (!isActiveClosetItem(item.id, sessionEpoch)) return;

    if (queuedAnalysisIdsRef.current.has(item.id) || activeAnalysisIdsRef.current.has(item.id)) {
      setClosetMessage(`「${item.name}」已经在识别队列中。`);
      return;
    }

    if (!item.originalImageUrl) {
      setClosetMessage("原图暂不可用，无法重新识别衣服标签。");
      return;
    }

    analysisQueueRef.current.push({ item, userFeedback, sessionEpoch });
    setAnalysisQueued(item.id, true, sessionEpoch);
    updateLocalItemFlags(
      item.id,
      ["closet_analysis_queued", "needs_ai_label_confirmation"],
      ["closet_analysis_failed", "closet_analysis_processing"],
      sessionEpoch,
    );
    setClosetMessage(`已将「${item.name}」加入重新识别队列。`);
    processAnalysisQueue();
  }

  async function runQueuedClosetAnalysis(
    item: ClothingItem,
    userFeedback: string | undefined,
    sessionEpoch: number,
  ) {
    if (!isActiveClosetItem(item.id, sessionEpoch)) return;

    try {
      if (!item.originalImageUrl) {
        throw new Error("原图暂不可用，无法重新识别衣服标签。");
      }

      setClosetMessage(
        userFeedback?.trim()
          ? `正在按你的反馈重新识别「${item.name}」。`
          : `正在重新识别「${item.name}」，原图会作为主要事实来源。`,
      );

      const originalImageDataUrl = await fetchImageAsDataUrl(item.originalImageUrl);
      if (!isActiveClosetItem(item.id, sessionEpoch)) return;
      let displayImageDataUrl: string | undefined;

      if (item.displayImageUrl) {
        try {
          displayImageDataUrl = await fetchImageAsDataUrl(item.displayImageUrl);
        } catch {
          displayImageDataUrl = undefined;
        }
      }

      if (!isActiveClosetItem(item.id, sessionEpoch)) return;

      const result = await analyzeClosetItem(item, originalImageDataUrl, {
        displayImageDataUrl,
        fileName: item.name,
        userFeedback,
        intent: "user_reanalysis",
      }, undefined, sessionEpoch);

      if (!isActiveClosetItem(item.id, sessionEpoch)) return;

      if ("cancelled" in result && result.cancelled) return;

      setClosetMessage(
        result.ok
          ? "衣服标签已重新识别。请在后续确认流程中检查并修正细节。"
          : "conflict" in result && result.conflict
            ? result.message
            : `衣服标签重新识别失败：${result.message}`,
      );
    } catch (error) {
      console.error(error);
      if (isActiveClosetItem(item.id, sessionEpoch)) {
        setClosetMessage(error instanceof Error ? error.message : "衣服标签重新识别失败。");
      }
    }
  }

  async function deleteClosetItem(item: ClothingItem) {
    if ((busyItemCountsRef.current.deletion.get(item.id) ?? 0) > 0) return;
    const confirmed = window.confirm(`确定删除「${item.name}」吗？原图和展示图也会尽量一起清理。`);
    if (!confirmed) return;
    const sessionEpoch = closetSessionEpochRef.current;
    const originalIndex = userClosetItems.findIndex((currentItem) => currentItem.id === item.id);

    markItemBusy("deletion", item.id, true, sessionEpoch);
    deletedClosetItemIdsRef.current.add(item.id);
    analysisQueueRef.current = analysisQueueRef.current.filter(
      (task) => task.item.id !== item.id,
    );
    setAnalysisQueued(item.id, false, sessionEpoch);
    abortClosetItemRequests(item.id);
    const traceContext = closetUploadTracesRef.current.get(item.id);
    if (traceContext) {
      traceContext.analysisSucceeded = false;
      traceContext.displaySucceeded = false;
      traceContext.finishDisplayImageLoad("failure");
      void finalizeClosetUploadTrace(traceContext).finally(() => {
        activeClosetUploadTracesRef.current.delete(traceContext);
        closetUploadTracesRef.current.delete(item.id);
      });
    }
    setDisplayCompletionNotices((current) =>
      current.filter((notice) => notice.itemId !== item.id),
    );
    setUserClosetItems((items) => items.filter((currentItem) => currentItem.id !== item.id));
    setClosetMessage("");

    try {
      const { data: deletedItem, error } = await supabase
        .from("closet_items")
        .delete()
        .eq("id", item.id)
        .select("image_path,processed_image_path,display_image_path")
        .maybeSingle<{
          image_path: string | null;
          processed_image_path: string | null;
          display_image_path: string | null;
        }>();
      if (error) throw error;

      const paths = collectClosetStorageCleanupPaths(
        item,
        {
          imagePath: deletedItem?.image_path,
          processedImagePath: deletedItem?.processed_image_path,
          displayImagePath: deletedItem?.display_image_path,
        },
      );

      if (paths.length) {
        const { error: removeError } = await supabase.storage.from("closet-images").remove(paths);
        if (removeError) {
          console.warn("[closet-delete] storage cleanup failed", removeError.message);
        }
      }

      if (isCurrentClosetSession(sessionEpoch)) {
        setClosetMessage(`已删除「${item.name}」。`);
      }
    } catch (error) {
      console.error(error);
      if (isCurrentClosetSession(sessionEpoch)) {
        deletedClosetItemIdsRef.current.delete(item.id);
        setUserClosetItems((items) => restoreClosetItemAtIndex(items, item, originalIndex));
        setClosetMessage(error instanceof Error ? error.message : "删除失败，请稍后再试。");
      }
    } finally {
      markItemBusy("deletion", item.id, false, sessionEpoch);
    }
  }

  async function confirmClosetItemOnServer(
    item: ClothingItem,
    draft: ClosetConfirmationDraft,
    sessionEpoch: number,
  ) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("登录状态已过期，请重新登录。");
    if (!isCurrentClosetSession(sessionEpoch)) throw new Error("登录会话已切换。");

    const response = await fetch("/api/ai/confirm-closet-item", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        closetItemId: item.id,
        draft,
      }),
    });

    const result = (await response.json()) as {
      item?: ClosetItemRow;
      message?: string;
    };

    if (!response.ok || !result.item) {
      throw new Error(result.message ?? "确认保存失败，请稍后再试。");
    }
    if (!isCurrentClosetSession(sessionEpoch)) throw new Error("登录会话已切换。");

    return mapClosetItemFromDb(supabase, result.item);
  }

  async function confirmClosetItem(item: ClothingItem, draft: ClosetConfirmationDraft) {
    const sessionEpoch = closetSessionEpochRef.current;
    markItemBusy("confirmation", item.id, true, sessionEpoch);
    setClosetMessage("");

    try {
      const mappedItem = await confirmClosetItemOnServer(item, draft, sessionEpoch);
      if (!isCurrentClosetSession(sessionEpoch)) return;
      setUserClosetItems((items) =>
        items.map((currentItem) =>
          currentItem.id === mappedItem.id
            ? applyClosetConfirmationResult(currentItem, mappedItem)
            : currentItem,
        ),
      );
      setClosetMessage(`已确认「${mappedItem.name}」的衣橱标签，并写入搭配检索向量。`);
    } catch (error) {
      console.error(error);
      if (isCurrentClosetSession(sessionEpoch)) {
        setClosetMessage(error instanceof Error ? error.message : "确认保存失败，请稍后再试。");
      }
    } finally {
      markItemBusy("confirmation", item.id, false, sessionEpoch);
    }
  }

  async function confirmHighConfidenceClosetItems(items: ClothingItem[]) {
    const sessionEpoch = closetSessionEpochRef.current;
    const targetItems = items.filter((item) => {
      const confidence = item.aiConfidence ?? 0;
      return confidence >= 0.8 && !(item.imageQualityFlags ?? []).includes("closet_analysis_failed");
    });

    if (!targetItems.length) {
      setClosetMessage("暂无可批量确认的高置信度衣服，请先逐件检查。");
      return;
    }

    targetItems.forEach((item) =>
      markItemBusy("confirmation", item.id, true, sessionEpoch),
    );
    setClosetMessage("");

    try {
      const updatedItems = await Promise.all(
        targetItems.map(async (item) => {
          const draft = createConfirmationDraft(item);
          return confirmClosetItemOnServer(item, draft, sessionEpoch);
        }),
      );
      if (!isCurrentClosetSession(sessionEpoch)) return;

      const updatedById = new Map(updatedItems.map((item) => [item.id, item]));
      setUserClosetItems((items) =>
        items.map((item) => {
          const updatedItem = updatedById.get(item.id);
          return updatedItem ? applyClosetConfirmationResult(item, updatedItem) : item;
        }),
      );
      setClosetMessage(`已批量确认 ${updatedItems.length} 件高置信度衣服，并写入搭配检索向量。`);
    } catch (error) {
      console.error(error);
      if (isCurrentClosetSession(sessionEpoch)) {
        setClosetMessage(error instanceof Error ? error.message : "批量确认失败，请稍后再试。");
      }
    } finally {
      targetItems.forEach((item) =>
        markItemBusy("confirmation", item.id, false, sessionEpoch),
      );
    }
  }

  async function startNewChat() {
    resetActiveChatState();
    setView("chat");
  }

  async function handleDecisionRunCreated(run: DecisionRun) {
    setDecisionRunsBySessionId((current) => mergeDecisionRun(current, run));
    if (activeChatIdRef.current === run.sessionId) {
      setChatState((current) => ({
        ...current,
        message: "",
        decisionRunId: run.id,
        error: "",
        notice: "",
      }));
    }
    if (user) await loadChatSessions(user.id);
  }

  function applyChatStateForSession(
    sessionId: string,
    patch: Partial<DecisionChatState>,
  ) {
    if (activeChatIdRef.current !== sessionId) return;
    setChatState((current) => ({ ...current, ...patch }));
  }

  async function ensureChatSession(title: string) {
    if (activeChatIdRef.current) return activeChatIdRef.current;
    if (!user) throw new Error("登录状态已过期，请重新登录。");
    const navigationEpoch = chatNavigationEpochRef.current;

    const { data, error } = await supabase
      .from("chat_sessions")
      .insert({
        user_id: user.id,
        title,
        status: "active",
      })
      .select("id,title,status,created_at,updated_at")
      .single();

    if (error) throw error;
    const session = data as ChatSessionRow;
    if (
      chatNavigationEpochRef.current === navigationEpoch &&
      activeChatIdRef.current === undefined
    ) {
      activeChatIdRef.current = session.id;
      setActiveChatId(session.id);
    }
    await loadChatSessions(user.id);
    return session.id;
  }

  async function saveImageRequiredTurn({
    sessionId,
    userMessage,
    assistantMessage,
  }: {
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
  }) {
    if (!user) throw new Error("登录状态已过期，请重新登录。");

    const { error: messageError } = await supabase.from("chat_messages").insert([
      {
        session_id: sessionId,
        user_id: user.id,
        role: "user",
        content: userMessage,
        image_path: null,
        candidate_id: null,
        report_id: null,
        metadata: {},
      },
      {
        session_id: sessionId,
        user_id: user.id,
        role: "assistant",
        content: assistantMessage,
        image_path: null,
        candidate_id: null,
        report_id: null,
        metadata: {
          responseMode: "image_required",
        },
      },
    ]);

    if (messageError) throw messageError;

    const { error: sessionError } = await supabase
      .from("chat_sessions")
      .update({
        last_candidate_id: null,
        last_report_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);

    if (sessionError) throw sessionError;
    await loadChatSessions(user.id);
  }

  async function openChatSession(
    sessionId: string,
    options: { navigate?: boolean } = {},
  ) {
    if (!user) return;
    const navigate = options.navigate ?? true;
    const requestId = chatHydrationRequestRef.current + 1;
    chatHydrationRequestRef.current = requestId;

    if (navigate) {
      chatNavigationEpochRef.current += 1;
      hydratedDecisionRunFingerprintRef.current = null;
      activeChatIdRef.current = sessionId;
      setActiveChatId(sessionId);
      setChatState(createEmptyChatState());
      setView("chat");
    } else if (activeChatIdRef.current !== sessionId) {
      return;
    }

    const [{ data, error }, { data: runData, error: runError }] = await Promise.all([
      supabase
        .from("chat_messages")
        .select(
          "id,session_id,role,content,image_path,candidate_id,report_id,decision_run_id,metadata,created_at",
        )
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true }),
      supabase
        .from("decision_runs")
        .select("*")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (
      requestId !== chatHydrationRequestRef.current ||
      activeChatIdRef.current !== sessionId
    ) {
      return;
    }

    if (error) {
      console.error(error);
      setChatState((current) => ({
        ...current,
        error: "聊天记录读取失败，请稍后再试。",
      }));
      return;
    }

    if (runError) console.error(runError);
    const persistedRun = runData ? mapDecisionRunRow(runData as DecisionRunRow) : undefined;
    if (persistedRun) {
      setDecisionRunsBySessionId((current) => mergeDecisionRun(current, persistedRun));
    }

    const messages = (data ?? []) as ChatMessageRow[];
    const latestMessage = messages.at(-1);
    const persistedRunIsLatestTurn = Boolean(
      persistedRun &&
        (!latestMessage ||
          latestMessage.decision_run_id === persistedRun.id ||
          new Date(persistedRun.createdAt).getTime() >=
            new Date(latestMessage.created_at).getTime()),
    );
    const visibleMessages = persistedRunIsLatestTurn
      ? messages.filter((message) => message.decision_run_id === persistedRun?.id)
      : messages.filter((message) => !message.decision_run_id);
    const latestUserMessage = [...visibleMessages]
      .reverse()
      .find((message) => message.role === "user");
    const latestAssistantMessage = [...visibleMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    const visibleRun = persistedRunIsLatestTurn ? persistedRun : undefined;
    const restoredReport = latestAssistantMessage?.metadata?.report as
      | PurchaseDecisionReport
      | undefined;
    const restoredResponseMode = latestAssistantMessage?.metadata?.responseMode;
    const signedImageUrl = await createStorageSignedUrl(
      supabase,
      "purchase-screenshots",
      latestUserMessage?.image_path,
    );

    const hydratedReport = hydrateReportForDisplay(
      restoredReport,
      userClosetItems,
      signedImageUrl,
    );
    const restoredCandidateId =
      latestAssistantMessage?.candidate_id ??
      latestUserMessage?.candidate_id ??
      visibleRun?.candidateId ??
      undefined;
    const restoredReportId =
      latestAssistantMessage?.report_id ??
      latestUserMessage?.report_id ??
      visibleRun?.reportId ??
      undefined;
    const savedDecisionResult = await (
      restoredCandidateId
        ? supabase
            .from("decision_items")
            .select("status")
            .eq("user_id", user.id)
            .eq("candidate_id", restoredCandidateId)
            .maybeSingle()
        : Promise.resolve({ data: null })
    );
    const savedDecisionStatus = savedDecisionResult.data?.status as DecisionStatus | undefined;
    const restoredElapsedSeconds = readDecisionElapsedSeconds(
      latestAssistantMessage?.metadata?.decisionElapsedSeconds,
    ) ?? getDecisionRunElapsedSeconds(visibleRun);

    if (
      requestId !== chatHydrationRequestRef.current ||
      activeChatIdRef.current !== sessionId
    ) {
      return;
    }

    setChatState({
      message: "",
      lastUserMessage: latestUserMessage?.content ?? "",
      assistantMessage:
        restoredResponseMode === "image_required"
          ? (latestAssistantMessage?.content ?? undefined)
          : undefined,
      purchaseImageDataUrl: signedImageUrl,
      purchaseImageName: latestUserMessage?.metadata?.imageName as string | undefined,
      assessment: hydratedReport ?? null,
      decisionElapsedSeconds: hydratedReport ? restoredElapsedSeconds : undefined,
      selectedDecisionStatus: hydratedReport ? savedDecisionStatus : undefined,
      candidateId: restoredCandidateId,
      reportId: restoredReportId,
      decisionRunId:
        latestAssistantMessage?.decision_run_id ??
        latestUserMessage?.decision_run_id ??
        visibleRun?.id,
      error:
        visibleRun?.status === "failed"
          ? (visibleRun.errorMessage ?? "这次决策没有完成，请稍后重试。")
          : visibleRun?.status === "cancelled"
            ? "这次决策已取消。"
            : "",
      notice: "",
    });
  }

  async function deleteChatSession(sessionId: string) {
    if (!user) return;

    try {
      await archiveChatSessionOnServer(sessionId);
    } catch (currentError) {
      if (activeChatIdRef.current === sessionId) {
        setChatState((current) => ({
          ...current,
          error:
            currentError instanceof Error
              ? currentError.message
              : "删除对话失败，请稍后再试。",
          notice: "",
        }));
      }
      return;
    }

    setChatSessions((sessions) => sessions.filter((session) => session.id !== sessionId));
    setDecisionItems((items) => items.filter((item) => item.sessionId !== sessionId));
    setDecisionRunsBySessionId((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    if (activeChatId === sessionId) {
      resetActiveChatState();
    }
  }

  async function archiveChatSessionOnServer(sessionId: string) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("登录状态已过期，请重新登录。");

    const response = await fetch("/api/chat-sessions/archive", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(result?.message ?? "删除对话失败，请稍后再试。");
    }
  }

  async function saveCurrentDecision(status: DecisionStatus) {
    if (!user || !chatState.assessment) return;
    const candidateId = chatState.candidateId;

    if (!candidateId) {
      setChatState((current) => ({
        ...current,
        error: "这次决策还没有可保存的商品记录，请上传商品截图后再加入决策清单。",
        notice: "",
      }));
      return;
    }

    const reminderAt =
      status === "saved_for_later" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;
    const report = chatState.assessment;
    const { error } = await supabase.from("decision_items").upsert(
      {
        user_id: user.id,
        candidate_id: candidateId,
        report_id: chatState.reportId ?? null,
        session_id: activeChatId ?? null,
        status,
        snapshot_summary: report.summary,
        snapshot_outfit_tips: report.outfitCombinations
          .map((item) => `${item.title}：${item.summary}`)
          .slice(0, 4),
        snapshot_risks: report.risks,
        reminder_at: reminderAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,candidate_id" },
    );

    if (error) {
      setChatState((current) => ({
        ...current,
        error: error.message,
        notice: "",
      }));
      return;
    }

    await loadDecisionItems(user.id);
    setChatState((current) => ({
      ...current,
      selectedDecisionStatus: status,
      error: "",
      notice: "",
    }));
  }

  async function updateDecisionStatus(id: string, status: DecisionStatus) {
    const reminderAt =
      status === "saved_for_later" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null;

    setDecisionItems((items) =>
      status === "not_considering"
        ? items.filter((item) => item.id !== id)
        : items.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status,
                  reminderAt: reminderAt ? formatReminderLabel(reminderAt) : undefined,
                }
              : item,
          ),
    );

    if (!user) return;

    const { error } = await supabase
      .from("decision_items")
      .update({
        status,
        reminder_at: reminderAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      console.error(error);
      await loadDecisionItems(user.id);
    }
  }

  async function deleteDecisionItemsWithChats(ids: string[]) {
    if (!user || !ids.length) return;

    const targetItems = decisionItems.filter((item) => ids.includes(item.id));
    const sessionIds = Array.from(
      new Set(targetItems.map((item) => item.sessionId).filter((id): id is string => Boolean(id))),
    );
    const targetIdSet = new Set(ids);
    const sessionIdSet = new Set(sessionIds);

    try {
      await Promise.all(sessionIds.map((sessionId) => archiveChatSessionOnServer(sessionId)));
    } catch (currentError) {
      if (activeChatIdRef.current && sessionIdSet.has(activeChatIdRef.current)) {
        setChatState((current) => ({
          ...current,
          error:
            currentError instanceof Error
              ? currentError.message
              : "删除关联对话失败，请稍后再试。",
          notice: "",
        }));
      }
      await Promise.allSettled([
        loadChatSessions(user.id),
        loadDecisionItems(user.id),
      ]);
      return;
    }

    setDecisionItems((items) =>
      items.filter((item) => !targetIdSet.has(item.id) && !(item.sessionId && sessionIdSet.has(item.sessionId))),
    );
    if (sessionIds.length) {
      setChatSessions((sessions) => sessions.filter((session) => !sessionIdSet.has(session.id)));
      setDecisionRunsBySessionId((current) => {
        const next = { ...current };
        sessionIds.forEach((sessionId) => delete next[sessionId]);
        return next;
      });
    }
    if (activeChatId && sessionIdSet.has(activeChatId)) {
      resetActiveChatState();
    }

    const errors: string[] = [];

    const { error: selectedDeleteError } = await supabase
      .from("decision_items")
      .delete()
      .in("id", ids)
      .eq("user_id", user.id);
    if (selectedDeleteError) errors.push(selectedDeleteError.message);

    if (errors.length) {
      if (activeChatIdRef.current && sessionIdSet.has(activeChatIdRef.current)) {
        setChatState((current) => ({
          ...current,
          error: `删除清单失败：${errors[0]}`,
          notice: "",
        }));
      }
      await loadDecisionItems(user.id);
      await loadChatSessions(user.id);
    }
  }

  async function updateDecisionDetails(
    id: string,
    patch: Partial<{ price: number | null; color: string; size: string }>,
  ) {
    const currentItem = decisionItems.find((item) => item.id === id);
    if (!currentItem) return;

    const nextColor = patch.color !== undefined ? patch.color.trim() || "待确认" : undefined;
    const nextSize = patch.size !== undefined ? patch.size.trim() || "待确认" : undefined;
    const nextPrice = patch.price !== undefined ? patch.price : undefined;

    setDecisionItems((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              ...(nextPrice !== undefined
                ? { price: nextPrice ?? 0, priceKnown: nextPrice !== null }
                : {}),
              ...(nextColor !== undefined ? { color: nextColor, palette: getPaletteByColor(nextColor) } : {}),
              ...(nextSize !== undefined ? { size: nextSize } : {}),
            }
          : item,
      ),
    );

    if (!user) return;

    const now = new Date().toISOString();
    const errors: unknown[] = [];

    const candidateUpdates: Record<string, unknown> = {};
    if (nextPrice !== undefined) candidateUpdates.estimated_price = nextPrice;
    if (nextColor !== undefined) candidateUpdates.color = nextColor;

    if (Object.keys(candidateUpdates).length && currentItem.candidateId) {
      const { error } = await supabase
        .from("purchase_candidates")
        .update({ ...candidateUpdates, updated_at: now })
        .eq("id", currentItem.candidateId)
        .eq("user_id", user.id);
      if (error) errors.push(error);
    }

    if (nextSize !== undefined) {
      const { error } = await supabase
        .from("decision_items")
        .update({ size_label: nextSize, updated_at: now })
        .eq("id", id)
        .eq("user_id", user.id);
      if (error) errors.push(error);
    }

    if (errors.length) {
      console.error(errors);
      await loadDecisionItems(user.id);
    }
  }

  async function openDecisionReport(item: DecisionItem) {
    if (item.sessionId) {
      await openChatSession(item.sessionId);
      return;
    }

    setView("chat");
    setChatState((current) => ({
      ...current,
      notice: "",
      error: "这条决策记录暂时没有绑定原始对话，无法打开完整分析。",
    }));
  }

  if (authLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <AuthView />;
  }

  const activeView = profile && isProfileIncomplete(profile) ? "settings" : view;

  return (
    <main className="easy-buy-app min-h-screen bg-[#f6f0eb] p-0 text-stone-800 sm:p-3 lg:p-4">
      {displayCompletionSummary && (
        <ClosetDisplayCompletionToast
          summary={displayCompletionSummary}
          onClose={() => setDisplayCompletionNotices([])}
          onViewCloset={() => {
            setView("closet");
            setDisplayCompletionNotices([]);
          }}
        />
      )}
      <div className="app-layout mx-auto flex max-w-[1600px] flex-col gap-0 lg:flex-row lg:gap-4">
        <Sidebar
          currentView={activeView}
          user={user}
          counts={{
            chats: chatSessions.length,
            closet: userClosetItems.length,
            decisions: decisionItems.length,
          }}
          chats={chatSessions}
          onViewChange={setView}
          onNewChat={() => void startNewChat()}
          onOpenChat={(sessionId) => void openChatSession(sessionId)}
          onDeleteChat={(sessionId) => void deleteChatSession(sessionId)}
        />
        <MobileNavigation
          currentView={activeView}
          counts={{
            chats: chatSessions.length,
            closet: userClosetItems.length,
            decisions: decisionItems.length,
          }}
          onViewChange={setView}
          onNewChat={() => void startNewChat()}
        />
        <section className="app-view flex min-h-0 min-w-0 flex-1 overflow-hidden border border-[#ead9d0] bg-[#fffdfb] sm:rounded-[18px]">
          {activeView === "chat" && (
            <ChatView
              profile={profile ?? createEmptyProfile(user.id)}
              chatState={chatState}
              activeChatId={activeChatId}
              activeDecisionRun={activeDecisionRun}
              onChatStateChange={setChatState}
              onEnsureChatSession={ensureChatSession}
              onRunCreated={handleDecisionRunCreated}
              onApplySessionPatch={applyChatStateForSession}
              onSaveImageRequiredTurn={saveImageRequiredTurn}
              onOpenDecisions={() => setView("decisions")}
              onDecision={saveCurrentDecision}
            />
          )}
          {activeView === "closet" && (
            <ClosetView
              items={userClosetItems}
              isLoading={closetLoading}
              isUploadBusy={closetUploadBusy}
              message={closetMessage}
              busyItemIds={busyClosetItemIds}
              queuedAnalysisItemIds={queuedAnalysisItemIds}
              onUploadImages={uploadClosetImages}
              onConfirmItem={confirmClosetItem}
              onConfirmHighConfidence={confirmHighConfidenceClosetItems}
              onRetryDisplayImage={retryClosetDisplayImage}
              onRetryAnalysis={retryClosetAnalysis}
              onDeleteItem={deleteClosetItem}
              onImageLoad={recordClosetImageLoad}
            />
          )}
          {activeView === "decisions" && (
            <DecisionListView
              filter={filter}
              items={filteredDecisions}
              allItems={decisionItems}
              onFilterChange={setFilter}
              onStatusChange={updateDecisionStatus}
              onDetailsChange={(id, patch) => void updateDecisionDetails(id, patch)}
              onOpenReport={(item) => void openDecisionReport(item)}
              onDeleteItems={(ids) => deleteDecisionItemsWithChats(ids)}
            />
          )}
          {activeView === "settings" && (
            <SettingsView
              key={profile?.id ?? user.id}
              profile={profile ?? createEmptyProfile(user.id)}
              user={user}
              onSaveProfile={saveProfile}
              onSignOut={signOut}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function ClosetDisplayCompletionToast({
  summary,
  onClose,
  onViewCloset,
}: {
  summary: DisplayCompletionNoticeSummary;
  onClose: () => void;
  onViewCloset: () => void;
}) {
  const isFailure = summary.outcome === "failure";
  const isWarning = summary.outcome === "warning" || summary.outcome === "mixed";
  const StatusIcon = isFailure ? XCircle : isWarning ? Info : CheckCircle2;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        "fixed right-4 top-4 z-[60] w-[min(24rem,calc(100vw-2rem))] rounded-[12px] border bg-white p-4 shadow-[0_18px_48px_rgba(45,43,50,0.18)]",
        isFailure
          ? "border-[#e8b8b2]"
          : isWarning
            ? "border-[#dccb9d]"
            : "border-[#c9d4cb]",
      )}
    >
      <div className="flex items-start gap-3 pr-8">
        <span
          className={cn(
            "mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full",
            isFailure
              ? "bg-[#f2e5e3] text-[#9a514f]"
              : isWarning
                ? "bg-[#f5efdf] text-[#795d39]"
                : "bg-[#edf0ed] text-[#617066]",
          )}
          aria-hidden="true"
        >
          <StatusIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-6 text-[#3d281f]">{summary.message}</p>
          <button
            type="button"
            onClick={onViewCloset}
            className="mt-2 inline-flex h-8 items-center gap-1 text-sm font-medium text-[#b2605e] transition hover:text-[#8d3f3f]"
          >
            查看衣橱
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭展示图通知"
        title="关闭通知"
        className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-full text-[#a08278] transition hover:bg-[#fbf0ec] hover:text-[#8d3f3f]"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="easy-buy-app flex min-h-screen items-center justify-center bg-[#f6f0eb] px-5 text-[#6e5148]">
      <div className="flex items-center gap-4 rounded-[16px] border border-[#ead9d0] bg-[#fffdfb] px-7 py-5 shadow-[0_18px_42px_rgba(45,43,50,0.08)]">
        <div className="flex size-10 items-center justify-center rounded-[11px] bg-[#76576f] text-white">
          <Shirt className="size-5" />
        </div>
        <div>
          <p className="font-semibold text-[#3d281f]">买对衣</p>
          <p className="mt-1 text-sm">正在整理你的长期衣橱...</p>
        </div>
      </div>
    </main>
  );
}

function AuthView() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  async function handleSubmit() {
    setIsSubmitting(true);
    setMessage("");

    const action =
      mode === "login"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { data, error } = await action;

    if (error) {
      setMessage(error.message);
    } else if (mode === "signup" && !data.session) {
      setMessage("注册成功，请先到邮箱完成验证后再登录。");
    } else {
      setMessage("登录成功，正在进入...");
    }

    setIsSubmitting(false);
  }

  return (
    <main className="easy-buy-app min-h-screen bg-[#f6f0eb] p-0 text-stone-800 sm:p-4">
      <div className="mx-auto grid min-h-screen max-w-6xl overflow-hidden border border-[#ead9d0] bg-[#fffdfb] shadow-[0_18px_42px_rgba(45,43,50,0.08)] sm:min-h-[calc(100vh-2rem)] sm:rounded-[22px] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="flex flex-col justify-between border-b border-[#ead9d0] bg-[#eee9e1] p-8 sm:p-10 lg:border-b-0 lg:border-r">
          <div>
            <div className="flex size-14 items-center justify-center rounded-[15px] bg-[#76576f] text-white shadow-[0_12px_28px_rgba(45,43,50,0.12)]">
              <Shirt className="size-7" />
            </div>
            <p className="mt-8 text-sm font-semibold tracking-[0.18em] text-[#76576f]">
              理性决策 · 长期主义
            </p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-[-0.04em] text-[#3d281f] sm:text-5xl">
              买一件，穿很多次。
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-[#7b5b51]">
              结合真实衣橱、使用场景与长期维护成本，帮你判断一件衣服是否值得现在买。
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {["降低冲动消费", "提高衣橱利用率", "沉淀个人风格"].map((item) => (
              <div key={item} className="rounded-[14px] border border-[#d7cfd1] bg-[#faf8f4]/70 p-4 text-[#6e5148]">
                <CheckCircle2 className="mb-3 size-5 text-[#76576f]" />
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="flex items-center justify-center p-8">
          <form
            className="w-full max-w-md"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <p className="text-sm font-semibold tracking-[0.14em] text-[#76576f]">欢迎回来</p>
            <h2 className="mt-3 text-3xl font-semibold text-[#3d281f]">
              {mode === "login" ? "登录账号" : "创建账号"}
            </h2>
            <p className="mt-2 text-[#8b6258]">
              登录后你的衣橱、对话和决策清单会按用户隔离保存。
            </p>

            <div className="mt-8 space-y-4">
              <AuthInput
                label="邮箱"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@example.com"
              />
              <AuthInput
                label="密码"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="至少 6 位"
              />
            </div>

            {message && (
              <div className="mt-5 rounded-[12px] border border-[#ead9d0] bg-[#fbf5f1] px-4 py-3 text-sm text-[#7b5b51]">
                {message}
              </div>
            )}

            <button
              disabled={isSubmitting}
              className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-[11px] bg-[#76576f] font-medium text-white shadow-[0_10px_24px_rgba(45,43,50,0.12)] transition hover:bg-[#62465c] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "处理中..." : mode === "login" ? "登录" : "注册"}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode((currentMode) => (currentMode === "login" ? "signup" : "login"));
                setMessage("");
              }}
              className="mt-4 w-full text-sm text-[#76576f]"
            >
              {mode === "login" ? "还没有账号？去注册" : "已有账号？去登录"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

function AuthInput({
  label,
  type,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  type: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm text-[#8b6258]">{label}</span>
      <input
        required
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-12 w-full rounded-[10px] border border-[#ead9d0] bg-white px-4 text-[#3d281f] outline-none transition focus:border-[#d58b82]"
      />
    </label>
  );
}

function MobileNavigation({
  currentView,
  counts,
  onViewChange,
  onNewChat,
}: {
  currentView: AppView;
  counts: {
    chats: number;
    closet: number;
    decisions: number;
  };
  onViewChange: (view: AppView) => void;
  onNewChat: () => void;
}) {
  const navItems = [
    { id: "chat" as const, label: "决策", count: counts.chats, icon: MessageCircle },
    { id: "closet" as const, label: "衣橱", count: counts.closet, icon: Shirt },
    { id: "decisions" as const, label: "清单", count: counts.decisions, icon: ClipboardList },
    { id: "settings" as const, label: "设置", icon: Settings },
  ];

  return (
    <div className="mobile-navigation lg:hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-[#76576f] text-white">
            <Shirt className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-[#3d281f]">买对衣</p>
            <p className="truncate text-xs text-[#9a7468]">认真买，长久穿</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onNewChat}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[10px] bg-[#76576f] px-4 text-sm font-medium text-white"
        >
          <Sparkles className="size-4" />
          新决策
        </button>
      </div>
      <nav className="grid grid-cols-4 border-t border-[#ead9d0] px-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onViewChange(item.id)}
              className={cn(
                "relative flex h-14 flex-col items-center justify-center gap-1 rounded-[10px] text-[11px] transition",
                active ? "text-[#76576f]" : "text-[#77706b]",
              )}
            >
              <Icon className="size-[18px]" />
              <span>{item.label}</span>
              {typeof item.count === "number" && item.count > 0 && (
                <span className="absolute right-[22%] top-1.5 min-w-4 rounded-full bg-[#e6dde3] px-1 text-[9px] leading-4 text-[#76576f]">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function Sidebar({
  currentView,
  user,
  counts,
  chats,
  onViewChange,
  onNewChat,
  onOpenChat,
  onDeleteChat,
}: {
  currentView: AppView;
  user: User;
  counts: {
    chats: number;
    closet: number;
    decisions: number;
  };
  chats: ChatSession[];
  onViewChange: (view: AppView) => void;
  onNewChat: () => void;
  onOpenChat: (sessionId: string) => void;
  onDeleteChat: (sessionId: string) => void;
}) {
  const navItems = [
    { id: "chat" as const, label: "决策聊天", count: counts.chats, icon: MessageCircle },
    { id: "closet" as const, label: "衣橱", count: counts.closet, icon: Shirt },
    { id: "decisions" as const, label: "决策清单", count: counts.decisions, icon: ClipboardList },
    { id: "settings" as const, label: "设置", icon: Settings },
  ];

  return (
    <aside className="desktop-sidebar hidden w-[268px] shrink-0 flex-col rounded-[18px] border border-[#ead9d0] bg-[#fffdfb]/92 p-5 lg:flex">
      <div className="flex items-center gap-3 px-1">
        <div className="flex size-12 items-center justify-center rounded-[13px] bg-[#76576f] text-white shadow-[0_10px_24px_rgba(45,43,50,0.12)]">
          <Shirt className="size-6" />
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.02em] text-[#3d281f]">买对衣</h1>
          <p className="mt-1 text-xs text-[#9a7468]">认真买，长久穿</p>
        </div>
      </div>

      <button
        onClick={onNewChat}
        className="mt-6 flex h-12 items-center justify-center gap-2 rounded-[12px] bg-[#76576f] text-sm font-medium text-white shadow-[0_10px_24px_rgba(45,43,50,0.10)] transition hover:bg-[#62465c]"
      >
        <Sparkles className="size-4" />
        新建决策对话
      </button>

      <nav className="mt-6 space-y-1.5">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "flex h-12 w-full items-center gap-3 rounded-[10px] px-3 text-left text-sm transition",
                active
                  ? "bg-[#f4e8e3] font-medium text-[#a9514f]"
                  : "text-[#6e5148] hover:bg-[#f8efea]",
              )}
            >
              <Icon className="size-5" />
              <span className="flex-1">{item.label}</span>
              {typeof item.count === "number" && (
                <span className="rounded-full bg-[#f4e8e3] px-2.5 py-1 text-xs text-[#b2605e]">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-6 min-h-0 flex-1 border-t border-[#ead9d0] pt-5">
        <p className="mb-3 px-1 text-xs font-medium tracking-[0.08em] text-[#a08278]">最近对话</p>
        <div className="view-scroll max-h-[calc(100vh-500px)] space-y-2 overflow-y-auto pr-1">
          {chats.length ? (
            chats.map((chat) => (
              <div
                key={chat.id}
                className="group flex w-full items-center gap-1 rounded-[10px] p-1.5 text-left transition hover:bg-[#f8efea]"
              >
                <button
                  type="button"
                  onClick={() => onOpenChat(chat.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  {chat.thumbnailUrl ? (
                    <div
                      className="size-11 shrink-0 rounded-[9px] bg-[#f8f3ef] bg-cover bg-center"
                      style={{ backgroundImage: `url(${chat.thumbnailUrl})` }}
                    />
                  ) : (
                    <MockThumb palette={chat.palette} className="size-11" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-[#50382f]">{chat.title}</p>
                    <p className="mt-1 truncate text-[10px] text-[#a08278]">{chat.subtitle}</p>
                  </div>
                  {chat.favorite && <Star className="size-4 fill-[#d58883] text-[#d58883]" />}
                </button>
                <button
                  type="button"
                  aria-label={`删除对话：${chat.title}`}
                  title="删除对话"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteChat(chat.id);
                  }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-[#c28b82] opacity-0 transition hover:bg-[#f1ded8] hover:text-[#a9514f] group-hover:opacity-100"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))
          ) : (
            <div className="rounded-[10px] border border-dashed border-[#ead9d0] px-4 py-5 text-sm leading-6 text-[#a08278]">
              完成一次购买决策后，这里会保存对话记录。
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-[12px] border border-[#ead9d0] bg-[#fbf5f1] p-3">
        <div className="flex items-center gap-3">
          <Avatar className="size-10" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-[#50382f]">{user.email ?? "当前用户"}</p>
            <p className="mt-1 text-[10px] text-[#a08278]">已登录</p>
          </div>
          <ChevronRight className="size-5 text-[#9a7468]" />
        </div>
      </div>
    </aside>
  );
}

function ChatView({
  profile,
  chatState,
  activeChatId,
  activeDecisionRun,
  onChatStateChange,
  onEnsureChatSession,
  onRunCreated,
  onApplySessionPatch,
  onSaveImageRequiredTurn,
  onOpenDecisions,
  onDecision,
}: {
  profile: UserProfile;
  chatState: DecisionChatState;
  activeChatId?: string;
  activeDecisionRun?: DecisionRun;
  onChatStateChange: (
    updater: DecisionChatState | ((current: DecisionChatState) => DecisionChatState),
  ) => void;
  onEnsureChatSession: (title: string) => Promise<string>;
  onRunCreated: (run: DecisionRun) => Promise<void>;
  onApplySessionPatch: (
    sessionId: string,
    patch: Partial<DecisionChatState>,
  ) => void;
  onSaveImageRequiredTurn: (payload: {
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
  }) => Promise<void>;
  onOpenDecisions: () => void;
  onDecision: (status: DecisionStatus) => Promise<void>;
}) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRequestingImageGuidance, setIsRequestingImageGuidance] = useState(false);
  const [expandedDecisionProgressSessionId, setExpandedDecisionProgressSessionId] = useState<
    string | null
  >(null);
  const [activeOutfitIndex, setActiveOutfitIndex] = useState(0);
  const [tryOnBatch, setTryOnBatch] = useState<OutfitTryOnBatch>({
    status: "idle",
    outfits: [],
  });
  const [tryOnRequestVersion, setTryOnRequestVersion] = useState(0);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const decisionStartedAtRef = useRef<number | null>(null);
  const decisionProgressScrollerRef = useRef<HTMLDivElement | null>(null);
  const submissionInFlightRef = useRef(false);
  const pendingDecisionSubmissionRef = useRef<PendingDecisionSubmission | null>(null);
  const {
    message,
    lastUserMessage,
    assistantMessage,
    purchaseImageDataUrl,
    purchaseImageName,
    assessment,
    error,
    notice,
  } = chatState;
  const isPersistedRunActive = Boolean(
    activeDecisionRun && isDecisionRunActive(activeDecisionRun.status),
  );
  const isAwaitingPersistedDecision = Boolean(
    isPersistedRunActive && (!activeDecisionRun?.reportId || !assessment),
  );
  const isAssessing = isSubmitting || isAwaitingPersistedDecision;
  const isComposerBusy = isSubmitting || isPersistedRunActive;
  const hasUserTurn = Boolean(lastUserMessage.trim() || purchaseImageDataUrl);
  const isConversationEmpty =
    !lastUserMessage.trim() && !assistantMessage && !assessment && !isAssessing && !error && !notice;
  const progressSteps = useMemo(
    () => [
      purchaseImageDataUrl ? "识别待买商品截图" : "整理待买商品信息",
      ...decisionProgressSteps.slice(1),
    ],
    [purchaseImageDataUrl],
  );
  const completedDecisionElapsedLabel =
    assessment && chatState.decisionElapsedSeconds
      ? formatDecisionElapsedTime(chatState.decisionElapsedSeconds)
      : null;
  const isDecisionProgressExpanded = Boolean(
    activeChatId && expandedDecisionProgressSessionId === activeChatId,
  );
  const activeDecisionStatusLabel =
    activeDecisionRun?.status === "queued" ? "排队中" : "思考中";
  const showActiveDecisionSteps = Boolean(
    isAssessing && activeDecisionRun?.status !== "queued",
  );
  const decisionProgressIndex = getPersistedDecisionProgressIndex(activeDecisionRun);
  const persistedTryOnRefreshKey =
    activeDecisionRun && activeDecisionRun.id === chatState.decisionRunId
      ? `${activeDecisionRun.stage}:${activeDecisionRun.status}:${activeDecisionRun.updatedAt}`
      : "legacy";

  useEffect(() => {
    if (!isAssessing || isRequestingImageGuidance) return;

    const scroller = decisionProgressScrollerRef.current;
    if (!scroller) return;

    scroller.scrollTo({ left: scroller.scrollWidth, behavior: "smooth" });
  }, [decisionProgressIndex, isAssessing, isRequestingImageGuidance]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadTryOns() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      if (!assessment) {
        setTryOnBatch({ status: "idle", outfits: [] });
        return;
      }

      const eligibleOutfits = getEligibleTryOnOutfits(
        assessment,
        Boolean(assessment.candidate.screenshotPath || assessment.candidate.screenshotUrl),
      );
      if (!eligibleOutfits.length) {
        setTryOnBatch({
          status: "unavailable",
          outfits: [],
          message: "当前没有足够可靠的真实搭配依据。",
        });
        return;
      }
      if (!chatState.reportId) {
        setTryOnBatch({
          status: "unavailable",
          outfits: [],
          message: "本次报告未能保存，暂时无法生成真人搭配。",
        });
        return;
      }

      setTryOnBatch({ status: "generating", outfits: [] });
      setActiveOutfitIndex(0);

      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("登录状态已过期，请重新登录。");

        const response = await fetch("/api/ai/generate-outfit-try-ons", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reportId: chatState.reportId }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const result = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(result?.message ?? "真人搭配生成暂时不可用。");
        }

        const result = (await response.json()) as OutfitTryOnBatch;
        if (!controller.signal.aborted) setTryOnBatch(result);
      } catch (currentError) {
        if (controller.signal.aborted) return;
        setTryOnBatch({
          status: "failed",
          outfits: eligibleOutfits.map((outfit, position) => ({
            outfitId: outfit.outfitId as string,
            position,
            closetItemIds: outfit.closetItemIds ?? [],
            status: "failed",
          })),
          message:
            currentError instanceof Error
              ? currentError.message
              : "真人搭配生成失败，请稍后重试。",
        });
      }
    }

    void loadTryOns();
    return () => controller.abort();
  }, [
    assessment,
    chatState.reportId,
    persistedTryOnRefreshKey,
    supabase,
    tryOnRequestVersion,
  ]);

  function updateChatState(patch: Partial<DecisionChatState>) {
    onChatStateChange((current) => ({ ...current, ...patch }));
  }

  async function handleSubmit() {
    const trimmedMessage = message.trim();
    if (
      (!trimmedMessage && !purchaseImageDataUrl) ||
      isComposerBusy ||
      submissionInFlightRef.current
    ) {
      return;
    }
    const isImageRequiredRequest = !purchaseImageDataUrl;
    let targetSessionId: string | undefined;

    submissionInFlightRef.current = true;
    updateChatState({
      lastUserMessage: trimmedMessage,
      assistantMessage: undefined,
      assessment: null,
      decisionElapsedSeconds: undefined,
      selectedDecisionStatus: undefined,
      error: "",
      notice: "",
    });
    setIsSubmitting(true);
    setIsRequestingImageGuidance(isImageRequiredRequest);
    setExpandedDecisionProgressSessionId(null);
    setTryOnBatch({ status: "idle", outfits: [] });
    decisionStartedAtRef.current = Date.now();
    setActiveOutfitIndex(0);

    try {
      const sessionId =
        activeChatId ??
        (await onEnsureChatSession(createChatTitle(trimmedMessage, Boolean(purchaseImageDataUrl))));
      targetSessionId = sessionId;
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("登录状态已过期，请重新登录。");

      if (purchaseImageDataUrl) {
        const submission = getStableDecisionSubmission(
          pendingDecisionSubmissionRef.current,
          {
            sessionId,
            message: trimmedMessage,
            imageDataUrl: purchaseImageDataUrl,
            imageName: purchaseImageName,
          },
        );
        pendingDecisionSubmissionRef.current = submission;
        const clientRequestId = submission.clientRequestId;
        const response = await fetch("/api/ai/decision-runs", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId,
            clientRequestId,
            message: trimmedMessage,
            imageDataUrl: purchaseImageDataUrl,
            imageName: purchaseImageName,
            userProfile: {
              heightCm: profile.heightCm ?? undefined,
              weightKg: profile.weightKg ?? undefined,
              bmi: profile.bmi ?? undefined,
              stylePreferences: profile.stylePreferences,
              commonScenarios: profile.commonScenarios,
              budgetSensitivity: profile.budgetSensitivity,
            },
          }),
        });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => null)) as {
            message?: string;
          } | null;
          throw new Error(errorData?.message ?? "创建决策任务失败，请稍后再试。");
        }

        const result = (await response.json()) as { run: DecisionRun };
        pendingDecisionSubmissionRef.current = null;
        await onRunCreated(result.run);
        return;
      }

      const response = await fetch("/api/ai/assess-purchase", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: trimmedMessage,
          imageDataUrl: purchaseImageDataUrl,
          sessionId,
          userProfile: {
            heightCm: profile.heightCm ?? undefined,
            weightKg: profile.weightKg ?? undefined,
            bmi: profile.bmi ?? undefined,
            stylePreferences: profile.stylePreferences,
            commonScenarios: profile.commonScenarios,
            budgetSensitivity: profile.budgetSensitivity,
          },
        }),
      });

      if (!response.ok) {
        let errorMessage = "AI 决策接口暂时不可用，请稍后再试。";
        try {
          const errorData = (await response.json()) as { message?: string };
          if (errorData.message) {
            errorMessage = `AI 决策接口返回错误：${errorData.message}`;
          }
        } catch {
          // Keep the friendly fallback when the server does not return JSON.
        }
        throw new Error(errorMessage);
      }

      const responseData = (await response.json()) as {
        mode: "image_required";
        message: string;
      };

      if (responseData.mode === "image_required") {
        onApplySessionPatch(sessionId, {
          message: "",
          assistantMessage: responseData.message,
          assessment: null,
          decisionElapsedSeconds: undefined,
          selectedDecisionStatus: undefined,
          candidateId: undefined,
          reportId: undefined,
          error: "",
          notice: "",
        });
        await onSaveImageRequiredTurn({
          sessionId,
          userMessage: trimmedMessage,
          assistantMessage: responseData.message,
        });
        return;
      }

      throw new Error("回复格式无效，请稍后再试。");
    } catch (currentError) {
      const patch = {
        error:
          currentError instanceof Error
            ? currentError.message
            : isImageRequiredRequest
              ? "回复失败，请稍后再试。"
              : "生成报告失败",
        notice: "",
      };
      if (targetSessionId) {
        onApplySessionPatch(targetSessionId, patch);
      } else {
        updateChatState(patch);
      }
    } finally {
      submissionInFlightRef.current = false;
      decisionStartedAtRef.current = null;
      setIsSubmitting(false);
      setIsRequestingImageGuidance(false);
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-col">
      {!isConversationEmpty && (
        <header className="px-4 pt-5 sm:px-6 sm:pt-6 lg:px-7">
          <div className="border-b border-[#f0e1da] pb-2.5 sm:pb-3">
            <p className="text-sm font-medium leading-6 text-[#60483f] sm:text-base">
              结合你的衣橱和偏好，给出可视化的搭配和购买建议
            </p>
          </div>
        </header>
      )}

      {isConversationEmpty ? (
        <div className="view-scroll flex min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6 sm:py-12 lg:px-10">
          <div className="m-auto w-full max-w-3xl">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-[#3d281f] sm:text-3xl">
                今天想买哪件衣服？
              </h2>
              <p className="mx-auto mt-2 whitespace-nowrap text-xs leading-6 text-[#8b6258] sm:text-base">
                上传商品截图，我会结合你的云端衣橱给出搭配组合和建议
              </p>
            </div>

            <Composer
              variant="starter"
              isAssessing={isComposerBusy}
              value={message}
              imageDataUrl={purchaseImageDataUrl}
              imageName={purchaseImageName}
              placeholder="上传截图并描述衣服相关信息"
              onChange={(nextMessage) => updateChatState({ message: nextMessage, notice: "" })}
              onImageSelect={async (file) => {
                updateChatState({
                  purchaseImageDataUrl: await fileToDataUrl(file),
                  purchaseImageName: file.name,
                  notice: "",
                });
              }}
              onClearImage={() => {
                updateChatState({
                  purchaseImageDataUrl: undefined,
                  purchaseImageName: undefined,
                  notice: "",
                });
              }}
              onSubmit={handleSubmit}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="view-scroll flex-1 overflow-y-auto px-4 pb-6 sm:px-6 lg:px-7">
            {hasUserTurn ? (
              <div className="ml-auto mt-6 flex w-full max-w-[460px] flex-col items-end">
                {purchaseImageDataUrl && (
                  <button
                    type="button"
                    onClick={() => setPreviewImageUrl(purchaseImageDataUrl)}
                    className="relative aspect-[4/5] w-full max-w-[140px] overflow-hidden rounded-[12px] bg-[#f6f3f0] bg-contain bg-center bg-no-repeat text-left transition hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#76576f]"
                    style={{ backgroundImage: `url(${purchaseImageDataUrl})` }}
                    aria-label="查看上传图片大图"
                  />
                )}
                <p
                  className={cn(
                    "w-fit max-w-[420px] rounded-[14px] bg-[#f2dfd8] px-4 py-2.5 text-left text-base leading-7 text-[#4c342d]",
                    purchaseImageDataUrl && "mt-2.5",
                  )}
                >
                  {lastUserMessage || "我想判断这件衣服是否值得买。"}
                </p>
              </div>
            ) : null}

            {((isAssessing && !isRequestingImageGuidance) || completedDecisionElapsedLabel) && (
              <section className="mt-8" aria-live="polite">
                <div className="flex flex-col gap-3">
                  {isAssessing ? (
                    <span className="w-fit text-sm text-[#9a9398]">
                      {activeDecisionStatusLabel}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={isDecisionProgressExpanded}
                      onClick={() =>
                        setExpandedDecisionProgressSessionId((expandedSessionId) =>
                          expandedSessionId === activeChatId ? null : (activeChatId ?? null),
                        )
                      }
                      className="inline-flex w-fit items-center gap-1 text-sm text-[#777078] transition hover:text-[#50382f]"
                    >
                      {completedDecisionElapsedLabel}
                      <ChevronRight
                        className={cn(
                          "size-4 transition-transform",
                          isDecisionProgressExpanded && "rotate-90",
                        )}
                      />
                    </button>
                  )}
                  <span className="h-px w-full bg-[#e4dedb]" aria-hidden="true" />
                </div>

                {(showActiveDecisionSteps || isDecisionProgressExpanded) && (
                  <div
                    ref={decisionProgressScrollerRef}
                    className="view-scroll mt-4 max-w-full overflow-x-auto pb-1"
                  >
                    <ol
                      className="flex w-max min-w-full items-center whitespace-nowrap"
                      aria-label="决策分析进度"
                    >
                      {progressSteps
                        .slice(
                          0,
                          showActiveDecisionSteps
                            ? decisionProgressIndex + 1
                            : progressSteps.length,
                        )
                        .map((item, index) => {
                          const isActive =
                            showActiveDecisionSteps && index === decisionProgressIndex;
                          return (
                            <li key={item} className="flex shrink-0 items-center text-sm">
                              {index > 0 && (
                                <ChevronRight
                                  className="mx-2 size-4 shrink-0 text-[#b2a9ad]"
                                  strokeWidth={1.5}
                                  aria-hidden="true"
                                />
                              )}
                              <div
                                className={cn(
                                  "flex min-h-9 items-center gap-2 transition",
                                  isActive
                                    ? "rounded-[8px] border border-[#ded7db] bg-[#faf8f9] px-3 text-[#50382f]"
                                    : "px-1 text-[#777078]",
                                )}
                              >
                                {isActive && (
                                  <ThinkingOrb
                                    state={decisionProgressOrbStates[index] ?? "working"}
                                    size={20}
                                    theme="light"
                                    speed={0.9}
                                    aria-hidden="true"
                                    className="shrink-0 opacity-75"
                                  />
                                )}
                                <span>{item}</span>
                              </div>
                            </li>
                          );
                        })}
                    </ol>
                  </div>
                )}
              </section>
            )}

            {isAssessing && isRequestingImageGuidance && (
              <p className="mt-8 text-sm text-[#9a9398]" role="status" aria-live="polite">
                正在确认需要的信息…
              </p>
            )}

            {error && (
              <div className="mt-5 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {notice && notice !== "已保存到最近对话，可从左侧继续打开。" && (
              <div className="mt-5 rounded-[12px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                {notice}
              </div>
            )}

            {assistantMessage && !assessment && (
              <section
                aria-label="图片补充引导"
                className="mt-8 max-w-3xl text-[15px] leading-8 text-[#60483f] sm:text-base"
              >
                <p>{assistantMessage}</p>
              </section>
            )}

            {assessment && (
              <DecisionReportCard
                assessment={assessment}
                tryOnBatch={tryOnBatch}
                activeOutfitIndex={activeOutfitIndex}
                candidateImageDataUrl={purchaseImageDataUrl}
                selectedDecisionStatus={chatState.selectedDecisionStatus}
                canRetryTryOns={!chatState.decisionRunId}
                onActiveOutfitIndexChange={setActiveOutfitIndex}
                onPreviewImage={setPreviewImageUrl}
                onRetryTryOns={() => setTryOnRequestVersion((version) => version + 1)}
                onDecision={onDecision}
                onOpenDecisions={onOpenDecisions}
              />
            )}
          </div>

          <Composer
            isAssessing={isComposerBusy}
            value={message}
            imageDataUrl={purchaseImageDataUrl}
            imageName={purchaseImageName}
            onChange={(nextMessage) => updateChatState({ message: nextMessage, notice: "" })}
            onImageSelect={async (file) => {
              updateChatState({
                purchaseImageDataUrl: await fileToDataUrl(file),
                purchaseImageName: file.name,
                notice: "",
              });
            }}
            onClearImage={() => {
              updateChatState({
                purchaseImageDataUrl: undefined,
                purchaseImageName: undefined,
                notice: "",
              });
            }}
            onSubmit={handleSubmit}
          />
        </>
      )}

      {previewImageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#241813]/70 px-6 py-8"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewImageUrl(null)}
        >
          <div
            className="relative max-h-[88vh] w-full max-w-3xl rounded-[18px] bg-white p-3 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setPreviewImageUrl(null)}
              className="absolute right-4 top-4 z-10 rounded-full bg-white/90 px-3 py-1.5 text-sm text-[#6e5148] shadow-sm transition hover:bg-[#fbf3ef]"
            >
              关闭
            </button>
            <div
              className="h-[78vh] w-full rounded-[12px] bg-[#f8f3ef] bg-contain bg-center bg-no-repeat"
              style={{ backgroundImage: `url(${previewImageUrl})` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionReportCard({
  assessment,
  tryOnBatch,
  activeOutfitIndex,
  candidateImageDataUrl,
  selectedDecisionStatus,
  canRetryTryOns,
  onActiveOutfitIndexChange,
  onPreviewImage,
  onRetryTryOns,
  onDecision,
  onOpenDecisions,
}: {
  assessment: PurchaseDecisionReport;
  tryOnBatch: OutfitTryOnBatch;
  activeOutfitIndex: number;
  candidateImageDataUrl?: string;
  selectedDecisionStatus?: DecisionStatus;
  canRetryTryOns: boolean;
  onActiveOutfitIndexChange: (index: number) => void;
  onPreviewImage: (imageUrl: string) => void;
  onRetryTryOns: () => void;
  onDecision: (status: DecisionStatus) => Promise<void>;
  onOpenDecisions: () => void;
}) {
  const [savingStatus, setSavingStatus] = useState<DecisionStatus | null>(null);

  async function handleDecisionClick(status: DecisionStatus) {
    if (savingStatus) return;
    setSavingStatus(status);
    try {
      await onDecision(status);
    } finally {
      setSavingStatus(null);
    }
  }

  const candidate = assessment.candidate;
  const candidateTitle = candidate.productName || "待买商品";
  const reportOutfits = withStableOutfitIds(assessment.outfitCombinations);
  const eligibleOutfits = getEligibleTryOnOutfits(
    { ...assessment, outfitCombinations: reportOutfits },
    Boolean(candidate.screenshotPath || candidate.screenshotUrl || candidateImageDataUrl),
  );
  const primaryReasons = (
    assessment.decision === "buy" ? assessment.reasonsToBuy : assessment.reasonsToSave
  ).slice(0, 3);
  const cautions = assessment.risks.slice(0, 2);
  const hasReadyTryOns = tryOnBatch.outfits.some(
    (outfit) => outfit.status === "ready" && Boolean(outfit.imageUrl),
  );

  return (
    <article className="mt-4 w-full pb-4">
      <section aria-label="购买建议">
        <p className="w-full text-[15px] leading-8 text-[#60483f] sm:text-base">
          {assessment.summary}
        </p>

        <div className="mt-3 grid gap-6 border-b border-[#eee5e1] py-5 md:grid-cols-2">
          <div>
            <p className="text-sm font-medium text-[#50382f]">主要依据</p>
            <ul className="mt-3 space-y-2.5">
              {primaryReasons.map((reason) => (
                <li key={reason} className="flex gap-3 text-sm leading-6 text-[#765b52]">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#b2605e]" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-medium text-[#50382f]">购买前留意</p>
            <ul className="mt-3 space-y-2.5">
              {cautions.map((risk) => (
                <li key={risk} className="flex gap-3 text-sm leading-6 text-[#765b52]">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#9a8780]" />
                  <span>{risk}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="decision-outfits-title" className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="decision-outfits-title" className="text-lg font-semibold text-[#2d2928] sm:text-xl">
            穿搭效果
          </h3>
          {eligibleOutfits.length ? (
            <span className="text-sm text-[#9a7d73]">共 {eligibleOutfits.length} 套</span>
          ) : null}
        </div>

        {tryOnBatch.status === "generating" ? (
          <div className="mt-3 flex min-h-40 items-center justify-center gap-3 border-y border-[#eee5e1] text-sm text-[#8b7b75]" aria-live="polite">
            <ThinkingOrb state="working" size={20} theme="light" speed={0.8} aria-hidden="true" />
            <span>真实搭配生成中</span>
          </div>
        ) : tryOnBatch.status === "ready" ? (
          <OutfitTryOnViewer
            reportOutfits={reportOutfits}
            tryOnBatch={tryOnBatch}
            activeIndex={activeOutfitIndex}
            candidateName={candidateTitle}
            candidateCategory={candidate.category || "待买商品"}
            candidateImageUrl={candidateImageDataUrl ?? candidate.screenshotUrl}
            onActiveIndexChange={onActiveOutfitIndexChange}
            onPreviewImage={onPreviewImage}
          />
        ) : tryOnBatch.status === "failed" ? (
          <div className="mt-3 border-y border-[#eee5e1] py-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-medium text-[#50382f]">真人搭配暂未全部生成</p>
                <p className="mt-1 text-sm leading-6 text-[#8b7168]">
                  {tryOnBatch.message ?? "生成过程出现中断，可以重试未完成的方案。"}
                </p>
              </div>
              {canRetryTryOns ? (
                <button
                  type="button"
                  onClick={onRetryTryOns}
                  className="inline-flex h-10 items-center gap-2 rounded-[8px] bg-[#b2605e] px-4 text-sm font-medium text-white transition hover:bg-[#9e4f4d]"
                >
                  <RefreshCw className="size-4" />
                  重新生成
                </button>
              ) : null}
            </div>
            {hasReadyTryOns ? (
              <OutfitTryOnViewer
                reportOutfits={reportOutfits}
                tryOnBatch={tryOnBatch}
                activeIndex={activeOutfitIndex}
                candidateName={candidateTitle}
                candidateCategory={candidate.category || "待买商品"}
                candidateImageUrl={candidateImageDataUrl ?? candidate.screenshotUrl}
                onActiveIndexChange={onActiveOutfitIndexChange}
                onPreviewImage={onPreviewImage}
              />
            ) : eligibleOutfits[0] ? (
              <OutfitSourceList
                outfit={eligibleOutfits[0]}
                candidateName={candidateTitle}
                candidateCategory={candidate.category || "待买商品"}
                candidateImageUrl={candidateImageDataUrl ?? candidate.screenshotUrl}
              />
            ) : null}
          </div>
        ) : (
          <div className="mt-3 border-y border-[#eee5e1] py-8 text-sm leading-6 text-[#8b7168]">
            {tryOnBatch.message ?? "当前没有可生成的真人搭配。"}
          </div>
        )}
      </section>

      <footer className="mt-4 border-t border-[#eee5e1] pt-3">
        <div className="rounded-[12px] border border-[#eadeda] bg-[#fcf8f6] p-3 sm:p-4">
          <div
            className={cn(
              "mb-3 flex items-center gap-2 text-sm font-medium",
              selectedDecisionStatus === "not_considering"
                ? "text-[#777078]"
                : selectedDecisionStatus
                  ? "text-[#617066]"
                  : "text-[#76576f]",
            )}
            aria-live="polite"
          >
            {selectedDecisionStatus === "not_considering" ? (
              <XCircle className="size-4" />
            ) : selectedDecisionStatus ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <Sparkles className="size-4" />
            )}
            <span>
              {selectedDecisionStatus === "not_considering"
                ? "未进入决策清单"
                : selectedDecisionStatus
                  ? "已保存到决策清单"
                  : "为这件衣服选择一个决策状态"}
            </span>
          </div>

          <div
            className={cn(
              "grid gap-3 sm:grid-cols-3",
              selectedDecisionStatus && "lg:grid-cols-[repeat(3,minmax(0,1fr))_auto]",
            )}
          >
            {(
              [
                { status: "decided_to_buy", icon: ShoppingCart },
                { status: "saved_for_later", icon: Bookmark },
                { status: "not_considering", icon: XCircle },
              ] satisfies Array<{ status: DecisionStatus; icon: LucideIcon }>
            ).map(({ status, icon: ActionIcon }) => {
              const isSelected = selectedDecisionStatus === status;
              const isSaving = savingStatus === status;
              const LabelIcon = isSelected ? CheckCircle2 : ActionIcon;

              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => void handleDecisionClick(status)}
                  disabled={Boolean(savingStatus)}
                  className={cn(
                    "inline-flex h-11 items-center justify-center gap-2 rounded-[8px] border text-sm font-medium transition disabled:cursor-wait disabled:opacity-70",
                    isSelected
                      ? `${statusConfig[status].tone} border-current shadow-sm`
                      : "border-[#d7c1ca] bg-white text-[#76576f] hover:border-[#b998aa] hover:bg-[#fbf3f7]",
                  )}
                >
                  <LabelIcon className="size-4" />
                  {isSaving ? "保存中..." : statusConfig[status].label}
                </button>
              );
            })}

            {selectedDecisionStatus ? (
              <button
                type="button"
                onClick={onOpenDecisions}
                className="inline-flex h-11 items-center justify-center gap-1 px-2 text-sm text-[#76576f] transition hover:text-[#b2605e] sm:col-span-3 lg:col-span-1"
              >
                查看决策清单
                <ChevronRight className="size-4" />
              </button>
            ) : null}
          </div>
        </div>
      </footer>
    </article>
  );
}

function OutfitTryOnViewer({
  reportOutfits,
  tryOnBatch,
  activeIndex,
  candidateName,
  candidateCategory,
  candidateImageUrl,
  onActiveIndexChange,
  onPreviewImage,
}: {
  reportOutfits: PurchaseDecisionReport["outfitCombinations"];
  tryOnBatch: OutfitTryOnBatch;
  activeIndex: number;
  candidateName: string;
  candidateCategory: string;
  candidateImageUrl?: string;
  onActiveIndexChange: (index: number) => void;
  onPreviewImage: (imageUrl: string) => void;
}) {
  const reportByOutfitId = new Map(
    reportOutfits.flatMap((outfit) => (outfit.outfitId ? [[outfit.outfitId, outfit]] : [])),
  );
  const readyOutfits = tryOnBatch.outfits.flatMap((result) => {
    const outfit = reportByOutfitId.get(result.outfitId);
    return result.status === "ready" && result.imageUrl && outfit
      ? [{ result, outfit }]
      : [];
  });
  const safeIndex = readyOutfits.length ? Math.min(activeIndex, readyOutfits.length - 1) : 0;
  const current = readyOutfits[safeIndex];

  if (!current) {
    return (
      <div className="mt-3 border-y border-[#eee5e1] py-8 text-sm text-[#8b7168]">
        真人搭配图片暂时无法读取，请重新生成。
      </div>
    );
  }

  return (
    <div className="mt-3">
      {readyOutfits.length > 1 ? (
        <div className="mb-3 inline-flex max-w-full gap-1 overflow-x-auto rounded-[8px] bg-[#f4efec] p-1" role="tablist" aria-label="选择穿搭方案">
          {readyOutfits.map(({ outfit }, index) => (
            <button
              key={outfit.outfitId}
              type="button"
              role="tab"
              aria-selected={index === safeIndex}
              onClick={() => onActiveIndexChange(index)}
              className={cn(
                "h-9 shrink-0 rounded-[6px] px-4 text-sm transition",
                index === safeIndex
                  ? "bg-white font-medium text-[#50382f] shadow-sm"
                  : "text-[#8b7168] hover:text-[#50382f]",
              )}
            >
              方案 {index + 1}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid items-stretch gap-x-6 gap-y-2 lg:grid-cols-[minmax(0,1.05fr)_minmax(300px,0.95fr)] lg:gap-x-8">
        <button
          type="button"
          onClick={() => onPreviewImage(current.result.imageUrl as string)}
          className="aspect-square w-full overflow-hidden rounded-[8px] bg-[#f2efec] bg-cover bg-center bg-no-repeat text-left transition hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b2605e] lg:col-start-1 lg:row-start-1"
          style={{ backgroundImage: `url(${current.result.imageUrl})` }}
          aria-label={`查看方案 ${safeIndex + 1} 真人搭配大图`}
        />
        <p className="text-xs leading-5 text-[#9a8178] lg:col-start-1 lg:row-start-2">
          AI 搭配示意用于核对组合，不代表实际尺码和上身效果。
        </p>

        <div className="mt-4 min-w-0 lg:col-start-2 lg:row-start-1 lg:mt-0">
          <OutfitSourceList
            outfit={current.outfit}
            candidateName={candidateName}
            candidateCategory={candidateCategory}
            candidateImageUrl={candidateImageUrl}
            className="mt-0 h-full"
          />
        </div>
      </div>
    </div>
  );
}

function OutfitSourceList({
  outfit,
  candidateName,
  candidateCategory,
  candidateImageUrl,
  className,
}: {
  outfit: PurchaseDecisionReport["outfitCombinations"][number];
  candidateName: string;
  candidateCategory: string;
  candidateImageUrl?: string;
  className?: string;
}) {
  const evidenceItems = outfit.visualItems ?? [];

  return (
    <div
      className={cn(
        "mt-5 flex overflow-hidden rounded-[14px] border border-[#ded3cf] bg-[#fffdfb]",
        className,
      )}
    >
      <div className="flex min-h-0 w-full flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-[#e7ddda] px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-[#2f2927]">{outfit.title}</p>
            <p className="mt-1 text-sm text-[#9a8983]">{outfit.scenario}</p>
          </div>
        </div>

        <div className="flex-1 px-5 py-2">
          <div className="flex gap-4 py-3">
            {candidateImageUrl ? (
              <div
                className="h-24 w-20 shrink-0 rounded-[10px] bg-[#f8f3ef] bg-contain bg-center bg-no-repeat"
                style={{ backgroundImage: `url(${candidateImageUrl})` }}
              />
            ) : (
              <MockProductImage palette="from-[#c9a58e] to-[#f4ded4]" className="h-24 w-20 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex rounded-full bg-[#4b2c21] px-3 py-1 text-xs font-medium text-white">
                  待买衣服
                </span>
                <span className="text-xs text-[#9a8983]">{candidateCategory}</span>
              </div>
              <p className="mt-2 text-base font-semibold text-[#2f2927]">{candidateName}</p>
              <p className="mt-2 text-sm leading-6 text-[#7f706b]">
                作为本次待判断的核心单品，用来核对它与衣橱现有单品的搭配关系。
              </p>
            </div>
          </div>

          {evidenceItems.map((item) => (
            <div key={item.id} className="flex gap-4 border-t border-[#eee5e1] py-3">
              {item.imageUrl ? (
                <div
                  className="h-24 w-20 shrink-0 rounded-[10px] bg-[#f8f3ef] bg-contain bg-center bg-no-repeat"
                  style={{ backgroundImage: `url(${item.imageUrl})` }}
                />
              ) : (
                <MockThumb palette="from-[#f2eee7] to-[#d7c4ad]" className="h-24 w-20 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex rounded-full bg-[#ece4e8] px-3 py-1 text-xs font-medium text-[#7d6874]">
                    {item.role ?? item.badge ?? "衣橱单品"}
                  </span>
                  <span className="text-xs text-[#9a8983]">{item.category}</span>
                </div>
                <p className="mt-2 text-base font-semibold text-[#2f2927]">{item.name}</p>
                {item.reason ? (
                  <p className="mt-2 text-sm leading-6 text-[#7f706b]">{item.reason}</p>
                ) : null}
                {item.tags?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="rounded-full bg-[#f1eaee] px-2.5 py-1 text-xs text-[#8b7b84]">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {outfit.summary ? (
          <p className="border-t border-[#ded3cf] px-5 py-4 text-sm leading-7 text-[#766762]">
            {outfit.summary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ClosetView({
  items,
  isLoading,
  isUploadBusy,
  message,
  busyItemIds,
  queuedAnalysisItemIds,
  onUploadImages,
  onConfirmItem,
  onConfirmHighConfidence,
  onRetryDisplayImage,
  onRetryAnalysis,
  onDeleteItem,
  onImageLoad,
}: {
  items: ClothingItem[];
  isLoading: boolean;
  isUploadBusy: boolean;
  message: string;
  busyItemIds: ClosetBusyItemIds;
  queuedAnalysisItemIds: string[];
  onUploadImages: (files: File[]) => Promise<void>;
  onConfirmItem: (item: ClothingItem, draft: ClosetConfirmationDraft) => Promise<void>;
  onConfirmHighConfidence: (items: ClothingItem[]) => Promise<void>;
  onRetryDisplayImage: (item: ClothingItem) => Promise<void>;
  onRetryAnalysis: (item: ClothingItem, userFeedback?: string) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
  onImageLoad: ClosetImageLoadHandler;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<ClosetFilters>(() => createEmptyClosetFilters());
  const [openFilterKey, setOpenFilterKey] = useState<ClosetFilterKey | null>(null);
  const oftenCount = items.filter((item) => item.wearFrequency === "often").length;
  const sometimesCount = items.filter((item) => item.wearFrequency === "sometimes").length;
  const idleCount = items.filter((item) => item.wearFrequency === "rarely" || item.status === "idle").length;
  const filterOptions = useMemo(() => getClosetFilterOptions(items), [items]);
  const filteredItems = useMemo(
    () => filterClosetItems(items, searchQuery, filters),
    [items, searchQuery, filters],
  );
  const activeSearchQuery = searchQuery.trim();
  const hasActiveCriteria = Boolean(activeSearchQuery) || hasActiveClosetFilters(filters);
  const pendingConfirmationItems = items.filter(needsClosetConfirmation);
  const uploadDisabled = isLoading || isUploadBusy;

  useEffect(() => {
    if (!openFilterKey) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (!filterBarRef.current?.contains(event.target as Node)) {
        setOpenFilterKey(null);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      filterBarRef.current
        ?.querySelector<HTMLButtonElement>(`[data-closet-filter-trigger="${openFilterKey}"]`)
        ?.focus();
      setOpenFilterKey(null);
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openFilterKey]);

  function toggleFilterValue(key: ClosetFilterKey, value: string) {
    setFilters((current) => {
      const activeValues: readonly string[] = current[key];
      const nextValues = activeValues.includes(value)
        ? activeValues.filter((activeValue) => activeValue !== value)
        : [...activeValues, value];

      return { ...current, [key]: nextValues } as ClosetFilters;
    });
  }

  function clearFilter(key: ClosetFilterKey) {
    setFilters((current) => ({ ...current, [key]: [] }) as ClosetFilters);
  }

  function resetAllCriteria() {
    setSearchQuery("");
    setFilters(createEmptyClosetFilters());
    setOpenFilterKey(null);
  }

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []).filter((file) => file.type.startsWith("image/"));
    await onUploadImages(files);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <div className="view-scroll w-full overflow-y-auto p-4 sm:p-6 lg:p-7">
      <HeaderInline
        title="我的衣橱"
        subtitle={items.length ? `共 ${items.length} 件衣服` : "上传第一件衣服，开始沉淀你的长期衣橱"}
        actions={
          <>
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={(event) => handleFiles(event.target.files)}
            />
            <button
              disabled={uploadDisabled}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] px-5 font-medium text-white shadow-lg shadow-rose-200/70 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="size-4" />
              {uploadDisabled ? "上传中" : "上传衣服"}
            </button>
            <button
              disabled={uploadDisabled}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-5 text-[#8b6258] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Upload className="size-4" />
              批量上传
            </button>
          </>
        }
      />

      <div className="mt-5 rounded-[16px] border border-[#ead9d0] bg-white p-4 shadow-[0_12px_32px_rgba(45,43,50,0.04)]">
        <div ref={filterBarRef} className="flex flex-wrap items-center gap-4">
          {(Object.keys(closetFilterLabels) as ClosetFilterKey[]).map((key) => (
            <ClosetFilterMenu
              key={key}
              label={closetFilterLabels[key]}
              filterKey={key}
              options={filterOptions[key]}
              selectedValues={filters[key]}
              isOpen={openFilterKey === key}
              onOpenChange={(isOpen) => setOpenFilterKey(isOpen ? key : null)}
              onToggleValue={(value) => toggleFilterValue(key, value)}
              onClear={() => clearFilter(key)}
            />
          ))}
          <div className="ml-auto flex h-10 w-full items-center gap-2 rounded-[10px] border border-[#ead9d0] px-3 text-[#a08278] transition focus-within:border-[#cf6f70] focus-within:ring-2 focus-within:ring-[#cf6f70]/15 sm:w-auto sm:min-w-60">
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onFocus={() => setOpenFilterKey(null)}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索衣服名称或标签"
              aria-label="搜索衣橱"
              className="min-w-0 flex-1 appearance-none bg-transparent text-sm text-[#7b5b51] outline-none placeholder:text-[#a08278] [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="清除衣橱搜索"
                title="清除搜索"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[#a08278] transition hover:bg-[#fbf0ec] hover:text-[#b2605e]"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {message && (
          <div className="mt-4 rounded-[12px] border border-[#ead9d0] bg-[#fbf5f1] px-4 py-3 text-sm text-[#7b5b51]">
            {message}
          </div>
        )}

        {pendingConfirmationItems.length > 0 && (
          <ClosetConfirmationPanel
            items={pendingConfirmationItems}
            isBusy={isLoading}
            busyItemIds={busyItemIds}
            queuedAnalysisItemIds={queuedAnalysisItemIds}
            onConfirmItem={onConfirmItem}
            onConfirmHighConfidence={onConfirmHighConfidence}
            onDeleteItem={onDeleteItem}
            onImageLoad={onImageLoad}
          />
        )}

        {items.length ? (
          filteredItems.length ? (
            <>
              {hasActiveCriteria && (
                <div
                  className="mt-4 flex flex-wrap items-center gap-3 text-sm text-[#8b6258]"
                  role="status"
                  aria-live="polite"
                >
                  <p>找到 {filteredItems.length} 件，共 {items.length} 件</p>
                  <button
                    type="button"
                    onClick={resetAllCriteria}
                    className="text-[#b2605e] transition hover:text-[#8d3f3f]"
                  >
                    重置全部
                  </button>
                </div>
              )}
              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {filteredItems.map((item) => (
                  <ClosetCard
                    key={item.id}
                    item={item}
                    isAnalysisBusy={
                      isLoading ||
                      busyItemIds.analysis.includes(item.id) ||
                      queuedAnalysisItemIds.includes(item.id)
                    }
                    isConfirmationBusy={busyItemIds.confirmation.includes(item.id)}
                    isDisplayBusy={busyItemIds.display.includes(item.id)}
                    isDeleting={busyItemIds.deletion.includes(item.id)}
                    isAnalysisQueued={queuedAnalysisItemIds.includes(item.id)}
                    onRetryDisplayImage={onRetryDisplayImage}
                    onRetryAnalysis={onRetryAnalysis}
                    onDeleteItem={onDeleteItem}
                    onImageLoad={onImageLoad}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="mt-5 rounded-[14px] border border-dashed border-[#e5b9b0] bg-[#fffaf7] p-10 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-[#fbf0ec] text-[#b2605e]">
                <Search className="size-6" aria-hidden="true" />
              </div>
              <p className="mt-4 text-sm text-[#8b6258]" role="status" aria-live="polite">
                找到 0 件，共 {items.length} 件
              </p>
              <h3 className="mt-4 text-xl font-semibold text-[#3d281f]">未找到匹配单品</h3>
              <p className="mx-auto mt-2 max-w-md leading-7 text-[#8b6258]">
                没有找到符合当前搜索或筛选条件的衣服。
              </p>
              <button
                type="button"
                onClick={resetAllCriteria}
                className="mt-5 inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-4 text-sm text-[#b2605e] transition hover:bg-[#fbf0ec]"
              >
                <X className="size-4" aria-hidden="true" />
                清除全部条件
              </button>
            </div>
          )
        ) : (
          <div className="mt-5 rounded-[14px] border border-dashed border-[#e5b9b0] bg-[#fffaf7] p-10 text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-[#fbf0ec] text-[#b2605e]">
              <Shirt className="size-7" />
            </div>
            <h3 className="mt-4 text-xl font-semibold text-[#3d281f]">还没有衣橱单品</h3>
            <p className="mx-auto mt-2 max-w-md leading-7 text-[#8b6258]">
              先上传几件常穿衣服。后续 AI 会自动识别品类、颜色、版型和风格，并用于购买决策时的搭配检索。
            </p>
            <button
              disabled={uploadDisabled}
              onClick={() => fileInputRef.current?.click()}
              className="mt-5 inline-flex h-11 items-center gap-2 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] px-5 font-medium text-white shadow-lg shadow-rose-200/70 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ImagePlus className="size-4" />
              {uploadDisabled ? "上传中" : "上传第一件衣服"}
            </button>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-5 text-sm text-[#8b6258]">
          <span>共 {items.length} 件衣服</span>
          <span className="inline-flex items-center gap-2"><i className="size-2 rounded-full bg-emerald-600" />常穿 {oftenCount}</span>
          <span className="inline-flex items-center gap-2"><i className="size-2 rounded-full bg-amber-500" />偶尔穿 {sometimesCount}</span>
          <span className="inline-flex items-center gap-2"><i className="size-2 rounded-full bg-stone-400" />闲置 {idleCount}</span>
        </div>
      </div>
    </div>
  );
}

function ClosetFilterMenu({
  filterKey,
  label,
  options,
  selectedValues,
  isOpen,
  onOpenChange,
  onToggleValue,
  onClear,
}: {
  filterKey: ClosetFilterKey;
  label: string;
  options: readonly ClosetFilterOption[];
  selectedValues: readonly string[];
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onToggleValue: (value: string) => void;
  onClear: () => void;
}) {
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const selectedOptions = options.filter((option) => selectedValues.includes(option.value));
  const selectedCount = selectedValues.length;
  const selectedSummary =
    selectedCount === 0
      ? "全部"
      : selectedCount === 1 && selectedOptions.length === 1
        ? selectedOptions[0].label
        : `已选 ${selectedCount} 项`;
  const menuId = `closet-filter-${filterKey}`;
  const menuPositionClass =
    filterKey === "styles" || filterKey === "seasons"
      ? "right-0 left-auto max-[335px]:right-auto max-[335px]:left-0 sm:right-auto sm:left-0"
      : "left-0";

  return (
    <div className="relative inline-flex h-10 w-32 max-w-full">
      <button
        ref={triggerButtonRef}
        type="button"
        data-closet-filter-trigger={filterKey}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => onOpenChange(!isOpen)}
        className={cn(
          "inline-flex min-w-0 flex-1 items-center gap-2 border px-3 text-sm transition focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf6f70]/35",
          selectedCount
            ? "rounded-l-[10px] border-r-0 border-[#e5b9b0] bg-[#fbf0ec] text-[#b2605e]"
            : "justify-between rounded-[10px] border-[#ead9d0] text-[#7b5b51] hover:border-[#d8bbb0]",
        )}
      >
        <span className="shrink-0">{label}</span>
        <span
          title={selectedSummary}
          className={cn(
            "min-w-0 flex-1 truncate text-right",
            selectedCount ? "text-[#b2605e]" : "text-[#a08278]",
          )}
        >
          {selectedSummary}
        </span>
        {!selectedCount && (
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")}
            aria-hidden="true"
          />
        )}
      </button>

      {selectedCount > 0 && (
        <button
          type="button"
          aria-label={`清除${label}筛选`}
          title={`清除${label}筛选`}
          onClick={(event) => {
            event.stopPropagation();
            onClear();
            onOpenChange(false);
            triggerButtonRef.current?.focus();
          }}
          className="inline-flex w-9 shrink-0 items-center justify-center rounded-r-[10px] border border-l-0 border-[#e5b9b0] bg-[#fbf0ec] text-[#b2605e] transition hover:bg-[#f7e6e1] hover:text-[#8d3f3f] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#cf6f70]/35"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}

      {isOpen && (
        <div
          id={menuId}
          role="dialog"
          aria-label={`${label}筛选`}
          className={cn(
            "absolute top-[calc(100%+0.5rem)] z-30 w-72 max-w-[calc(100vw-3rem)] rounded-[12px] border border-[#ead9d0] bg-white p-2 shadow-xl shadow-stone-200/70",
            menuPositionClass,
          )}
        >
          <div className="flex items-center justify-end gap-3 border-b border-[#f0e1da] px-2 pb-2">
            <button
              type="button"
              disabled={selectedCount === 0}
              onClick={onClear}
              className="text-xs text-[#b2605e] transition hover:text-[#8d3f3f] disabled:cursor-not-allowed disabled:opacity-40"
            >
              全部
            </button>
          </div>

          <div className="mt-1 max-h-64 overflow-y-auto py-1">
            {options.length ? (
              options.map((option) => {
                const selected = selectedValues.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-[9px] px-2 py-2 text-sm transition hover:bg-[#fbf5f1] focus-within:ring-2 focus-within:ring-[#cf6f70]/30",
                      selected ? "bg-[#fbf0ec] text-[#b2605e]" : "text-[#6e5148]",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => onToggleValue(option.value)}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        "inline-flex size-4 shrink-0 items-center justify-center rounded border",
                        selected
                          ? "border-[#c86c67] bg-[#c86c67] text-white"
                          : "border-[#cfbdb6] bg-white text-transparent",
                      )}
                      aria-hidden="true"
                    >
                      <Check className="size-3" />
                    </span>
                    <span className="min-w-0 truncate">{option.label}</span>
                  </label>
                );
              })
            ) : (
              <p className="px-2 py-3 text-sm text-[#8b6258]">暂无可筛选项</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ClosetItemImage({
  itemId,
  imageUrl,
  className,
  onImageLoad,
}: {
  itemId: string;
  imageUrl: string;
  className: string;
  onImageLoad: ClosetImageLoadHandler;
}) {
  return (
    // A native image load event is required to distinguish signed-URL creation from rendered media.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt=""
      className={cn("block rounded-[10px] bg-[#faf7f4] object-contain object-center", className)}
      onLoad={() => onImageLoad(itemId, imageUrl, "success")}
      onError={() => onImageLoad(itemId, imageUrl, "failure")}
    />
  );
}

function ClosetConfirmationPanel({
  items,
  isBusy,
  busyItemIds,
  queuedAnalysisItemIds,
  onConfirmItem,
  onConfirmHighConfidence,
  onDeleteItem,
  onImageLoad,
}: {
  items: ClothingItem[];
  isBusy: boolean;
  busyItemIds: ClosetBusyItemIds;
  queuedAnalysisItemIds: string[];
  onConfirmItem: (item: ClothingItem, draft: ClosetConfirmationDraft) => Promise<void>;
  onConfirmHighConfidence: (items: ClothingItem[]) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
  onImageLoad: ClosetImageLoadHandler;
}) {
  const highConfidenceCount = items.filter(
    (item) => (item.aiConfidence ?? 0) >= 0.8 && !(item.imageQualityFlags ?? []).includes("closet_analysis_failed"),
  ).length;
  const highConfidenceBusy = items.some(
    (item) =>
      (item.aiConfidence ?? 0) >= 0.8 &&
      (busyItemIds.analysis.includes(item.id) ||
        busyItemIds.confirmation.includes(item.id) ||
        busyItemIds.deletion.includes(item.id) ||
        queuedAnalysisItemIds.includes(item.id)),
  );

  return (
    <section className="mt-5 rounded-[16px] border border-[#e7c5ba] bg-[#fffaf7] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="min-w-0 flex-1 text-lg font-semibold leading-7 text-[#3d281f]">
          待确认信息（确认后会将标签存入云端衣橱，用于后续搭配检索）
        </h3>
        <button
          type="button"
          disabled={isBusy || highConfidenceBusy || highConfidenceCount === 0}
          onClick={() => void onConfirmHighConfidence(items)}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[10px] bg-[#3d281f] px-4 text-sm font-medium text-white transition hover:bg-[#533b31] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="size-4" />
          全部确认
        </button>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {items.map((item) => (
          <ClosetConfirmationCard
            key={`${item.id}-${item.userCorrected ? "confirmed" : "pending"}-${item.aiConfidence ?? "na"}-${item.summary ?? ""}`}
            item={item}
            isAnalysisBusy={
              isBusy ||
              busyItemIds.analysis.includes(item.id) ||
              queuedAnalysisItemIds.includes(item.id)
            }
            isConfirmationBusy={busyItemIds.confirmation.includes(item.id)}
            isDeleting={busyItemIds.deletion.includes(item.id)}
            isAnalysisQueued={queuedAnalysisItemIds.includes(item.id)}
            onConfirmItem={onConfirmItem}
            onDeleteItem={onDeleteItem}
            onImageLoad={onImageLoad}
          />
        ))}
      </div>
    </section>
  );
}

function ClosetConfirmationCard({
  item,
  isAnalysisBusy,
  isConfirmationBusy,
  isDeleting,
  isAnalysisQueued,
  onConfirmItem,
  onDeleteItem,
  onImageLoad,
}: {
  item: ClothingItem;
  isAnalysisBusy: boolean;
  isConfirmationBusy: boolean;
  isDeleting: boolean;
  isAnalysisQueued: boolean;
  onConfirmItem: (item: ClothingItem, draft: ClosetConfirmationDraft) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
  onImageLoad: ClosetImageLoadHandler;
}) {
  const [draft, setDraft] = useState(() => createConfirmationDraft(item));
  const [showOriginal, setShowOriginal] = useState(false);
  const qualityFlags = filterLegacyDisplayImageFlags(item.imageQualityFlags);
  const displayedImageUrl =
    showOriginal && item.originalImageUrl
      ? item.originalImageUrl
      : item.displayImageUrl ?? item.originalImageUrl ?? item.imageUrl;
  const displayStatus = item.displayImageStatus ?? "not_started";
  const analysisProgress = getClosetAnalysisProgress({
    imageQualityFlags: qualityFlags,
    category: item.category,
    styleTags: item.styleTags,
    isQueued: isAnalysisQueued,
  });
  const displayProgress = getClosetDisplayProgress({
    displayImageStatus: displayStatus,
  });
  const analysisInProgress = analysisProgress.state === "in_progress";
  const itemInteractionBusy =
    analysisInProgress || isAnalysisBusy || isConfirmationBusy || isDeleting;

  function updateDraft(patch: Partial<ClosetConfirmationDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  return (
    <article className="rounded-[14px] border border-[#ead9d0] bg-white p-3">
      <div className="grid gap-4 md:grid-cols-[180px_1fr]">
        <div>
          <div className="relative">
            {displayedImageUrl ? (
              <ClosetItemImage
                itemId={item.id}
                imageUrl={displayedImageUrl}
                className="aspect-square w-full"
                onImageLoad={onImageLoad}
              />
            ) : (
              <MockProductImage palette={item.palette} className="aspect-square w-full" />
            )}
            {item.displayImageUrl && item.originalImageUrl ? (
              <button
                type="button"
                onClick={() => setShowOriginal((current) => !current)}
                className="absolute left-2 top-2 rounded-full bg-[#3d281f]/80 px-3 py-1 text-xs text-white shadow transition hover:bg-[#3d281f]"
              >
                {showOriginal ? "展示图" : "原图"}
              </button>
            ) : (
              <span className="absolute left-2 top-2 rounded-full bg-[#3d281f]/80 px-3 py-1 text-xs text-white shadow">
                原图
              </span>
            )}
          </div>
          <ClosetUploadProgress
            analysis={analysisProgress}
            display={displayProgress}
          />
        </div>

        <div className="min-w-0">
          <div className="grid gap-3 sm:grid-cols-2">
            <LabeledInput
              label="名称"
              value={draft.name}
              onChange={(value) => updateDraft({ name: value })}
            />
            <LabeledInput
              label="品类"
              value={analysisInProgress ? "待识别" : draft.category}
              disabled={analysisInProgress}
              muted={analysisInProgress}
              onChange={(value) => updateDraft({ category: value })}
            />
            <LabeledInput
              label="颜色"
              value={analysisInProgress ? "待识别" : draft.color}
              disabled={analysisInProgress}
              muted={analysisInProgress}
              onChange={(value) => updateDraft({ color: value })}
            />
            <LabeledSelect
              label="版型"
              value={analysisInProgress ? "analysis_pending" : draft.fit}
              options={fitOptions}
              pendingOption={analysisInProgress ? { value: "analysis_pending", label: "待识别" } : undefined}
              disabled={analysisInProgress}
              mutedValue={analysisInProgress ? "analysis_pending" : undefined}
              onChange={(value) => updateDraft({ fit: value as ClothingItem["fit"] })}
            />
            <LabeledTagInput
              label="风格标签"
              value={analysisInProgress ? ["待识别"] : draft.styleTags}
              placeholder="休闲、简约、通勤"
              disabled={analysisInProgress}
              muted={analysisInProgress}
              onChange={(value) => updateDraft({ styleTags: value })}
            />
            <LabeledTagInput
              label="场景标签"
              value={analysisInProgress ? ["待识别"] : draft.scenarioTags}
              placeholder="日常、通勤、旅行"
              disabled={analysisInProgress}
              muted={analysisInProgress}
              onChange={(value) => updateDraft({ scenarioTags: value })}
            />
            <LabeledTagInput
              label="季节标签"
              value={analysisInProgress ? ["待识别"] : draft.seasonTags}
              placeholder="春季、夏季、四季"
              disabled={analysisInProgress}
              muted={analysisInProgress}
              onChange={(value) => updateDraft({ seasonTags: value })}
            />
            <LabeledSelect
              label="穿着频率"
              value={draft.wearFrequency}
              options={wearFrequencyOptions}
              mutedValue="unknown"
              onChange={(value) =>
                updateDraft({ wearFrequency: value as ClothingItem["wearFrequency"] })
              }
            />
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={isDeleting}
              onClick={() => void onDeleteItem(item)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#f0c8c2] px-4 text-sm text-[#b14545] transition hover:bg-[#fff0ef] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="size-4" />
              删除
            </button>
            <button
              type="button"
              disabled={itemInteractionBusy || !draft.name.trim() || !draft.category.trim()}
              onClick={() => void onConfirmItem(item, draft)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] px-4 text-sm font-medium text-white shadow-md shadow-rose-200/70 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="size-4" />
              确认保存
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function LabeledInput({
  label,
  value,
  disabled = false,
  muted = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  muted?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#8b6258]">{label}</span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "mt-1 h-10 w-full rounded-[10px] border border-[#ead9d0] bg-[#fffdfb] px-3 text-sm outline-none transition focus:border-[#cf6f70] disabled:cursor-not-allowed disabled:opacity-100",
          muted ? "text-[#9b9592]" : "text-[#3d281f]",
        )}
      />
    </label>
  );
}

function LabeledSelect({
  label,
  value,
  options,
  pendingOption,
  disabled = false,
  mutedValue,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  pendingOption?: { value: string; label: string };
  disabled?: boolean;
  mutedValue?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#8b6258]">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "mt-1 h-10 w-full rounded-[10px] border border-[#ead9d0] bg-[#fffdfb] px-3 text-sm outline-none transition focus:border-[#cf6f70] disabled:cursor-not-allowed disabled:opacity-100",
          value === mutedValue ? "text-[#9b9592]" : "text-[#3d281f]",
        )}
      >
        {pendingOption && (
          <option value={pendingOption.value}>{pendingOption.label}</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function LabeledTagInput({
  label,
  value,
  placeholder,
  disabled = false,
  muted = false,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder: string;
  disabled?: boolean;
  muted?: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#8b6258]">{label}</span>
      <input
        value={value.join("、")}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(splitTags(event.target.value))}
        className={cn(
          "mt-1 h-10 w-full rounded-[10px] border border-[#ead9d0] bg-[#fffdfb] px-3 text-sm outline-none transition focus:border-[#cf6f70] disabled:cursor-not-allowed disabled:opacity-100",
          muted ? "text-[#9b9592]" : "text-[#3d281f]",
        )}
      />
    </label>
  );
}

function ClosetUploadProgress({
  analysis,
  display,
}: {
  analysis: ClosetUploadTaskProgress;
  display: ClosetUploadTaskProgress;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="mt-3 space-y-2 px-1 text-[13px] leading-5"
    >
      <ClosetUploadProgressRow progress={analysis} orbState="searching" />
      <ClosetUploadProgressRow progress={display} orbState="shaping" />
    </div>
  );
}

function ClosetUploadProgressRow({
  progress,
  orbState,
}: {
  progress: ClosetUploadTaskProgress;
  orbState: OrbState;
}) {
  const iconClassName = "size-5 shrink-0";

  return (
    <div
      className={cn(
        "flex min-h-5 items-center gap-2",
        progress.state === "in_progress" && "text-[#76576f]",
        progress.state === "complete" && "text-[#617066]",
        progress.state === "failed" && "text-[#9a514f]",
        progress.state === "waiting" && "text-[#8b7f7a]",
      )}
    >
      {progress.state === "in_progress" ? (
        <ThinkingOrb
          state={orbState}
          size={20}
          theme="light"
          speed={0.9}
          aria-hidden="true"
          className="shrink-0 opacity-75"
        />
      ) : progress.state === "complete" ? (
        <CheckCircle2 aria-hidden="true" className={iconClassName} strokeWidth={1.75} />
      ) : progress.state === "failed" ? (
        <XCircle aria-hidden="true" className={iconClassName} strokeWidth={1.75} />
      ) : (
        <CalendarClock aria-hidden="true" className={iconClassName} strokeWidth={1.75} />
      )}
      <span>{progress.label}</span>
    </div>
  );
}

function ClosetCard({
  item,
  isAnalysisBusy,
  isConfirmationBusy,
  isDisplayBusy,
  isDeleting,
  isAnalysisQueued,
  onRetryDisplayImage,
  onRetryAnalysis,
  onDeleteItem,
  onImageLoad,
}: {
  item: ClothingItem;
  isAnalysisBusy: boolean;
  isConfirmationBusy: boolean;
  isDisplayBusy: boolean;
  isDeleting: boolean;
  isAnalysisQueued: boolean;
  onRetryDisplayImage: (item: ClothingItem) => Promise<void>;
  onRetryAnalysis: (item: ClothingItem, userFeedback?: string) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
  onImageLoad: ClosetImageLoadHandler;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tagDetailsExpanded, setTagDetailsExpanded] = useState(false);
  const [tagPreviewVisible, setTagPreviewVisible] = useState(false);
  const displayReady = Boolean(item.displayImageUrl);
  const displayedImageUrl =
    showOriginal && item.originalImageUrl
      ? item.originalImageUrl
      : item.displayImageUrl ?? item.originalImageUrl ?? item.imageUrl;
  const displayStatus = item.displayImageStatus ?? "not_started";
  const itemInteractionBusy = isAnalysisBusy || isConfirmationBusy || isDeleting;
  const itemDestructiveBusy =
    itemInteractionBusy || isDisplayBusy || displayStatus === "processing";
  const qualityFlags = filterLegacyDisplayImageFlags(item.imageQualityFlags);
  const analysisInProgress = qualityFlags.includes("closet_analysis_processing");
  const analysisFailed = qualityFlags.includes("closet_analysis_failed");
  const pendingAi =
    analysisInProgress ||
    item.styleTags.includes("待识别") ||
    item.styleTags.includes("AI 识别中") ||
    item.category === "待识别" ||
    item.category === "识别中";
  const needsConfirmation =
    !item.userCorrected && (qualityFlags.includes("needs_ai_label_confirmation") || !pendingAi);
  const confidenceLabel =
    typeof item.aiConfidence === "number" ? `${Math.round(item.aiConfidence * 100)}%` : undefined;
  const cardTags = Array.from(new Set([...item.styleTags, ...item.scenarioTags].filter(Boolean)));
  const visibleCardTags = cardTags.slice(0, 4);
  const hiddenCardTags = cardTags.slice(visibleCardTags.length);
  const hiddenCardTagCount = cardTags.length - visibleCardTags.length;
  const tagDetailsId = `closet-card-tags-${item.id}`;
  const cardTagClassName =
    "inline-flex h-7 items-center justify-center rounded-full bg-[#f8efea] px-2.5 text-xs leading-none text-[#8b6258]";
  const statusLabel =
    item.wearFrequency === "often"
      ? "常穿"
      : item.wearFrequency === "sometimes"
        ? "偶尔穿"
        : item.wearFrequency === "rarely"
          ? "闲置"
          : "待确认";
  return (
    <article className="group rounded-[14px] border border-[#ead9d0] bg-[#fffdfb] p-3 transition hover:-translate-y-0.5 hover:border-[#76576f]/40 hover:shadow-[0_14px_30px_rgba(45,43,50,0.08)]">
      <div className="relative">
        {displayedImageUrl ? (
          <ClosetItemImage
            itemId={item.id}
            imageUrl={displayedImageUrl}
            className="aspect-square w-full"
            onImageLoad={onImageLoad}
          />
        ) : (
          <MockProductImage palette={item.palette} className="aspect-square w-full" />
        )}
        <span className="absolute right-2 top-2 rounded-full bg-white/90 px-3 py-1 text-xs text-[#6e5148] shadow">
          {statusLabel}
        </span>
        {displayReady && item.originalImageUrl ? (
          <button
            onClick={() => setShowOriginal((current) => !current)}
            className="absolute left-2 top-2 rounded-full bg-[#3d281f]/80 px-3 py-1 text-xs text-white shadow transition hover:bg-[#3d281f]"
          >
            {showOriginal ? "展示图" : "原图"}
          </button>
        ) : (
          <span className="absolute left-2 top-2 rounded-full bg-[#3d281f]/80 px-3 py-1 text-xs text-white shadow">
            原图
          </span>
        )}
        <button
          type="button"
          aria-label="打开衣服操作菜单"
          onClick={() => setMenuOpen((current) => !current)}
          className="absolute right-2 top-12 rounded-full bg-white p-2 text-[#8b6258] shadow transition hover:bg-[#fbf5f1] hover:text-[#6e3f3f]"
        >
          <MoreHorizontal className="size-4" />
        </button>
        {menuOpen && (
          <div className="absolute right-2 top-[5.25rem] z-20 w-44 rounded-[12px] border border-[#ead9d0] bg-white p-1.5 text-sm text-[#6e5148] shadow-xl shadow-stone-200/70">
            <button
              type="button"
              disabled={itemDestructiveBusy || !item.originalImageUrl}
              onClick={() => {
                setMenuOpen(false);
                void onRetryDisplayImage(item);
              }}
              className="flex w-full items-center gap-2 rounded-[9px] px-3 py-2 text-left transition hover:bg-[#fbf5f1] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles className="size-4" />
              重新生成展示图
            </button>
            <button
              type="button"
              disabled={itemInteractionBusy || !item.originalImageUrl}
              onClick={() => {
                setMenuOpen(false);
                const feedback = window.prompt(
                  "第一次识别哪里不准确？可以写一句给 AI 的调整要求。",
                  "",
                );
                if (feedback !== null) {
                  void onRetryAnalysis(item, feedback.trim() || undefined);
                }
              }}
              className="flex w-full items-center gap-2 rounded-[9px] px-3 py-2 text-left transition hover:bg-[#fbf5f1] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Pencil className="size-4" />
              {isAnalysisQueued ? "识别排队中" : analysisInProgress ? "正在识别" : "重新识别标签"}
            </button>
            <button
              type="button"
              disabled={itemDestructiveBusy}
              onClick={() => {
                setMenuOpen(false);
                void onDeleteItem(item);
              }}
              className="flex w-full items-center gap-2 rounded-[9px] px-3 py-2 text-left text-[#b14545] transition hover:bg-[#fff0ef] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="size-4" />
              删除单品
            </button>
          </div>
        )}
      </div>
      <h3 className="mt-3 font-semibold text-[#3d281f]">{item.name}</h3>
      {(displayStatus !== "ready" || pendingAi || analysisFailed || needsConfirmation) && (
        <div className="mt-3 rounded-[10px] bg-[#fff7f4] px-3 py-2 text-xs leading-5 text-[#9a514f]">
          {closetDisplayStatusLabels[displayStatus]} ·{" "}
          {isAnalysisQueued
            ? "AI 标签排队中"
            : analysisInProgress
              ? "AI 标签识别中"
              : analysisFailed
                ? "AI 标签识别失败"
                : needsConfirmation
                  ? `AI 已识别，待确认${confidenceLabel ? ` · 置信度 ${confidenceLabel}` : ""}`
                  : "AI 标签已确认"}
        </div>
      )}
      {visibleCardTags.length > 0 && (
        <div className="mt-3">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
            {visibleCardTags.map((tag) => (
              <span
                key={tag}
                title={tag}
                className={cn(cardTagClassName, "min-w-0 flex-1 truncate")}
              >
                {tag}
              </span>
            ))}
            {hiddenCardTagCount > 0 && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  aria-expanded={tagDetailsExpanded}
                  aria-controls={tagDetailsId}
                  aria-label={`查看其余 ${hiddenCardTagCount} 个标签`}
                  onMouseEnter={() => setTagPreviewVisible(true)}
                  onMouseLeave={() => setTagPreviewVisible(false)}
                  onFocus={() => setTagPreviewVisible(true)}
                  onBlur={() => setTagPreviewVisible(false)}
                  onClick={() => setTagDetailsExpanded((current) => !current)}
                  className="rounded-full bg-[#f1e9e4] px-2.5 py-1 text-xs font-medium text-[#795d6e] transition hover:bg-[#eadfd8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#b47b99]/45"
                >
                  +{hiddenCardTagCount}
                </button>
                {tagPreviewVisible && !tagDetailsExpanded && (
                  <div
                    role="tooltip"
                    className="absolute bottom-full left-0 z-30 mb-2 w-60 rounded-[12px] border border-[#ead9d0] bg-white p-2.5 shadow-xl shadow-stone-200/70"
                  >
                    <div className="flex flex-wrap gap-1.5">
                      {hiddenCardTags.map((tag) => (
                        <span key={tag} className={cardTagClassName}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          {hiddenCardTagCount > 0 && tagDetailsExpanded && (
            <div id={tagDetailsId} className="mt-2 flex flex-wrap gap-1.5" aria-label="完整衣服标签">
              {hiddenCardTags.map((tag) => (
                <span key={tag} className={cardTagClassName}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function DecisionListView({
  filter,
  items,
  allItems,
  onFilterChange,
  onStatusChange,
  onDetailsChange,
  onOpenReport,
  onDeleteItems,
}: {
  filter: DecisionStatus | "all";
  items: DecisionItem[];
  allItems: DecisionItem[];
  onFilterChange: (filter: DecisionStatus | "all") => void;
  onStatusChange: (id: string, status: DecisionStatus) => Promise<void>;
  onDetailsChange: (
    id: string,
    patch: Partial<{ price: number | null; color: string; size: string }>,
  ) => void;
  onOpenReport: (item: DecisionItem) => void;
  onDeleteItems: (ids: string[]) => Promise<void>;
}) {
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isManageMode, setIsManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [dismissalCandidateId, setDismissalCandidateId] = useState<string | null>(null);
  const [isDismissing, setIsDismissing] = useState(false);
  const counts = {
    all: allItems.length,
    decided_to_buy: allItems.filter((item) => item.status === "decided_to_buy").length,
    saved_for_later: allItems.filter((item) => item.status === "saved_for_later").length,
  };

  async function handleDeleteSelected() {
    if (!selectedIds.length || isDeleting) return;
    setIsDeleting(true);
    await onDeleteItems(selectedIds);
    setSelectedIds([]);
    setIsManageMode(false);
    setIsDeleting(false);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id],
    );
  }

  async function confirmDismissal() {
    if (!dismissalCandidateId || isDismissing) return;
    setIsDismissing(true);
    await onStatusChange(dismissalCandidateId, "not_considering");
    setIsDismissing(false);
    setDismissalCandidateId(null);
  }

  return (
    <div className="view-scroll w-full overflow-y-auto p-4 sm:p-6 lg:p-7">
      <HeaderInline
        title="决策清单"
        subtitle="管理你咨询过的商品及决策状态，理性复盘，做出更好的购物选择。"
        actions={
          isManageMode ? (
            <>
              <button
                disabled={isDeleting}
                onClick={() => {
                  setSelectedIds([]);
                  setIsManageMode(false);
                }}
                className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-5 text-[#8b6258] disabled:cursor-not-allowed disabled:opacity-50"
              >
                取消
              </button>
              <button
                disabled={!selectedIds.length || isDeleting}
                onClick={() => void handleDeleteSelected()}
                className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-[#c75f60] px-5 font-medium text-white shadow-lg shadow-rose-200/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="size-4" />
                {isDeleting ? "删除中" : `确认删除${selectedIds.length ? ` ${selectedIds.length}` : ""}`}
              </button>
            </>
          ) : (
            <button
              onClick={() => setIsManageMode(true)}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-5 text-[#8b6258]"
            >
              管理清单
              <SlidersHorizontal className="size-4" />
            </button>
          )
        }
      />

      <div className="mt-5 flex flex-wrap gap-4">
        {[
          ["all", "全部", counts.all],
          ["decided_to_buy", "决定买", counts.decided_to_buy],
          ["saved_for_later", "先收藏", counts.saved_for_later],
        ].map(([id, label, count]) => (
          <button
            key={id}
            onClick={() => onFilterChange(id as DecisionStatus | "all")}
            className={cn(
              "h-11 rounded-[10px] border px-6 text-sm transition",
              filter === id
                ? "border-[#e5b9b0] bg-[#fbf0ec] text-[#c05c5d]"
                : "border-[#ead9d0] bg-white text-[#7b5b51]",
            )}
          >
            {label} <span className="ml-2 text-[#c05c5d]">{count}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        {items.length ? (
          items.map((item) => (
            <DecisionCard
              key={item.id}
              item={item}
              onStatusChange={(id, status) => {
                if (status === "not_considering") {
                  setDismissalCandidateId(id);
                  return;
                }
                void onStatusChange(id, status);
              }}
              onDetailsChange={onDetailsChange}
              onOpenReport={onOpenReport}
              onPreviewImage={setPreviewImageUrl}
              isManageMode={isManageMode}
              isSelected={selectedIds.includes(item.id)}
              onToggleSelected={() => toggleSelected(item.id)}
            />
          ))
        ) : (
          <div className="rounded-[16px] border border-dashed border-[#ead9d0] bg-[#fffaf7] p-10 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-[#fbf0ec] text-[#b2605e]">
              <ClipboardList className="size-6" />
            </div>
            <h3 className="mt-4 text-xl font-semibold text-[#3d281f]">暂无决策记录</h3>
            <p className="mx-auto mt-2 max-w-md leading-7 text-[#8b6258]">
              在决策报告中选择“决定买”或“先收藏”后，商品会出现在这里。
            </p>
          </div>
        )}
      </div>

      <p className="mt-8 text-center text-sm text-[#a08278]">
        理性消费，长期主义。每一次复盘，都是向更好的自己靠近一步。
      </p>

      {previewImageUrl && (
        <ImagePreviewDialog imageUrl={previewImageUrl} onClose={() => setPreviewImageUrl(null)} />
      )}
      {dismissalCandidateId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#241813]/45 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dismiss-decision-title"
          onClick={() => {
            if (!isDismissing) setDismissalCandidateId(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-[16px] border border-[#ead9d0] bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="dismiss-decision-title" className="text-xl font-semibold text-[#3d281f]">
              暂不考虑这件衣服？
            </h2>
            <p className="mt-3 leading-7 text-[#7b5b51]">
              确认后，这件衣服将从决策清单中删除。你仍可在对应聊天记录中查看完整分析。
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                disabled={isDismissing}
                onClick={() => setDismissalCandidateId(null)}
                className="h-10 rounded-[10px] border border-[#ead9d0] px-4 text-sm text-[#7b5b51] transition hover:bg-[#fbf3ef] disabled:cursor-not-allowed disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isDismissing}
                onClick={() => void confirmDismissal()}
                className="h-10 rounded-[10px] bg-[#c75f60] px-4 text-sm font-medium text-white transition hover:bg-[#ad4f50] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDismissing ? "处理中" : "确认暂不考虑"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionCard({
  item,
  onStatusChange,
  onDetailsChange,
  onOpenReport,
  onPreviewImage,
  isManageMode,
  isSelected,
  onToggleSelected,
}: {
  item: DecisionItem;
  onStatusChange: (id: string, status: DecisionStatus) => void;
  onDetailsChange: (
    id: string,
    patch: Partial<{ price: number | null; color: string; size: string }>,
  ) => void;
  onOpenReport: (item: DecisionItem) => void;
  onPreviewImage: (imageUrl: string) => void;
  isManageMode: boolean;
  isSelected: boolean;
  onToggleSelected: () => void;
}) {
  const StatusIcon = statusConfig[item.status].icon;
  return (
    <article
      className={cn(
        "relative rounded-[16px] border bg-white p-4 shadow-[0_14px_40px_rgba(92,55,42,0.05)] transition",
        isSelected ? "border-[#cf6f70] bg-[#fff7f4]" : "border-[#ead9d0]",
        isManageMode ? "pr-16" : "",
      )}
    >
      {isManageMode && (
        <button
          type="button"
          onClick={onToggleSelected}
          className={cn(
            "absolute right-5 top-5 flex size-9 items-center justify-center rounded-full border transition",
            isSelected
              ? "border-[#cf6f70] bg-[#cf6f70] text-white shadow-md shadow-rose-200/60"
              : "border-[#e5c6bd] bg-white text-[#c28b82] hover:bg-[#fbf0ec]",
          )}
          aria-label={isSelected ? "取消选择该清单项" : "选择该清单项"}
        >
          {isSelected && <Check className="size-5" />}
        </button>
      )}
      <div className="grid gap-5 lg:grid-cols-[293px_minmax(0,1fr)]">
        <div className="flex gap-4 xl:block">
          {item.imageUrl ? (
            <button
              type="button"
              onClick={() => onPreviewImage(item.imageUrl as string)}
              className="h-56 w-48 rounded-[12px] bg-white bg-contain bg-center bg-no-repeat text-left transition hover:scale-[1.01] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#cf6f70] xl:h-[277px] xl:w-full"
              style={{ backgroundImage: `url(${item.imageUrl})` }}
              aria-label="查看商品图片大图"
            />
          ) : (
            <MockProductImage palette={item.palette} className="h-56 w-48 xl:h-[277px] xl:w-full" />
          )}
          <div className="min-w-0 flex-1 xl:mt-4">
            <h3 className="line-clamp-2 text-lg font-semibold leading-7 text-[#3d281f]">
              {item.productName}
            </h3>
            <div className="mt-4 space-y-3">
              <EditableDecisionField
                label="价格"
                prefix="¥"
                value={item.priceKnown ? String(item.price) : ""}
                placeholder="价格"
                inputMode="decimal"
                muted={!item.priceKnown}
                size="price"
                onCommit={(value) =>
                  onDetailsChange(item.id, { price: parseDecisionPriceInput(value) })
                }
              />
              <button
                onClick={() => onOpenReport(item)}
                className="inline-flex items-center gap-1 text-sm font-medium text-[#b2605e] transition hover:text-[#8f4748]"
              >
                查看完整分析
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>
        </div>
        <div className="border-t border-[#f0e1da] pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <DecisionOutfitPreview item={item} onPreviewImage={onPreviewImage} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-[#f0e1da] pt-4">
        <span className="text-sm text-[#8b6258]">当前状态：</span>
        <span className={cn("inline-flex h-10 items-center gap-2 rounded-[10px] border px-4 text-sm", statusConfig[item.status].tone)}>
          <StatusIcon className="size-4" />
          {statusConfig[item.status].label}
        </span>
        {item.reminderAt && (
          <span className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-[#fbf0ec] px-4 text-sm text-[#8b6258]">
            <CalendarClock className="size-4" />
            {item.reminderAt}提醒复盘
          </span>
        )}
        <span className="ml-auto text-sm text-[#8b6258]">最近一次咨询时间：{item.lastAskedAt}</span>
        <div className="flex gap-2">
          {(Object.keys(statusConfig) as DecisionStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => onStatusChange(item.id, status)}
              className={cn(
                "rounded-[10px] border px-3 py-2 text-sm transition",
                status === item.status
                  ? statusConfig[status].tone
                  : "border-[#ead9d0] text-[#7b5b51] hover:bg-[#fbf3ef]",
              )}
            >
              {statusConfig[status].label}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

function ImagePreviewDialog({
  imageUrl,
  onClose,
}: {
  imageUrl: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#241813]/70 px-6 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="relative max-h-[88vh] w-full max-w-3xl rounded-[18px] bg-white p-3 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-full bg-white/90 px-3 py-1.5 text-sm text-[#6e5148] shadow-sm transition hover:bg-[#fbf3ef]"
        >
          关闭
        </button>
        <div
          className="h-[78vh] w-full rounded-[12px] bg-[#f8f3ef] bg-contain bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${imageUrl})` }}
        />
      </div>
    </div>
  );
}

function EditableDecisionField({
  label,
  value,
  placeholder,
  prefix,
  muted,
  inputMode,
  size = "normal",
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  prefix?: string;
  muted?: boolean;
  inputMode?: "none" | "text" | "tel" | "url" | "email" | "numeric" | "decimal" | "search";
  size?: "normal" | "price";
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  function commit() {
    if (draft.trim() !== value.trim()) {
      onCommit(draft.trim());
    }
  }

  return (
    <label className="block">
      <span className="text-xs text-[#a08278]">{label}</span>
      <span className="group mt-1 flex min-h-9 items-center border-b border-dashed border-[#ead9d0] pb-1 transition focus-within:border-[#d77a79] hover:border-[#d77a79]">
        {prefix && (
          <span
            className={cn(
              "mr-1 font-semibold",
              size === "price" ? "text-2xl" : "text-base",
              muted && !draft ? "text-[#b9a59d]" : "text-[#3d281f]",
            )}
          >
            {prefix}
          </span>
        )}
        <input
          value={draft}
          placeholder={placeholder}
          inputMode={inputMode}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className={cn(
            "min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#b9a59d]",
            muted && !draft ? "text-[#b9a59d]" : "text-[#3d281f]",
            size === "price" ? "text-2xl font-semibold" : "text-sm font-medium",
          )}
        />
      </span>
    </label>
  );
}

function DecisionOutfitPreview({
  item,
  onPreviewImage,
}: {
  item: DecisionItem;
  onPreviewImage: (imageUrl: string) => void;
}) {
  const outfits = item.outfitCombinations ?? [];
  const [activeIndex, setActiveIndex] = useState(0);

  if (!outfits.length) {
    return (
      <div>
        <p className="font-medium text-[#3d281f]">穿搭效果</p>
        <div className="mt-3 rounded-[14px] border border-dashed border-[#ead9d0] bg-[#fffaf7] p-5 text-sm leading-6 text-[#8b6258]">
          <span className="font-medium text-[#6e5148]">暂无真人效果</span>
          <br />这条历史记录保留了来源单品与搭配说明，可以点击完整分析回看当时的建议。
        </div>
      </div>
    );
  }

  const currentIndex = Math.min(activeIndex, outfits.length - 1);
  const outfit = outfits[currentIndex];

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-[#3d281f]">穿搭效果</p>
          <p className="mt-1 text-xs text-[#a08278]">
            第 {currentIndex + 1} / {outfits.length} 套 · {outfit.scenario || "日常搭配"}
          </p>
        </div>
        {outfits.length > 1 && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => setActiveIndex((index) => (index - 1 + outfits.length) % outfits.length)}
              className="rounded-full border border-[#ead9d0] px-3 py-1.5 text-xs text-[#8b6258] transition hover:bg-[#fbf3ef]"
            >
              上一套
            </button>
            <button
              onClick={() => setActiveIndex((index) => (index + 1) % outfits.length)}
              className="rounded-full border border-[#ead9d0] px-3 py-1.5 text-xs text-[#8b6258] transition hover:bg-[#fbf3ef]"
            >
              下一套
            </button>
          </div>
        )}
      </div>

      <div className="relative mt-3">
        {outfits.length > 1 && (
          <>
            <div className="absolute inset-x-3 -bottom-2 h-8 rounded-[14px] border border-[#ead9d0] bg-[#f8eee8]" />
            <div className="absolute inset-x-6 -bottom-4 h-8 rounded-[14px] border border-[#ead9d0] bg-[#f3e4dc]" />
          </>
        )}
        <div className="relative rounded-[14px] border border-[#ead9d0] bg-[#fffaf7] p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-[#3d281f]">{outfit.title}</p>
              <p className="mt-1 text-xs text-[#a08278]">{outfit.scenario}</p>
            </div>
          </div>

          {(() => {
            const tryOn = selectDecisionTryOnResult(item.tryOnResults, outfit.outfitId, currentIndex);
            const tryOnImageUrl = tryOn?.imageUrl;
            const sourceItems = (outfit.visualItems ?? []).filter(
              (visualItem) =>
                visualItem.name !== item.productName &&
                !/待买|候选|本次|商品/.test(`${visualItem.role ?? ""}${visualItem.badge ?? ""}`),
            );
            return (
              <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(180px,0.95fr)_minmax(220px,1.05fr)]">
                <div className="aspect-square overflow-hidden rounded-[12px] bg-white">
                  {hasDecisionTryOnImage(tryOn) && tryOnImageUrl ? (
                    <button
                      type="button"
                      onClick={() => onPreviewImage(tryOnImageUrl)}
                      className="h-full w-full bg-[#f3ebe5] bg-contain bg-center bg-no-repeat"
                      style={{ backgroundImage: `url(${tryOnImageUrl})` }}
                      aria-label={`查看方案 ${currentIndex + 1} 真人搭配大图`}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-[#9a8178]">
                      暂无真人效果
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2 lg:h-full lg:justify-between lg:gap-0">
                  <SourceDecisionItem
                    name={item.productName}
                    category="待买单品"
                    imageUrl={item.imageUrl}
                    role="待买单品"
                    onPreviewImage={onPreviewImage}
                  />
                  {sourceItems.slice(0, 3).map((visualItem) => (
              <div key={visualItem.id} className="rounded-[12px] bg-white p-2">
                <div className="flex gap-2">
                  {visualItem.imageUrl ? (
                    <button
                      type="button"
                      onClick={() => onPreviewImage(visualItem.imageUrl as string)}
                      className="h-20 w-16 shrink-0 rounded-[10px] bg-[#f3ebe5] bg-cover bg-center transition hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#cf6f70]"
                      style={{ backgroundImage: `url(${visualItem.imageUrl})` }}
                      aria-label={`查看${visualItem.name}大图`}
                    />
                  ) : (
                    <MockProductImage palette={getPaletteByColor(visualItem.name)} className="h-20 w-16 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="inline-flex rounded-full bg-[#fbf0ec] px-2 py-0.5 text-[11px] text-[#8b6258]">
                      {visualItem.role ?? visualItem.badge ?? "可搭单品"}
                    </span>
                    <p className="mt-1 truncate text-sm font-semibold text-[#3d281f]">
                      {visualItem.name}
                    </p>
                    <p className="text-xs text-[#8b6258]">{visualItem.category}</p>
                  </div>
                </div>
              </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {outfit.summary && (
            <p className="mt-3 rounded-[10px] bg-white px-3 py-2 text-xs leading-5 text-[#7b5b51]">
              {outfit.summary}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceDecisionItem({
  name,
  category,
  imageUrl,
  role,
  onPreviewImage,
}: {
  name: string;
  category: string;
  imageUrl?: string;
  role: string;
  onPreviewImage: (imageUrl: string) => void;
}) {
  return (
    <div className="flex gap-2 rounded-[12px] bg-white p-2">
      {imageUrl ? (
        <button
          type="button"
          onClick={() => onPreviewImage(imageUrl)}
          className="h-20 w-16 shrink-0 rounded-[10px] bg-[#f3ebe5] bg-contain bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${imageUrl})` }}
          aria-label={`查看${name}大图`}
        />
      ) : (
        <MockProductImage palette="from-[#c9a58e] to-[#f4ded4]" className="h-20 w-16 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className="inline-flex rounded-full bg-[#fbf0ec] px-2 py-0.5 text-[11px] text-[#8b6258]">{role}</span>
        <p className="mt-1 truncate text-sm font-semibold text-[#3d281f]">{name}</p>
        <p className="text-xs text-[#8b6258]">{category}</p>
      </div>
    </div>
  );
}

function SettingsView({
  user,
  profile,
  onSaveProfile,
  onSignOut,
}: {
  user: User;
  profile: UserProfile;
  onSaveProfile: (profile: UserProfile) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const styleTags = ["简约", "通勤", "韩系", "法式", "休闲", "运动", "甜美"];
  const scenarios = ["上班 / 通勤", "日常出街", "约会", "旅行", "运动健身", "居家"];
  const dislikes = ["紧身 / 勒身", "易皱", "透视", "厚重臃肿", "设计复杂"];
  const [heightCm, setHeightCm] = useState(profile.heightCm?.toString() ?? "");
  const [weightKg, setWeightKg] = useState(profile.weightKg?.toString() ?? "");
  const [selectedStyles, setSelectedStyles] = useState(profile.stylePreferences);
  const [selectedScenarios, setSelectedScenarios] = useState(profile.commonScenarios);
  const [selectedDislikes, setSelectedDislikes] = useState(profile.dislikedCategories);
  const [budgetSensitivity, setBudgetSensitivity] = useState<BudgetSensitivity>(
    profile.budgetSensitivity,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const parsedHeight = parseOptionalNumber(heightCm);
  const parsedWeight = parseOptionalNumber(weightKg);
  const bmi = calculateBmi(parsedHeight, parsedWeight);
  const incomplete = isProfileIncomplete({
    ...profile,
    heightCm: parsedHeight,
    weightKg: parsedWeight,
    bmi,
    bmiBand: getBmiBand(bmi),
    stylePreferences: selectedStyles,
    dislikedCategories: selectedDislikes,
    commonScenarios: selectedScenarios,
    budgetSensitivity,
  });

  async function handleSave() {
    setIsSaving(true);
    setSaveMessage("");

    try {
      await onSaveProfile({
        ...profile,
        heightCm: parsedHeight,
        weightKg: parsedWeight,
        bmi,
        bmiBand: getBmiBand(bmi),
        stylePreferences: selectedStyles,
        dislikedCategories: selectedDislikes,
        commonScenarios: selectedScenarios,
        budgetSensitivity,
      });
      setSaveMessage("个人档案已保存。");
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "保存失败，请稍后再试。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="view-scroll w-full overflow-y-auto p-4 sm:p-6 lg:p-7">
      <HeaderInline title="设置" subtitle="管理你的个人档案、穿衣偏好、预算与隐私设置" />

      {incomplete && (
        <div className="mt-5 rounded-[14px] border border-[#e5b9b0] bg-[#fff7f4] px-5 py-4 text-sm leading-7 text-[#8b6258]">
          为了让购买建议更贴近你，首次使用前请先完善身高、体重、风格偏好和常见场景。BMI 只用于版型与舒适度风险提示。
        </div>
      )}

      <section className="mt-5 rounded-[16px] border border-[#ead9d0] bg-white p-6">
        <div className="flex items-center gap-5">
          <Avatar className="size-20" />
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold text-[#3d281f]">当前账号</h2>
              <span className="rounded-full bg-[#fbf0ec] px-3 py-1 text-sm text-[#b2605e]">免费版</span>
            </div>
            <p className="mt-1 text-[#8b6258]">{user.email}</p>
            <p className="mt-1 text-sm text-[#7b5b51]">账号状态：<span className="text-emerald-700">正常</span></p>
          </div>
          <button className="ml-auto inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#e5b9b0] px-5 text-[#9a514f]">
            <Pencil className="size-4" />
            修改资料
          </button>
        </div>
      </section>

      <section className="mt-5 space-y-4">
        <SettingsPanel title="1. 个人档案">
          <div className="grid gap-4 md:grid-cols-4">
            <ProfileInput label="身高（cm）" value={heightCm} onChange={setHeightCm} />
            <ProfileInput label="体重（kg）" value={weightKg} onChange={setWeightKg} />
            <div>
              <span className="text-sm text-[#8b6258]">BMI</span>
              <div className="mt-2 flex h-12 items-center rounded-[10px] border border-[#ead9d0] bg-[#fbf5f1] px-4 text-emerald-700">
                {getBmiLabel(bmi)}
              </div>
            </div>
            <div className="rounded-[10px] border border-[#ead9d0] bg-[#fbf5f1] p-4 text-sm leading-6 text-[#8b6258]">
              BMI 仅作参考，不等同于体型评估标准。更重要的是健康与自我感受。
            </div>
          </div>
        </SettingsPanel>

        <SettingsPanel title="2. 风格偏好（可多选）">
          <ChipGroup items={styleTags} active={selectedStyles} onToggle={setSelectedStyles} />
        </SettingsPanel>

        <SettingsPanel title="3. 常见场景（可多选）">
          <ChipGroup items={scenarios} active={selectedScenarios} onToggle={setSelectedScenarios} />
        </SettingsPanel>

        <SettingsPanel title="4. 不喜欢的衣服类型（可多选）">
          <ChipGroup items={dislikes} active={selectedDislikes} onToggle={setSelectedDislikes} />
        </SettingsPanel>

        <SettingsPanel title="5. 预算敏感度">
          <div className="grid grid-cols-3 overflow-hidden rounded-[10px] border border-[#ead9d0] text-center text-sm text-[#8b6258]">
            {[
              { value: "low", label: "价格不敏感" },
              { value: "medium", label: "适中" },
              { value: "high", label: "较敏感" },
            ].map((item) => (
              <button
                key={item.value}
                onClick={() => setBudgetSensitivity(item.value as BudgetSensitivity)}
                className={cn(
                  "h-11",
                  item.value === budgetSensitivity &&
                    "bg-gradient-to-r from-[#cf6f70] to-[#e6a094] text-white",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </SettingsPanel>

        <SettingsPanel title="6. 数据与隐私">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-xl text-sm leading-7 text-[#7b5b51]">
              你的衣橱图片、购买截图等数据仅用于个人穿搭决策分析，不会用于广告或其他商业用途。
            </p>
            <div className="flex gap-3">
              <button className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-5 text-[#8b6258]">
                <Upload className="size-4" />
                导出数据
              </button>
              <button className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-5 text-[#8b6258]">
                <Trash2 className="size-4" />
                清除本地缓存
              </button>
            </div>
          </div>
        </SettingsPanel>

        {saveMessage && (
          <div className="rounded-[12px] border border-[#ead9d0] bg-[#fbf5f1] px-4 py-3 text-sm text-[#7b5b51]">
            {saveMessage}
          </div>
        )}

        <div className="flex gap-4">
          <button
            onClick={onSignOut}
            className="inline-flex h-12 w-60 items-center justify-center gap-2 rounded-[10px] border border-[#e5b9b0] text-[#9a514f]"
          >
            <LogOut className="size-4" />
            退出登录
          </button>
          <button
            disabled={isSaving}
            onClick={handleSave}
            className="ml-auto inline-flex h-12 w-80 items-center justify-center gap-2 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] text-white shadow-lg shadow-rose-200/70 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <CheckCircle2 className="size-5" />
            {isSaving ? "保存中..." : "保存设置"}
          </button>
        </div>
      </section>
    </div>
  );
}

function HeaderInline({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div>
        <h2 className="text-3xl font-semibold tracking-[-0.04em] text-[#3d281f] sm:text-4xl">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-[#8b6258] sm:text-base">{subtitle}</p>
      </div>
      <div className="ml-auto flex flex-wrap gap-3">{actions}</div>
    </div>
  );
}

function Composer({
  value,
  isAssessing,
  imageDataUrl,
  imageName,
  placeholder = composerPlaceholder,
  variant = "dock",
  onChange,
  onImageSelect,
  onClearImage,
  onSubmit,
}: {
  value: string;
  isAssessing: boolean;
  imageDataUrl?: string;
  imageName?: string;
  placeholder?: string;
  variant?: "dock" | "starter";
  onChange: (value: string) => void;
  onImageSelect: (file: File) => Promise<void>;
  onClearImage: () => void;
  onSubmit: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  async function handleImageChange(fileList: FileList | null) {
    const file = Array.from(fileList ?? []).find((currentFile) =>
      currentFile.type.startsWith("image/"),
    );
    if (!file) return;

    await onImageSelect(file);
    setIsDragOver(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (isAssessing) return;
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      setIsDragOver(true);
    }
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!isAssessing) {
      event.dataTransfer.dropEffect = "copy";
      setIsDragOver(true);
    }
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (isAssessing) return;
    void handleImageChange(event.dataTransfer.files);
  }

  return (
    <form
      className={cn(
        variant === "dock"
          ? "border-t border-[#f0e1da] px-4 py-4 sm:px-6 lg:px-7"
          : "mt-7",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative rounded-[16px] border bg-[#fffaf7] p-4 transition",
          variant === "starter" &&
            "bg-white shadow-[0_16px_44px_rgba(45,43,50,0.09)]",
          isDragOver
            ? "border-[#cf6f70] bg-[#fff4f1] shadow-[0_0_0_4px_rgba(207,111,112,0.12)]"
            : "border-[#ead9d0]",
        )}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-[14px] border border-dashed border-[#cf6f70] bg-white/80 text-sm font-medium text-[#b2605e] backdrop-blur-sm">
            松开即可上传这张衣服截图
          </div>
        )}
        {imageDataUrl && (
          <div className="mb-3 flex items-center gap-3 rounded-[12px] border border-[#ead9d0] bg-white p-2">
            <div
              className="h-16 w-14 rounded-[9px] bg-cover bg-center"
              style={{ backgroundImage: `url(${imageDataUrl})` }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[#50382f]">{imageName ?? "商品截图"}</p>
              <p className="mt-1 text-xs text-[#a08278]">会先识别商品，再和你的衣橱做检索比对</p>
            </div>
            <button
              type="button"
              disabled={isAssessing}
              onClick={onClearImage}
              className="rounded-full p-2 text-[#9a7468] transition hover:bg-[#fbf5f1] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="移除商品截图"
            >
              <XCircle className="size-5" />
            </button>
          </div>
        )}
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "w-full resize-none bg-transparent text-[#3d281f] outline-none placeholder:text-[#b99a91]",
            variant === "starter"
              ? "decision-starter-textarea h-16 border-0 text-base"
              : "h-14",
          )}
          placeholder={placeholder}
          disabled={isAssessing}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => void handleImageChange(event.target.files)}
          />
          <button
            type="button"
            disabled={isAssessing}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border border-[#ead9d0] bg-white px-3 text-sm text-[#8b6258] transition hover:bg-[#fbf5f1] disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
          >
            <ImagePlus className="size-4" />
            {imageDataUrl ? "更换截图" : "上传截图"}
          </button>
          <span className="order-3 w-full text-[11px] leading-5 text-[#b99a91] sm:order-none sm:w-auto sm:text-xs">
            支持拖拽图片到这里上传 · 内容由 AI 生成，仅供参考
          </span>
          <button
            disabled={isAssessing}
            className="ml-auto inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-[11px] bg-[#76576f] px-5 font-medium text-white shadow-[0_10px_24px_rgba(45,43,50,0.12)] transition hover:bg-[#62465c] disabled:cursor-not-allowed disabled:opacity-60 sm:h-12 sm:gap-3 sm:px-7"
          >
            <Send className="size-5" />
            {isAssessing ? "分析中" : "发送"}
          </button>
        </div>
      </div>
    </form>
  );
}

function MockProductImage({ palette, className }: { palette: string; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-[10px] bg-gradient-to-br", palette, className)}>
      <div className="absolute inset-x-[28%] bottom-3 top-6 rounded-t-full bg-white/45 blur-[1px]" />
      <div className="absolute inset-x-[34%] bottom-7 top-10 rounded-[18px] bg-white/35" />
      <div className="absolute bottom-3 left-1/2 h-20 w-[2px] -translate-x-1/2 bg-white/45" />
      <div className="absolute left-1/2 top-5 size-8 -translate-x-1/2 rounded-full bg-white/55" />
    </div>
  );
}

function MockThumb({ palette, className }: { palette: string; className?: string }) {
  return <div className={cn("rounded-[8px] bg-gradient-to-br shadow-inner", palette, className)} />;
}

function Avatar({ className }: { className?: string }) {
  return (
    <div className={cn("flex size-12 items-center justify-center rounded-full bg-[#76576f] text-white", className)}>
      <UserRound className="size-6" />
    </div>
  );
}

function ProfileInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm text-[#8b6258]">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-12 w-full rounded-[10px] border border-[#ead9d0] bg-white px-4 text-[#3d281f] outline-none transition focus:border-[#d58b82]"
      />
    </label>
  );
}

function SettingsPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[16px] border border-[#ead9d0] bg-white p-5 shadow-[0_8px_24px_rgba(45,43,50,0.035)]">
      <h3 className="mb-4 text-lg font-semibold text-[#3d281f]">{title}</h3>
      {children}
    </section>
  );
}

function ChipGroup({
  items,
  active,
  onToggle,
}: {
  items: string[];
  active: string[];
  onToggle: (items: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-4">
      {items.map((item) => {
        const selected = active.includes(item);
        return (
          <button
            key={item}
            onClick={() =>
              onToggle(
                selected
                  ? active.filter((activeItem) => activeItem !== item)
                  : [...active, item],
              )
            }
            className={cn(
              "inline-flex h-11 min-w-28 items-center justify-center gap-2 rounded-[10px] border px-5 text-sm",
              selected
                ? "border-[#e5b9b0] bg-[#f4dcd7] text-[#b2605e]"
                : "border-[#ead9d0] text-[#7b5b51]",
            )}
          >
            {selected && <Check className="size-4" />}
            {item}
          </button>
        );
      })}
    </div>
  );
}
