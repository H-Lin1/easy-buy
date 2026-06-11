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
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PurchaseDecisionReport } from "@/lib/ai/types";
import {
  closetItems as mockClosetItems,
  decisionItems as initialDecisionItems,
  outfitIdeas,
  recentChats,
  scoreItems,
} from "@/lib/mock-data";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type {
  AppView,
  BudgetSensitivity,
  ClothingItem,
  DecisionItem,
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
    tone: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  saved_for_later: {
    label: "先收藏",
    tone: "border-rose-200 bg-rose-50 text-rose-700",
    icon: Bookmark,
  },
  not_considering: {
    label: "暂不考虑",
    tone: "border-stone-200 bg-stone-50 text-stone-700",
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

const decisionProgressSteps = [
  "识别待买商品",
  "检索你的衣橱",
  "匹配可搭配单品",
  "检查重复购买风险",
  "补充穿搭灵感",
  "长期主义决策思考",
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
): Promise<ClothingItem> {
  const { data: originalImage } = await supabase.storage
    .from("closet-images")
    .createSignedUrl(row.image_path, 60 * 60);
  const { data: processedImage } = row.processed_image_path
    ? await supabase.storage
        .from("closet-images")
        .createSignedUrl(row.processed_image_path, 60 * 60)
    : { data: null };
  const { data: displayImage } = row.display_image_path
    ? await supabase.storage
        .from("closet-images")
        .createSignedUrl(row.display_image_path, 60 * 60)
    : { data: null };

  return {
    id: row.id,
    name: row.summary || row.category || "未命名衣服",
    category: row.category || "待识别",
    color: row.color || "待识别",
    fit: row.fit ?? "unknown",
    styleTags: row.style_tags?.length ? row.style_tags : ["待识别"],
    seasonTags: row.season ?? [],
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
    imageQualityFlags: row.image_quality_flags ?? [],
    aiConfidence: row.ai_confidence ?? undefined,
    userCorrected: row.user_corrected ?? false,
    embeddingText: row.embedding_text ?? undefined,
    summary: row.summary ?? undefined,
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
    seasonTags: item.seasonTags ?? [],
    wearFrequency: item.wearFrequency,
  };
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
  const flags = item.imageQualityFlags ?? [];
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

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) continue;
      await worker(item);
    }
  });

  await Promise.all(runners);
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
  const [decisionItems, setDecisionItems] = useState(initialDecisionItems);
  const [filter, setFilter] = useState<DecisionStatus | "all">("all");
  const [userClosetItems, setUserClosetItems] = useState<ClothingItem[]>([]);
  const [closetLoading, setClosetLoading] = useState(false);
  const [closetMessage, setClosetMessage] = useState("");
  const [confirmationHidden, setConfirmationHidden] = useState(false);
  const [deferredConfirmationIds, setDeferredConfirmationIds] = useState<string[]>([]);
  const [busyClosetItemIds, setBusyClosetItemIds] = useState<string[]>([]);
  const [queuedAnalysisItemIds, setQueuedAnalysisItemIds] = useState<string[]>([]);
  const analysisQueueRef = useRef<
    Array<{ item: ClothingItem; userFeedback?: string }>
  >([]);
  const activeAnalysisCountRef = useRef(0);
  const activeAnalysisIdsRef = useRef(new Set<string>());
  const queuedAnalysisIdsRef = useRef(new Set<string>());
  const busyItemCountsRef = useRef(new Map<string, number>());

  const loadProfile = useCallback(
    async (userId: string) => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

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
      setClosetLoading(true);
      setClosetMessage("");

      const { data, error } = await supabase
        .from("closet_items")
        .select(closetItemSelect)
        .eq("user_id", userId)
        .neq("status", "archived")
        .order("updated_at", { ascending: false });

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
      setUserClosetItems(mappedItems);
      setClosetLoading(false);
    },
    [supabase],
  );

  useEffect(() => {
    let active = true;

    async function loadSession() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;

      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        await Promise.all([
          loadProfile(data.session.user.id),
          loadClosetItems(data.session.user.id),
        ]);
      }
      setAuthLoading(false);
    }

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfile(session.user.id);
        loadClosetItems(session.user.id);
      } else {
        setProfile(null);
        setUserClosetItems([]);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadClosetItems, loadProfile, supabase]);

  const filteredDecisions = useMemo(() => {
    if (filter === "all") return decisionItems;
    return decisionItems.filter((item) => item.status === filter);
  }, [decisionItems, filter]);

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
    setUser(null);
    setProfile(null);
    setUserClosetItems([]);
    setBusyClosetItemIds([]);
    setQueuedAnalysisItemIds([]);
    activeAnalysisIdsRef.current.clear();
    queuedAnalysisIdsRef.current.clear();
    analysisQueueRef.current = [];
    setView("chat");
  }

  function markItemBusy(itemId: string, busy: boolean) {
    const counts = busyItemCountsRef.current;
    const currentCount = counts.get(itemId) ?? 0;

    if (busy) {
      counts.set(itemId, currentCount + 1);
    } else if (currentCount <= 1) {
      counts.delete(itemId);
    } else {
      counts.set(itemId, currentCount - 1);
    }

    setBusyClosetItemIds([...counts.keys()]);
  }

  function setAnalysisQueued(itemId: string, queued: boolean) {
    if (queued) {
      queuedAnalysisIdsRef.current.add(itemId);
    } else {
      queuedAnalysisIdsRef.current.delete(itemId);
    }

    setQueuedAnalysisItemIds([...queuedAnalysisIdsRef.current]);
  }

  function setAnalysisActive(itemId: string, active: boolean) {
    if (active) {
      activeAnalysisIdsRef.current.add(itemId);
    } else {
      activeAnalysisIdsRef.current.delete(itemId);
    }
  }

  function updateLocalItemFlags(itemId: string, add: string[], remove: string[] = []) {
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

      setAnalysisQueued(task.item.id, false);
      setAnalysisActive(task.item.id, true);
      markItemBusy(task.item.id, true);
      updateLocalItemFlags(
        task.item.id,
        ["closet_analysis_processing", "needs_ai_label_confirmation"],
        ["closet_analysis_queued", "closet_analysis_failed"],
      );
      activeAnalysisCountRef.current += 1;

      void runQueuedClosetAnalysis(task.item, task.userFeedback).finally(() => {
        setAnalysisActive(task.item.id, false);
        markItemBusy(task.item.id, false);
        activeAnalysisCountRef.current = Math.max(0, activeAnalysisCountRef.current - 1);
        processAnalysisQueue();
      });
    }
  }

  async function uploadClosetImages(files: File[]) {
    if (!user || files.length === 0) return;

    setClosetLoading(true);
    setClosetMessage("");

    try {
      setConfirmationHidden(false);
      setDeferredConfirmationIds([]);
      const createdItems: ClothingItem[] = [];
      const displayJobs: Array<{ item: ClothingItem; imageDataUrl: string }> = [];
      const analysisJobs: Array<{ item: ClothingItem; imageDataUrl: string; fileName: string }> = [];

      for (const file of files) {
        const imageDataUrl = await fileToDataUrl(file);
        const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const safeExtension = ["jpg", "jpeg", "png", "webp"].includes(extension)
          ? extension
          : "jpg";
        const imagePath = `${user.id}/${crypto.randomUUID()}.${safeExtension}`;

        const { error: uploadError } = await supabase.storage
          .from("closet-images")
          .upload(imagePath, file, {
            cacheControl: "3600",
            contentType: file.type,
            upsert: false,
          });

        if (uploadError) throw uploadError;

        const { data, error } = await supabase
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
              "display_image_queued",
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
          .single();

        if (error) throw error;
        const mappedItem = await mapClosetItemFromDb(supabase, data as ClosetItemRow);
        createdItems.push(mappedItem);
        displayJobs.push({ item: mappedItem, imageDataUrl });
        analysisJobs.push({ item: mappedItem, imageDataUrl, fileName: file.name });
      }

      setUserClosetItems((items) => [...createdItems, ...items]);
      setClosetMessage(
        `已上传 ${createdItems.length} 件衣服。正在并行生成展示图和识别衣服标签，原图已保留作为事实来源。`,
      );
      setClosetLoading(false);

      let displaySuccessCount = 0;
      let analysisSuccessCount = 0;
      await Promise.all([
        runWithConcurrency(displayJobs, 2, async (job) => {
          const result = await generateClosetDisplayImage(job.item, job.imageDataUrl);
          if (result.ok) displaySuccessCount += 1;
        }),
        runWithConcurrency(analysisJobs, 2, async (job) => {
          const result = await analyzeClosetItem(job.item, job.imageDataUrl, {
            fileName: job.fileName,
          });
          if (result.ok) analysisSuccessCount += 1;
        }),
      ]);

      if (displaySuccessCount === createdItems.length) {
        setClosetMessage(
          `已完成 ${createdItems.length} 件衣服的上传处理。${analysisSuccessCount} 件已识别标签，展示图优先显示，左上角可切回原图。`,
        );
      } else {
        setClosetMessage(
          `已上传 ${createdItems.length} 件衣服，其中 ${analysisSuccessCount} 件已识别标签、${displaySuccessCount} 件展示图生成完成。失败项可在卡片菜单中重试。`,
        );
      }
    } catch (error) {
      console.error(error);
      setClosetMessage(error instanceof Error ? error.message : "上传失败，请稍后再试。");
    } finally {
      setClosetLoading(false);
    }
  }

  async function generateClosetDisplayImage(item: ClothingItem, imageDataUrl: string) {
    markItemBusy(item.id, true);
    setUserClosetItems((items) =>
      items.map((currentItem) =>
        currentItem.id === item.id
          ? {
              ...currentItem,
              displayImageStatus: "processing",
              imageQualityFlags: mergeImageQualityFlags(
                currentItem.imageQualityFlags,
                ["display_image_processing", "needs_ai_label_confirmation"],
                ["display_image_queued", "display_image_failed"],
              ),
            }
          : currentItem,
      ),
    );

    try {
      if (!item.imagePath) {
        throw new Error("原图路径缺失，无法生成展示图。");
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("登录状态已过期，请重新登录。");

      const response = await fetch("/api/ai/generate-closet-display-image", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          closetItemId: item.id,
          imagePath: item.imagePath,
          imageDataUrl,
        }),
      });

      const result = (await response.json()) as {
        item?: ClosetItemRow;
        message?: string;
      };

      if (!response.ok || !result.item) {
        throw new Error(result.message ?? "展示图生成失败。");
      }

      const mappedItem = await mapClosetItemFromDb(supabase, result.item);
      setUserClosetItems((items) =>
        items.map((currentItem) => (currentItem.id === mappedItem.id ? mappedItem : currentItem)),
      );
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "展示图生成失败。";
      console.error(error);
      setUserClosetItems((items) =>
        items.map((currentItem) =>
          currentItem.id === item.id
            ? {
                ...currentItem,
                displayImageStatus: "failed",
                imageQualityFlags: mergeImageQualityFlags(
                  currentItem.imageQualityFlags,
                  ["display_image_failed", "needs_ai_label_confirmation"],
                  ["display_image_queued", "display_image_processing", "display_image_ready"],
                ),
              }
            : currentItem,
        ),
      );
      return { ok: false, message };
    } finally {
      markItemBusy(item.id, false);
    }
  }

  async function analyzeClosetItem(
    item: ClothingItem,
    originalImageDataUrl: string,
    options: { displayImageDataUrl?: string; fileName?: string; userFeedback?: string } = {},
  ) {
    markItemBusy(item.id, true);
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

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("登录状态已过期，请重新登录。");

      const response = await fetch("/api/ai/analyze-closet-item", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          closetItemId: item.id,
          imagePath: item.imagePath,
          originalImageDataUrl,
          displayImageDataUrl: options.displayImageDataUrl,
          fileName: options.fileName ?? item.name,
          userFeedback: options.userFeedback,
        }),
      });

      const result = (await response.json()) as {
        item?: ClosetItemRow;
        message?: string;
      };

      if (!response.ok || !result.item) {
        throw new Error(result.message ?? "衣服识别失败。");
      }

      const mappedItem = await mapClosetItemFromDb(supabase, result.item);
      setUserClosetItems((items) =>
        items.map((currentItem) => (currentItem.id === mappedItem.id ? mappedItem : currentItem)),
      );
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "衣服识别失败。";
      console.error(error);
      setUserClosetItems((items) =>
        items.map((currentItem) =>
          currentItem.id === item.id
            ? {
                ...currentItem,
                category: currentItem.category === "识别中" ? "待识别" : currentItem.category,
                styleTags:
                  currentItem.styleTags[0] === "AI 识别中" ? ["待识别"] : currentItem.styleTags,
                imageQualityFlags: mergeImageQualityFlags(
                  currentItem.imageQualityFlags,
                  ["closet_analysis_failed", "needs_ai_label_confirmation"],
                  ["closet_analysis_queued", "closet_analysis_processing"],
                ),
              }
            : currentItem,
        ),
      );
      return { ok: false, message };
    } finally {
      markItemBusy(item.id, false);
    }
  }

  async function retryClosetDisplayImage(item: ClothingItem) {
    try {
      if (!item.originalImageUrl) {
        throw new Error("原图暂不可用，无法重新生成展示图。");
      }

      setClosetMessage("正在重新生成展示图，原图仍会保留。");

      const imageDataUrl = await fetchImageAsDataUrl(item.originalImageUrl);
      const result = await generateClosetDisplayImage(item, imageDataUrl);

      setClosetMessage(
        result.ok
          ? "展示图已重新生成。卡片默认会优先显示展示图，也可以切回原图。"
          : `展示图重新生成失败：${result.message}`,
      );
    } catch (error) {
      console.error(error);
      setClosetMessage(error instanceof Error ? error.message : "展示图重新生成失败。");
    }
  }

  async function retryClosetAnalysis(item: ClothingItem, userFeedback?: string) {
    if (queuedAnalysisIdsRef.current.has(item.id) || activeAnalysisIdsRef.current.has(item.id)) {
      setClosetMessage(`「${item.name}」已经在识别队列中。`);
      return;
    }

    if (!item.originalImageUrl) {
      setClosetMessage("原图暂不可用，无法重新识别衣服标签。");
      return;
    }

    analysisQueueRef.current.push({ item, userFeedback });
    setAnalysisQueued(item.id, true);
    updateLocalItemFlags(
      item.id,
      ["closet_analysis_queued", "needs_ai_label_confirmation"],
      ["closet_analysis_failed", "closet_analysis_processing"],
    );
    setClosetMessage(`已将「${item.name}」加入重新识别队列。`);
    processAnalysisQueue();
  }

  async function runQueuedClosetAnalysis(item: ClothingItem, userFeedback?: string) {
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
      let displayImageDataUrl: string | undefined;

      if (item.displayImageUrl) {
        try {
          displayImageDataUrl = await fetchImageAsDataUrl(item.displayImageUrl);
        } catch {
          displayImageDataUrl = undefined;
        }
      }

      const result = await analyzeClosetItem(item, originalImageDataUrl, {
        displayImageDataUrl,
        fileName: item.name,
        userFeedback,
      });

      setClosetMessage(
        result.ok
          ? "衣服标签已重新识别。请在后续确认流程中检查并修正细节。"
          : `衣服标签重新识别失败：${result.message}`,
      );
    } catch (error) {
      console.error(error);
      setClosetMessage(error instanceof Error ? error.message : "衣服标签重新识别失败。");
    }
  }

  async function deleteClosetItem(item: ClothingItem) {
    const confirmed = window.confirm(`确定删除「${item.name}」吗？原图和展示图也会尽量一起清理。`);
    if (!confirmed) return;

    markItemBusy(item.id, true);
    setClosetMessage("");

    try {
      const { error } = await supabase.from("closet_items").delete().eq("id", item.id);
      if (error) throw error;

      const paths = [
        item.imagePath,
        item.processedImagePath,
        item.displayImagePath,
      ].filter((path): path is string => Boolean(path));

      if (paths.length) {
        const { error: removeError } = await supabase.storage.from("closet-images").remove(paths);
        if (removeError) {
          console.warn("[closet-delete] storage cleanup failed", removeError.message);
        }
      }

      setUserClosetItems((items) => items.filter((currentItem) => currentItem.id !== item.id));
      setClosetMessage(`已删除「${item.name}」。`);
    } catch (error) {
      console.error(error);
      setClosetMessage(error instanceof Error ? error.message : "删除失败，请稍后再试。");
    } finally {
      markItemBusy(item.id, false);
    }
  }

  async function confirmClosetItemOnServer(item: ClothingItem, draft: ClosetConfirmationDraft) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("登录状态已过期，请重新登录。");

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

    return mapClosetItemFromDb(supabase, result.item);
  }

  async function confirmClosetItem(item: ClothingItem, draft: ClosetConfirmationDraft) {
    markItemBusy(item.id, true);
    setClosetMessage("");

    try {
      const mappedItem = await confirmClosetItemOnServer(item, draft);
      setUserClosetItems((items) =>
        items.map((currentItem) => (currentItem.id === mappedItem.id ? mappedItem : currentItem)),
      );
      setClosetMessage(`已确认「${mappedItem.name}」的衣橱标签，并写入搭配检索向量。`);
    } catch (error) {
      console.error(error);
      setClosetMessage(error instanceof Error ? error.message : "确认保存失败，请稍后再试。");
    } finally {
      markItemBusy(item.id, false);
    }
  }

  async function confirmHighConfidenceClosetItems(items: ClothingItem[]) {
    const targetItems = items.filter((item) => {
      const confidence = item.aiConfidence ?? 0;
      return confidence >= 0.8 && !(item.imageQualityFlags ?? []).includes("closet_analysis_failed");
    });

    if (!targetItems.length) {
      setClosetMessage("暂无可批量确认的高置信度衣服，请先逐件检查。");
      return;
    }

    targetItems.forEach((item) => markItemBusy(item.id, true));
    setClosetMessage("");

    try {
      const updatedItems = await Promise.all(
        targetItems.map(async (item) => {
          const draft = createConfirmationDraft(item);
          return confirmClosetItemOnServer(item, draft);
        }),
      );

      const updatedById = new Map(updatedItems.map((item) => [item.id, item]));
      setUserClosetItems((items) =>
        items.map((item) => updatedById.get(item.id) ?? item),
      );
      setClosetMessage(`已批量确认 ${updatedItems.length} 件高置信度衣服，并写入搭配检索向量。`);
    } catch (error) {
      console.error(error);
      setClosetMessage(error instanceof Error ? error.message : "批量确认失败，请稍后再试。");
    } finally {
      targetItems.forEach((item) => markItemBusy(item.id, false));
    }
  }

  function updateDecisionStatus(id: string, status: DecisionStatus) {
    setDecisionItems((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              status,
              reminderAt: status === "saved_for_later" ? "24 小时后" : undefined,
            }
          : item,
      ),
    );
  }

  if (authLoading) {
    return <LoadingScreen />;
  }

  if (!user) {
    return <AuthView />;
  }

  const activeView = profile && isProfileIncomplete(profile) ? "settings" : view;

  return (
    <main className="min-h-screen bg-[#f6f0eb] p-3 text-stone-800 md:p-4">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1600px] gap-4">
        <Sidebar currentView={activeView} user={user} onViewChange={setView} />
        <section className="flex min-w-0 flex-1 overflow-hidden rounded-[18px] border border-[#ead9d0] bg-[#fffdfb] shadow-[0_18px_60px_rgba(92,55,42,0.08)]">
          {activeView === "chat" && (
            <ChatView
              profile={profile ?? createEmptyProfile(user.id)}
              onOpenDecisions={() => setView("decisions")}
              onDecision={(status) => updateDecisionStatus("decision-1", status)}
            />
          )}
          {activeView === "closet" && (
            <ClosetView
              items={userClosetItems}
              isLoading={closetLoading}
              message={closetMessage}
              confirmationHidden={confirmationHidden}
              deferredConfirmationIds={deferredConfirmationIds}
              busyItemIds={busyClosetItemIds}
              queuedAnalysisItemIds={queuedAnalysisItemIds}
              onUploadImages={uploadClosetImages}
              onConfirmItem={confirmClosetItem}
              onConfirmHighConfidence={confirmHighConfidenceClosetItems}
              onHideConfirmations={() => setConfirmationHidden(true)}
              onDeferConfirmation={(itemId) =>
                setDeferredConfirmationIds((ids) => Array.from(new Set([...ids, itemId])))
              }
              onRetryDisplayImage={retryClosetDisplayImage}
              onRetryAnalysis={retryClosetAnalysis}
              onDeleteItem={deleteClosetItem}
            />
          )}
          {activeView === "decisions" && (
            <DecisionListView
              filter={filter}
              items={filteredDecisions}
              allItems={decisionItems}
              onFilterChange={setFilter}
              onStatusChange={updateDecisionStatus}
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

function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f0eb] text-[#6e5148]">
      <div className="rounded-[18px] border border-[#ead9d0] bg-[#fffdfb] px-8 py-6 shadow-[0_18px_60px_rgba(92,55,42,0.08)]">
        正在进入衣服购买决策助手...
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
    <main className="min-h-screen bg-[#f6f0eb] p-4 text-stone-800">
      <div className="mx-auto grid min-h-[calc(100vh-2rem)] max-w-6xl overflow-hidden rounded-[22px] border border-[#ead9d0] bg-[#fffdfb] shadow-[0_18px_60px_rgba(92,55,42,0.08)] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="flex flex-col justify-between bg-gradient-to-br from-[#fbf5f1] to-[#f2dfd8] p-10">
          <div>
            <div className="flex size-16 items-center justify-center rounded-full bg-gradient-to-br from-[#bf6d6b] to-[#e7b5a7] text-white shadow-lg shadow-rose-200/60">
              <Shirt className="size-8" />
            </div>
            <h1 className="mt-8 text-5xl font-semibold leading-tight text-[#3d281f]">
              衣服购买决策助手
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-[#7b5b51]">
              用长期主义帮你判断一件衣服是否真的适合自己：能不能搭、会不会重复、是否有真实场景，以及是否值得现在买。
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {["降低冲动消费", "提高衣橱利用率", "沉淀个人风格"].map((item) => (
              <div key={item} className="rounded-[14px] border border-white/70 bg-white/55 p-4 text-[#6e5148]">
                <CheckCircle2 className="mb-3 size-5 text-[#b2605e]" />
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
            <h2 className="text-3xl font-semibold text-[#3d281f]">
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
              className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] font-medium text-white shadow-lg shadow-rose-200/70 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? "处理中..." : mode === "login" ? "登录" : "注册"}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode((currentMode) => (currentMode === "login" ? "signup" : "login"));
                setMessage("");
              }}
              className="mt-4 w-full text-sm text-[#9a514f]"
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

function Sidebar({
  currentView,
  user,
  onViewChange,
}: {
  currentView: AppView;
  user: User;
  onViewChange: (view: AppView) => void;
}) {
  const navItems = [
    { id: "chat" as const, label: "决策聊天", count: 12, icon: MessageCircle },
    { id: "closet" as const, label: "衣橱", count: 28, icon: Shirt },
    { id: "decisions" as const, label: "决策清单", count: 8, icon: ClipboardList },
    { id: "settings" as const, label: "设置", icon: Settings },
  ];

  return (
    <aside className="hidden w-[342px] shrink-0 flex-col rounded-[18px] border border-[#ead9d0] bg-[#fffdfb]/92 p-7 shadow-[0_18px_60px_rgba(92,55,42,0.08)] lg:flex">
      <div className="flex items-center gap-4">
        <div className="flex size-16 items-center justify-center rounded-full bg-gradient-to-br from-[#bf6d6b] to-[#e7b5a7] text-white shadow-lg shadow-rose-200/60">
          <Shirt className="size-8" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-[#3d281f]">衣服购买决策助手</h1>
          <p className="mt-1 text-sm text-[#9a7468]">理性决策 · 长期主义</p>
        </div>
      </div>

      <button
        onClick={() => onViewChange("chat")}
        className="mt-8 flex h-14 items-center justify-center gap-3 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] text-base font-medium text-white shadow-lg shadow-rose-200/70 transition hover:scale-[1.01]"
      >
        <Sparkles className="size-5" />
        新建决策对话
      </button>

      <nav className="mt-7 space-y-3">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "flex h-14 w-full items-center gap-4 rounded-[10px] px-4 text-left text-[17px] transition",
                active
                  ? "bg-[#f4e8e3] text-[#a9514f]"
                  : "text-[#6e5148] hover:bg-[#f8efea]",
              )}
            >
              <Icon className="size-5" />
              <span className="flex-1">{item.label}</span>
              {typeof item.count === "number" && (
                <span className="rounded-full bg-[#f4e8e3] px-3 py-1 text-sm text-[#b2605e]">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-7 border-t border-[#ead9d0] pt-6">
        <p className="mb-4 text-sm text-[#a08278]">最近对话</p>
        <div className="space-y-4">
          {recentChats.map((chat) => (
            <button
              key={chat.id}
              onClick={() => onViewChange("chat")}
              className="flex w-full items-center gap-3 rounded-[10px] p-1.5 text-left transition hover:bg-[#f8efea]"
            >
              <MockThumb palette={chat.palette} className="size-14" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium text-[#50382f]">{chat.title}</p>
                <p className="mt-1 truncate text-xs text-[#a08278]">{chat.subtitle}</p>
              </div>
              {chat.favorite && <Star className="size-4 fill-[#d58883] text-[#d58883]" />}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-auto rounded-[12px] border border-[#ead9d0] bg-[#fbf5f1] p-4">
        <div className="flex items-center gap-3">
          <Avatar />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-[#50382f]">{user.email ?? "当前用户"}</p>
            <p className="text-sm text-[#a08278]">已登录</p>
          </div>
          <ChevronRight className="size-5 text-[#9a7468]" />
        </div>
      </div>
    </aside>
  );
}

function ChatView({
  profile,
  onOpenDecisions,
  onDecision,
}: {
  profile: UserProfile;
  onOpenDecisions: () => void;
  onDecision: (status: DecisionStatus) => void;
}) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [message, setMessage] = useState("这件米色西装外套适合我通勤穿吗？价格 399，值得买吗？");
  const [lastUserMessage, setLastUserMessage] = useState(message);
  const [purchaseImageDataUrl, setPurchaseImageDataUrl] = useState<string | undefined>();
  const [purchaseImageName, setPurchaseImageName] = useState<string | undefined>();
  const [assessment, setAssessment] = useState<PurchaseDecisionReport | null>(null);
  const [isAssessing, setIsAssessing] = useState(false);
  const [decisionProgressIndex, setDecisionProgressIndex] = useState(0);
  const [error, setError] = useState("");
  const progressSteps = useMemo(
    () => [
      purchaseImageDataUrl ? "识别待买商品截图" : "整理待买商品信息",
      ...decisionProgressSteps.slice(1),
    ],
    [purchaseImageDataUrl],
  );

  useEffect(() => {
    if (!isAssessing) return;

    const interval = window.setInterval(() => {
      setDecisionProgressIndex((index) => Math.min(index + 1, progressSteps.length - 1));
    }, 4500);

    return () => window.clearInterval(interval);
  }, [isAssessing, progressSteps.length]);

  async function handleSubmit() {
    const trimmedMessage = message.trim();
    if ((!trimmedMessage && !purchaseImageDataUrl) || isAssessing) return;

    setLastUserMessage(trimmedMessage);
    setIsAssessing(true);
    setDecisionProgressIndex(0);
    setAssessment(null);
    setError("");

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("登录状态已过期，请重新登录。");

      const response = await fetch("/api/ai/assess-purchase", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: trimmedMessage,
          imageDataUrl: purchaseImageDataUrl,
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
        throw new Error("AI 决策接口暂时不可用，请稍后再试。");
      }

      const assessmentData = (await response.json()) as { report: PurchaseDecisionReport };
      setAssessment(assessmentData.report);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "生成报告失败");
    } finally {
      setIsAssessing(false);
    }
  }

  return (
    <div className="flex w-full flex-col">
      <Header
        title="决策聊天"
        subtitle="结合你的衣橱和偏好，给出理性的购买建议"
        action={
          <button className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-4 text-sm text-[#8b6258] transition hover:bg-[#fbf3ef]">
            <Trash2 className="size-4" />
            清空对话
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto px-7 pb-6">
        <div className="ml-auto mt-2 flex max-w-[520px] items-start gap-3">
          <div className="rounded-[14px] bg-[#f2dfd8] px-5 py-3 text-[#4c342d]">
            {lastUserMessage || "我想判断这件衣服是否值得买。"}
            {purchaseImageDataUrl && (
              <div
                className="mt-3 h-28 w-24 rounded-[10px] bg-cover bg-center shadow-inner"
                style={{ backgroundImage: `url(${purchaseImageDataUrl})` }}
              />
            )}
          </div>
          <Avatar />
        </div>

        <div className="mt-8 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-[#c85c64] to-[#e6aaa0] text-2xl font-semibold text-white">
            A
          </div>
          <div>
            <p className="font-medium text-[#50382f]">衣服购买决策助手 AI</p>
            <p className="text-xs text-[#a08278]">10:23</p>
          </div>
        </div>

        <div className="mt-5 rounded-[14px] border border-[#ead9d0] bg-[#fffaf7] p-4">
          <div className="flex flex-wrap gap-3">
            {progressSteps.map((item, index) => {
              const completed = assessment && !isAssessing ? true : index < decisionProgressIndex;
              const active = isAssessing && index === decisionProgressIndex;
              return (
                <span
                  key={item}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition",
                    completed
                      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                      : active
                        ? "border-[#e9beb6] bg-[#fff0ec] text-[#a9514f]"
                        : "border-[#ead9d0] bg-white text-[#a08278]",
                  )}
                >
                  {completed ? (
                    <Check className="size-4" />
                  ) : active ? (
                    <Sparkles className="size-4" />
                  ) : (
                    <span className="size-2 rounded-full bg-[#d9c7bf]" />
                  )}
                  {item}
                </span>
              );
            })}
          </div>
          {isAssessing && (
            <p className="mt-3 text-sm leading-6 text-[#8b6258]">
              决策模型会结合衣橱证据做更完整的推理，最后一步可能需要几十秒，请稍等。
            </p>
          )}
        </div>

        {error && (
          <div className="mt-5 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <DecisionReportCard
          assessment={assessment}
          isAssessing={isAssessing}
          candidateImageDataUrl={purchaseImageDataUrl}
          onDecision={onDecision}
          onOpenDecisions={onOpenDecisions}
        />
      </div>

      <Composer
        isAssessing={isAssessing}
        value={message}
        imageDataUrl={purchaseImageDataUrl}
        imageName={purchaseImageName}
        onChange={setMessage}
        onImageSelect={async (file) => {
          setPurchaseImageDataUrl(await fileToDataUrl(file));
          setPurchaseImageName(file.name);
        }}
        onClearImage={() => {
          setPurchaseImageDataUrl(undefined);
          setPurchaseImageName(undefined);
        }}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

function DecisionReportCard({
  assessment,
  isAssessing,
  candidateImageDataUrl,
  onDecision,
  onOpenDecisions,
}: {
  assessment: PurchaseDecisionReport | null;
  isAssessing: boolean;
  candidateImageDataUrl?: string;
  onDecision: (status: DecisionStatus) => void;
  onOpenDecisions: () => void;
}) {
  const reportScoreItems = assessment
    ? [
        { label: "衣橱适配度", value: assessment.scores.wardrobeFit },
        { label: "搭配潜力", value: assessment.scores.outfitPotential },
        { label: "重复购买风险", value: assessment.scores.duplicateRisk },
        { label: "风格一致性", value: assessment.scores.styleConsistency },
        { label: "价格与使用频率", value: assessment.scores.priceValue },
        { label: "体型/版型友好度", value: assessment.scores.fitComfort },
        { label: "舒适与维护成本", value: assessment.scores.careCost },
      ]
    : scoreItems;
  const decisionLabel = assessment?.decisionLabel ?? "建议决定买";
  const reportSummary =
    assessment?.summary ??
    "与已有衣橱高度适配，通勤使用频率高，搭配潜力强，可提升日常穿搭质感，值得入手。";
  const reportConfidence = assessment?.confidence ?? 92;
  const dynamicOutfits = assessment?.outfitCombinations.slice(0, 2);
  const candidate = assessment?.candidate;
  const candidateTitle = candidate?.productName ?? "通勤西装外套女春秋";
  const candidateSubtitle = candidate?.summary ?? "宽松休闲小西装";
  const candidatePrice = candidate?.estimatedPrice ? `¥${candidate.estimatedPrice}` : "价格待确认";
  const candidateTags = candidate
    ? [
        candidate.color,
        candidate.category,
        ...candidate.styleTags.slice(0, 2),
        ...candidate.possibleScenarios.slice(0, 2),
      ].filter(Boolean)
    : ["米色", "百搭外套", "通勤 / 日常"];

  return (
    <article className={cn("mt-5 rounded-[16px] border border-[#ead9d0] bg-white p-4 shadow-sm", isAssessing && "opacity-75")}>
      <p className="px-1 text-[16px] leading-8 text-[#5e473e]">
        {assessment
          ? "我已经结合你的衣橱、穿搭知识和长期主义消费框架，生成了这次购买决策报告："
          : "这是一件米色基础西装外套，版型简洁利落，非常适合通勤场景。我结合你的衣橱单品、搭配潜力和使用频率进行了综合分析："}
      </p>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr_1.2fr]">
        <section className="rounded-[14px] border border-[#ead9d0] p-4">
          <div className="flex gap-4">
            {candidateImageDataUrl ? (
              <div
                className="h-40 w-36 shrink-0 rounded-[10px] bg-cover bg-center"
                style={{ backgroundImage: `url(${candidateImageDataUrl})` }}
              />
            ) : (
              <MockProductImage palette="from-[#c9a58e] to-[#f4ded4]" className="h-40 w-36 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold text-[#3d281f]">{candidateTitle}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-[#8b6258]">{candidateSubtitle}</p>
              <p className="mt-4 text-2xl font-semibold text-[#3d281f]">{candidatePrice}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {candidateTags.slice(0, 6).map((tag) => (
                  <span key={tag} className="rounded-full bg-[#f8efea] px-3 py-1 text-xs text-[#8b6258]">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-[12px] bg-gradient-to-br from-[#fbf5f1] to-[#f2e2db] p-5">
            <div className="flex items-center gap-4">
              <span className="text-lg font-semibold text-[#3d281f]">综合结论</span>
              <span className="text-lg font-semibold text-[#c96f67]">{decisionLabel}</span>
            </div>
            <p className="mt-3 leading-7 text-[#7b5b51]">
              {reportSummary}
            </p>
            <p className="mt-5 text-sm text-[#8b6258]">
              置信度 {reportConfidence}%{assessment && !assessment.usedModel ? " · 规则兜底版" : ""}
            </p>
          </div>
        </section>

        <section className="rounded-[14px] border border-[#ead9d0] p-4">
          <div className="space-y-4">
            {reportScoreItems.map((item) => (
              <div key={item.label} className="grid grid-cols-[120px_1fr] items-center gap-3">
                <span className="text-sm text-[#6e5148]">{item.label}</span>
                <ScoreStars value={item.value} />
              </div>
            ))}
          </div>
          <button className="mx-auto mt-6 flex items-center gap-2 text-sm text-[#8b6258]">
            评分说明
            <Info className="size-4" />
          </button>
        </section>

        <section className="rounded-[14px] border border-[#ead9d0] p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-[#3d281f]">2-3 套已有衣橱搭配建议</h3>
            <button className="text-sm text-[#8b6258]">查看全部 &gt;</button>
          </div>
          <div className="mt-4 space-y-4">
            {dynamicOutfits
              ? dynamicOutfits.map((idea, ideaIndex) => (
                  <div key={idea.title} className="rounded-[12px] bg-[#fffaf7] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-medium text-[#50382f]">{idea.title}</p>
                      <span className="text-xs text-[#a08278]">{idea.scenario}</span>
                    </div>
                    <div className="flex gap-2">
                      {idea.items.slice(0, 4).map((itemName, index) => (
                        <MockThumb
                          key={`${idea.title}-${itemName}`}
                          palette={mockClosetItems[(ideaIndex + index) % mockClosetItems.length].palette}
                          className="h-16 w-14"
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#7b5b51]">{idea.summary}</p>
                  </div>
                ))
              : outfitIdeas.slice(0, 2).map((idea) => (
                  <div key={idea.id} className="rounded-[12px] bg-[#fffaf7] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-medium text-[#50382f]">{idea.title}</p>
                      <span className="text-xs text-[#a08278]">{idea.scenario}</span>
                    </div>
                    <div className="flex gap-2">
                      {idea.itemIds.map((id) => {
                        const item = mockClosetItems.find((closet) => closet.id === id);
                        return item ? <MockThumb key={id} palette={item.palette} className="h-16 w-14" /> : null;
                      })}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#7b5b51]">{idea.summary}</p>
                  </div>
                ))}
          </div>
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <button
          onClick={() => onDecision("decided_to_buy")}
          className="inline-flex h-14 items-center justify-center gap-3 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] text-lg font-medium text-white shadow-lg shadow-rose-200/70 transition hover:scale-[1.01]"
        >
          <ShoppingCart className="size-5" />
          决定买
        </button>
        <button
          onClick={() => onDecision("saved_for_later")}
          className="inline-flex h-14 items-center justify-center gap-3 rounded-[10px] border border-[#e5b9b0] bg-white text-lg font-medium text-[#b2605e] transition hover:bg-[#fbf3ef]"
        >
          <Bookmark className="size-5" />
          先收藏
        </button>
        <button
          onClick={() => onDecision("not_considering")}
          className="inline-flex h-14 items-center justify-center gap-3 rounded-[10px] border border-[#e5b9b0] bg-white text-lg font-medium text-[#b2605e] transition hover:bg-[#fbf3ef]"
        >
          <XCircle className="size-5" />
          暂不考虑
        </button>
      </div>

      <div className="mt-4 flex justify-end">
        <button onClick={onOpenDecisions} className="text-sm text-[#8b6258] hover:text-[#b2605e]">
          查看决策清单
        </button>
      </div>
    </article>
  );
}

function ClosetView({
  items,
  isLoading,
  message,
  confirmationHidden,
  deferredConfirmationIds,
  busyItemIds,
  queuedAnalysisItemIds,
  onUploadImages,
  onConfirmItem,
  onConfirmHighConfidence,
  onHideConfirmations,
  onDeferConfirmation,
  onRetryDisplayImage,
  onRetryAnalysis,
  onDeleteItem,
}: {
  items: ClothingItem[];
  isLoading: boolean;
  message: string;
  confirmationHidden: boolean;
  deferredConfirmationIds: string[];
  busyItemIds: string[];
  queuedAnalysisItemIds: string[];
  onUploadImages: (files: File[]) => Promise<void>;
  onConfirmItem: (item: ClothingItem, draft: ClosetConfirmationDraft) => Promise<void>;
  onConfirmHighConfidence: (items: ClothingItem[]) => Promise<void>;
  onHideConfirmations: () => void;
  onDeferConfirmation: (itemId: string) => void;
  onRetryDisplayImage: (item: ClothingItem) => Promise<void>;
  onRetryAnalysis: (item: ClothingItem, userFeedback?: string) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const oftenCount = items.filter((item) => item.wearFrequency === "often").length;
  const sometimesCount = items.filter((item) => item.wearFrequency === "sometimes").length;
  const idleCount = items.filter((item) => item.wearFrequency === "rarely" || item.status === "idle").length;
  const deferredIdSet = new Set(deferredConfirmationIds);
  const pendingConfirmationItems = items.filter(
    (item) => needsClosetConfirmation(item) && !deferredIdSet.has(item.id),
  );

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []).filter((file) => file.type.startsWith("image/"));
    await onUploadImages(files);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <div className="w-full overflow-y-auto p-7">
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
              disabled={isLoading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] px-5 font-medium text-white shadow-lg shadow-rose-200/70 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="size-4" />
              {isLoading ? "上传中" : "上传衣服"}
            </button>
            <button
              disabled={isLoading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-5 text-[#8b6258] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Upload className="size-4" />
              批量上传
            </button>
          </>
        }
      />

      <div className="mt-5 rounded-[16px] border border-[#ead9d0] bg-white p-4">
        <div className="flex flex-wrap items-center gap-4">
          {["品类", "风格", "颜色", "季节", "状态"].map((label) => (
            <button key={label} className="inline-flex h-10 min-w-32 items-center justify-between rounded-[10px] border border-[#ead9d0] px-4 text-sm text-[#7b5b51]">
              {label}
              <span className="text-[#a08278]">全部</span>
            </button>
          ))}
          <div className="ml-auto flex h-10 min-w-60 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-3 text-[#a08278]">
            <Search className="size-4" />
            <span className="text-sm">搜索衣服名称或标签</span>
          </div>
        </div>

        {message && (
          <div className="mt-4 rounded-[12px] border border-[#ead9d0] bg-[#fbf5f1] px-4 py-3 text-sm text-[#7b5b51]">
            {message}
          </div>
        )}

        {!confirmationHidden && pendingConfirmationItems.length > 0 && (
          <ClosetConfirmationPanel
            items={pendingConfirmationItems}
            isBusy={isLoading}
            busyItemIds={busyItemIds}
            queuedAnalysisItemIds={queuedAnalysisItemIds}
            onConfirmItem={onConfirmItem}
            onConfirmHighConfidence={onConfirmHighConfidence}
            onHide={onHideConfirmations}
            onDeferConfirmation={onDeferConfirmation}
            onRetryAnalysis={onRetryAnalysis}
            onDeleteItem={onDeleteItem}
          />
        )}

        {items.length ? (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">
            {items.map((item) => (
              <ClosetCard
                key={item.id}
                item={item}
                isBusy={isLoading || busyItemIds.includes(item.id) || queuedAnalysisItemIds.includes(item.id)}
                isAnalysisQueued={queuedAnalysisItemIds.includes(item.id)}
                onRetryDisplayImage={onRetryDisplayImage}
                onRetryAnalysis={onRetryAnalysis}
                onDeleteItem={onDeleteItem}
              />
            ))}
          </div>
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
              onClick={() => fileInputRef.current?.click()}
              className="mt-5 inline-flex h-11 items-center gap-2 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] px-5 font-medium text-white shadow-lg shadow-rose-200/70"
            >
              <ImagePlus className="size-4" />
              上传第一件衣服
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

function ClosetConfirmationPanel({
  items,
  isBusy,
  busyItemIds,
  queuedAnalysisItemIds,
  onConfirmItem,
  onConfirmHighConfidence,
  onHide,
  onDeferConfirmation,
  onRetryAnalysis,
  onDeleteItem,
}: {
  items: ClothingItem[];
  isBusy: boolean;
  busyItemIds: string[];
  queuedAnalysisItemIds: string[];
  onConfirmItem: (item: ClothingItem, draft: ClosetConfirmationDraft) => Promise<void>;
  onConfirmHighConfidence: (items: ClothingItem[]) => Promise<void>;
  onHide: () => void;
  onDeferConfirmation: (itemId: string) => void;
  onRetryAnalysis: (item: ClothingItem, userFeedback?: string) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
}) {
  const highConfidenceCount = items.filter(
    (item) => (item.aiConfidence ?? 0) >= 0.8 && !(item.imageQualityFlags ?? []).includes("closet_analysis_failed"),
  ).length;

  return (
    <section className="mt-5 rounded-[16px] border border-[#e7c5ba] bg-[#fffaf7] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h3 className="text-lg font-semibold text-[#3d281f]">待确认衣服</h3>
          <p className="mt-1 text-sm text-[#8b6258]">
            AI 已先提取标签，确认后会进入稳定衣橱数据，用于后续搭配检索。
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            disabled={isBusy || highConfidenceCount === 0}
            onClick={() => void onConfirmHighConfidence(items)}
            className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-[#3d281f] px-4 text-sm font-medium text-white transition hover:bg-[#533b31] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="size-4" />
            确认全部高置信度
          </button>
          <button
            type="button"
            onClick={onHide}
            className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#ead9d0] bg-white px-4 text-sm text-[#8b6258] transition hover:bg-[#fbf5f1]"
          >
            收起待确认
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {items.map((item) => (
          <ClosetConfirmationCard
            key={`${item.id}-${item.userCorrected ? "confirmed" : "pending"}-${item.aiConfidence ?? "na"}-${item.summary ?? ""}`}
            item={item}
            isBusy={isBusy || busyItemIds.includes(item.id) || queuedAnalysisItemIds.includes(item.id)}
            isAnalysisQueued={queuedAnalysisItemIds.includes(item.id)}
            onConfirmItem={onConfirmItem}
            onDeferConfirmation={onDeferConfirmation}
            onRetryAnalysis={onRetryAnalysis}
            onDeleteItem={onDeleteItem}
          />
        ))}
      </div>
    </section>
  );
}

function ClosetConfirmationCard({
  item,
  isBusy,
  isAnalysisQueued,
  onConfirmItem,
  onDeferConfirmation,
  onRetryAnalysis,
  onDeleteItem,
}: {
  item: ClothingItem;
  isBusy: boolean;
  isAnalysisQueued: boolean;
  onConfirmItem: (item: ClothingItem, draft: ClosetConfirmationDraft) => Promise<void>;
  onDeferConfirmation: (itemId: string) => void;
  onRetryAnalysis: (item: ClothingItem, userFeedback?: string) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => createConfirmationDraft(item));
  const [showOriginal, setShowOriginal] = useState(false);
  const [reanalysisOpen, setReanalysisOpen] = useState(false);
  const [reanalysisFeedback, setReanalysisFeedback] = useState("");
  const qualityFlags = item.imageQualityFlags ?? [];
  const analysisInProgress = qualityFlags.includes("closet_analysis_processing");
  const analysisFailed = qualityFlags.includes("closet_analysis_failed");
  const confidenceLabel =
    typeof item.aiConfidence === "number" ? `${Math.round(item.aiConfidence * 100)}%` : "待识别";
  const displayedImageUrl =
    showOriginal && item.originalImageUrl
      ? item.originalImageUrl
      : item.displayImageUrl ?? item.originalImageUrl ?? item.imageUrl;
  const visibleQualityFlags = qualityFlags.filter((flag) => {
    if (!flag) return false;
    if (flag === "closet_analysis_queued" && qualityFlags.includes("ai_label_ready")) return false;
    if (flag === "display_image_queued" && item.displayImageStatus === "ready") return false;
    return true;
  });

  function updateDraft(patch: Partial<ClosetConfirmationDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  return (
    <article className="rounded-[14px] border border-[#ead9d0] bg-white p-3">
      <div className="grid gap-4 md:grid-cols-[180px_1fr]">
        <div>
          <div className="relative">
            {displayedImageUrl ? (
              <div
                className="h-56 w-full rounded-[10px] bg-cover bg-center"
                style={{ backgroundImage: `url(${displayedImageUrl})` }}
              />
            ) : (
              <MockProductImage palette={item.palette} className="h-56 w-full" />
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
          <div className="mt-3 rounded-[10px] bg-[#fff7f4] px-3 py-2 text-xs leading-5 text-[#9a514f]">
            {isAnalysisQueued
              ? "AI 标签排队中"
              : analysisInProgress
              ? "AI 标签识别中"
              : analysisFailed
                ? "AI 标签识别失败"
                : `AI 已识别 · 置信度 ${confidenceLabel}`}
          </div>
          {visibleQualityFlags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {visibleQualityFlags.slice(0, 8).map((flag) => (
                <span key={flag} className={cn("rounded-full px-2 py-1 text-[11px]", qualityFlagTone(flag))}>
                  {qualityFlagLabel(flag)}
                </span>
              ))}
            </div>
          )}
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
              value={draft.category}
              onChange={(value) => updateDraft({ category: value })}
            />
            <LabeledInput
              label="颜色"
              value={draft.color}
              onChange={(value) => updateDraft({ color: value })}
            />
            <LabeledSelect
              label="版型"
              value={draft.fit}
              options={fitOptions}
              onChange={(value) => updateDraft({ fit: value as ClothingItem["fit"] })}
            />
            <LabeledTagInput
              label="风格标签"
              value={draft.styleTags}
              placeholder="休闲、简约、通勤"
              onChange={(value) => updateDraft({ styleTags: value })}
            />
            <LabeledTagInput
              label="场景标签"
              value={draft.scenarioTags}
              placeholder="日常、通勤、旅行"
              onChange={(value) => updateDraft({ scenarioTags: value })}
            />
            <LabeledTagInput
              label="季节标签"
              value={draft.seasonTags}
              placeholder="spring、summer、all-season"
              onChange={(value) => updateDraft({ seasonTags: value })}
            />
            <LabeledSelect
              label="穿着频率"
              value={draft.wearFrequency}
              options={wearFrequencyOptions}
              onChange={(value) =>
                updateDraft({ wearFrequency: value as ClothingItem["wearFrequency"] })
              }
            />
          </div>

          {reanalysisOpen && (
            <div className="mt-4 rounded-[12px] border border-[#ead9d0] bg-[#fffdfb] p-3">
              <label className="block">
                <span className="text-xs text-[#8b6258]">这次希望 AI 重点调整什么？</span>
                <textarea
                  value={reanalysisFeedback}
                  onChange={(event) => setReanalysisFeedback(event.target.value)}
                  placeholder="例如：这不是裙子，是宽松长裤；颜色更接近米白色；请忽略衣架和背景。"
                  className="mt-2 min-h-20 w-full resize-none rounded-[10px] border border-[#ead9d0] bg-white px-3 py-2 text-sm leading-6 text-[#3d281f] outline-none transition focus:border-[#cf6f70]"
                />
              </label>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReanalysisOpen(false)}
                  className="h-9 rounded-[9px] px-3 text-sm text-[#8b6258] transition hover:bg-[#fbf5f1]"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={isBusy || !item.originalImageUrl}
                  onClick={() => {
                    setReanalysisOpen(false);
                    void onRetryAnalysis(item, reanalysisFeedback.trim() || undefined);
                  }}
                  className="h-9 rounded-[9px] bg-[#3d281f] px-3 text-sm font-medium text-white transition hover:bg-[#533b31] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  加入识别队列
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={isBusy || !item.originalImageUrl}
              onClick={() => setReanalysisOpen((open) => !open)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-4 text-sm text-[#8b6258] transition hover:bg-[#fbf5f1] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Pencil className="size-4" />
              {isAnalysisQueued ? "识别排队中" : analysisInProgress ? "正在识别" : "重新识别"}
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onDeferConfirmation(item.id)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-4 text-sm text-[#8b6258] transition hover:bg-[#fbf5f1] disabled:cursor-not-allowed disabled:opacity-50"
            >
              稍后确认
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onDeleteItem(item)}
              className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#f0c8c2] px-4 text-sm text-[#b14545] transition hover:bg-[#fff0ef] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="size-4" />
              删除
            </button>
            <button
              type="button"
              disabled={isBusy || !draft.name.trim() || !draft.category.trim()}
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
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#8b6258]">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-[10px] border border-[#ead9d0] bg-[#fffdfb] px-3 text-sm text-[#3d281f] outline-none transition focus:border-[#cf6f70]"
      />
    </label>
  );
}

function LabeledSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#8b6258]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-[10px] border border-[#ead9d0] bg-[#fffdfb] px-3 text-sm text-[#3d281f] outline-none transition focus:border-[#cf6f70]"
      >
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
  onChange,
}: {
  label: string;
  value: string[];
  placeholder: string;
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-[#8b6258]">{label}</span>
      <input
        value={value.join("、")}
        placeholder={placeholder}
        onChange={(event) => onChange(splitTags(event.target.value))}
        className="mt-1 h-10 w-full rounded-[10px] border border-[#ead9d0] bg-[#fffdfb] px-3 text-sm text-[#3d281f] outline-none transition focus:border-[#cf6f70]"
      />
    </label>
  );
}

function qualityFlagLabel(flag: string) {
  const labels: Record<string, string> = {
    original_saved: "原图已保存",
    display_image_queued: "展示图排队",
    display_image_processing: "展示图生成中",
    display_image_ready: "展示图已完成",
    closet_analysis_queued: "识别排队",
    closet_analysis_processing: "正在识别",
    closet_analysis_failed: "识别失败",
    ai_label_ready: "标签已生成",
    needs_ai_label_confirmation: "等待确认",
    background_complex: "背景复杂",
    folded: "有折叠",
    occluded: "有遮挡",
    partial_view: "不完整",
    low_light: "光线弱",
    color_cast: "偏色",
    low_confidence: "低置信度",
    display_image_failed: "展示图失败",
  };

  return labels[flag] ?? flag;
}

function qualityFlagTone(flag: string) {
  if (
    [
      "display_image_queued",
      "display_image_processing",
      "closet_analysis_queued",
      "closet_analysis_processing",
      "needs_ai_label_confirmation",
    ].includes(flag)
  ) {
    return "bg-[#eef4ff] text-[#52658a]";
  }

  if (["display_image_ready", "ai_label_ready", "original_saved"].includes(flag)) {
    return "bg-[#edf8f1] text-[#4f7b62]";
  }

  if (["display_image_failed", "closet_analysis_failed", "low_confidence"].includes(flag)) {
    return "bg-[#fff0ef] text-[#b14545]";
  }

  return "bg-[#f8efea] text-[#8b6258]";
}

function ClosetCard({
  item,
  isBusy,
  isAnalysisQueued,
  onRetryDisplayImage,
  onRetryAnalysis,
  onDeleteItem,
}: {
  item: ClothingItem;
  isBusy: boolean;
  isAnalysisQueued: boolean;
  onRetryDisplayImage: (item: ClothingItem) => Promise<void>;
  onRetryAnalysis: (item: ClothingItem, userFeedback?: string) => Promise<void>;
  onDeleteItem: (item: ClothingItem) => Promise<void>;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const displayReady = Boolean(item.displayImageUrl);
  const displayedImageUrl =
    showOriginal && item.originalImageUrl
      ? item.originalImageUrl
      : item.displayImageUrl ?? item.originalImageUrl ?? item.imageUrl;
  const displayStatus = item.displayImageStatus ?? "not_started";
  const displayStatusLabel: Record<NonNullable<ClothingItem["displayImageStatus"]>, string> = {
    not_started: "展示图待生成",
    queued: "展示图排队中",
    processing: "展示图生成中",
    ready: "展示图",
    failed: "展示图失败",
  };
  const qualityFlags = item.imageQualityFlags ?? [];
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
  const statusLabel =
    item.wearFrequency === "often"
      ? "常穿"
      : item.wearFrequency === "sometimes"
        ? "偶尔穿"
        : item.wearFrequency === "rarely"
          ? "闲置"
          : "待确认";
  return (
    <article className="group rounded-[14px] border border-[#ead9d0] bg-[#fffdfb] p-3 transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-rose-100/70">
      <div className="relative">
        {displayedImageUrl ? (
          <div
            className="h-48 w-full rounded-[10px] bg-cover bg-center"
            style={{ backgroundImage: `url(${displayedImageUrl})` }}
          />
        ) : (
          <MockProductImage palette={item.palette} className="h-48 w-full" />
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
              disabled={isBusy || displayStatus === "processing" || !item.originalImageUrl}
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
              disabled={isBusy || !item.originalImageUrl}
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
              disabled={isBusy}
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
      <p className="mt-1 text-sm text-[#8b6258]">{item.category}</p>
      {(displayStatus !== "ready" || pendingAi || analysisFailed || needsConfirmation) && (
        <div className="mt-3 rounded-[10px] bg-[#fff7f4] px-3 py-2 text-xs leading-5 text-[#9a514f]">
          {displayStatusLabel[displayStatus]} ·{" "}
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
      <div className="mt-3 flex flex-wrap gap-2">
        {[...item.styleTags, ...item.scenarioTags.slice(0, 2)].slice(0, 7).map((tag, index) => (
          <span key={`${tag}-${index}`} className="rounded-full bg-[#f8efea] px-3 py-1 text-xs text-[#8b6258]">
            {tag}
          </span>
        ))}
      </div>
    </article>
  );
}

function DecisionListView({
  filter,
  items,
  allItems,
  onFilterChange,
  onStatusChange,
}: {
  filter: DecisionStatus | "all";
  items: DecisionItem[];
  allItems: DecisionItem[];
  onFilterChange: (filter: DecisionStatus | "all") => void;
  onStatusChange: (id: string, status: DecisionStatus) => void;
}) {
  const counts = {
    all: allItems.length,
    decided_to_buy: allItems.filter((item) => item.status === "decided_to_buy").length,
    saved_for_later: allItems.filter((item) => item.status === "saved_for_later").length,
    not_considering: allItems.filter((item) => item.status === "not_considering").length,
  };

  return (
    <div className="w-full overflow-y-auto p-7">
      <HeaderInline
        title="决策清单"
        subtitle="管理你咨询过的商品及决策状态，理性复盘，做出更好的购物选择。"
        actions={
          <button className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-[#ead9d0] px-5 text-[#8b6258]">
            最近咨询
            <SlidersHorizontal className="size-4" />
          </button>
        }
      />

      <div className="mt-5 flex flex-wrap gap-4">
        {[
          ["all", "全部", counts.all],
          ["decided_to_buy", "决定买", counts.decided_to_buy],
          ["saved_for_later", "先收藏", counts.saved_for_later],
          ["not_considering", "暂不考虑", counts.not_considering],
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
        {items.map((item) => (
          <DecisionCard key={item.id} item={item} onStatusChange={onStatusChange} />
        ))}
      </div>

      <p className="mt-8 text-center text-sm text-[#a08278]">
        理性消费，长期主义。每一次复盘，都是向更好的自己靠近一步。
      </p>
    </div>
  );
}

function DecisionCard({
  item,
  onStatusChange,
}: {
  item: DecisionItem;
  onStatusChange: (id: string, status: DecisionStatus) => void;
}) {
  const StatusIcon = statusConfig[item.status].icon;
  return (
    <article className="rounded-[16px] border border-[#ead9d0] bg-white p-4">
      <div className="grid gap-5 xl:grid-cols-[180px_1fr_1fr_1fr]">
        <div className="flex gap-4 xl:block">
          <MockProductImage palette={item.palette} className="h-40 w-36 xl:w-full" />
          <div className="xl:mt-4">
            <h3 className="text-lg font-semibold text-[#3d281f]">{item.productName}</h3>
            <p className="mt-1 text-sm text-[#8b6258]">{item.merchant}</p>
            <p className="mt-3 text-2xl font-semibold text-[#3d281f]">¥{item.price}</p>
            <p className="mt-2 text-sm text-[#8b6258]">颜色：{item.color}　尺码：{item.size}</p>
          </div>
        </div>
        <div className="border-l border-[#f0e1da] pl-5">
          <p className="font-medium text-[#3d281f]">AI 建议总结</p>
          <p className="mt-3 leading-7 text-[#7b5b51]">{item.summary}</p>
          <button className="mt-4 text-sm text-[#b2605e]">查看完整分析 &gt;</button>
        </div>
        <div className="border-l border-[#f0e1da] pl-5">
          <p className="font-medium text-[#3d281f]">核心搭配建议</p>
          <div className="mt-3 flex gap-2">
            {item.outfitTips.slice(0, 3).map((tip, index) => (
              <MockThumb key={tip} palette={mockClosetItems[index]?.palette ?? item.palette} className="h-16 w-14" />
            ))}
          </div>
          <ul className="mt-3 space-y-2 text-sm text-[#7b5b51]">
            {item.outfitTips.slice(0, 2).map((tip) => (
              <li key={tip}>· {tip}</li>
            ))}
          </ul>
        </div>
        <div className="border-l border-[#f0e1da] pl-5">
          <p className="font-medium text-[#3d281f]">主要风险提醒</p>
          <ul className="mt-3 space-y-2 text-sm leading-6 text-[#7b5b51]">
            {item.risks.map((risk) => (
              <li key={risk}>· {risk}</li>
            ))}
          </ul>
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
              className="rounded-[10px] border border-[#ead9d0] px-3 py-2 text-sm text-[#7b5b51] transition hover:bg-[#fbf3ef]"
            >
              {statusConfig[status].label}
            </button>
          ))}
        </div>
      </div>
    </article>
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
    <div className="w-full overflow-y-auto p-7">
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

function Header({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between border-b border-[#f0e1da] px-7 py-7">
      <div>
        <h2 className="text-4xl font-semibold text-[#3d281f]">{title}</h2>
        <p className="mt-2 text-[#8b6258]">{subtitle}</p>
      </div>
      {action}
    </header>
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
        <h2 className="text-4xl font-semibold text-[#3d281f]">{title}</h2>
        <p className="mt-2 text-[#8b6258]">{subtitle}</p>
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
  onChange,
  onImageSelect,
  onClearImage,
  onSubmit,
}: {
  value: string;
  isAssessing: boolean;
  imageDataUrl?: string;
  imageName?: string;
  onChange: (value: string) => void;
  onImageSelect: (file: File) => Promise<void>;
  onClearImage: () => void;
  onSubmit: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImageChange(fileList: FileList | null) {
    const file = Array.from(fileList ?? []).find((currentFile) =>
      currentFile.type.startsWith("image/"),
    );
    if (!file) return;

    await onImageSelect(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <form
      className="border-t border-[#f0e1da] px-7 py-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="rounded-[16px] border border-[#ead9d0] bg-[#fffaf7] p-4">
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
          className="h-14 w-full resize-none bg-transparent text-[#3d281f] outline-none placeholder:text-[#b99a91]"
          placeholder="描述你的问题，例如：这件适合我通勤穿吗？价格 399 值得买吗？"
        />
        <div className="mt-3 flex items-center gap-3">
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
            className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-[#ead9d0] bg-white px-4 text-sm text-[#8b6258] transition hover:bg-[#fbf5f1] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ImagePlus className="size-4" />
            {imageDataUrl ? "更换截图" : "上传截图"}
          </button>
          <span className="text-xs text-[#b99a91]">内容由 AI 生成，仅供参考，不构成购买建议</span>
          <button
            disabled={isAssessing}
            className="ml-auto inline-flex h-12 items-center gap-3 rounded-[10px] bg-gradient-to-r from-[#cf6f70] to-[#e6a094] px-7 font-medium text-white shadow-lg shadow-rose-200/70 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Send className="size-5" />
            {isAssessing ? "分析中" : "发送"}
          </button>
        </div>
      </div>
    </form>
  );
}

function ScoreStars({ value }: { value: number }) {
  const stars = Math.round(value / 20);
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: 5 }).map((_, index) => (
        <Star
          key={index}
          className={cn(
            "size-4",
            index < stars ? "fill-[#6a4a35] text-[#6a4a35]" : "text-[#d8c6bd]",
          )}
        />
      ))}
    </div>
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
    <div className={cn("flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-[#f7e4dc] to-[#d38a82] text-[#6e332f]", className)}>
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
    <section className="rounded-[16px] border border-[#ead9d0] bg-white p-5">
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
