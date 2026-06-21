import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClothingItem } from "@/lib/types";

type ClosetRetrievalRow = {
  id: string;
  image_path: string;
  display_image_path: string | null;
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
  embedding: string | number[] | null;
  ai_confidence: number | null;
  user_corrected: boolean | null;
};

export async function loadRealClosetItems(supabase: SupabaseClient): Promise<ClothingItem[]> {
  const { data, error } = await supabase
    .from("closet_items")
    .select(
      "id,image_path,display_image_path,category,color,fit,style_tags,season,scenario_tags,wear_frequency,status,summary,embedding_text,embedding,ai_confidence,user_corrected",
    )
    .neq("status", "archived")
    .order("updated_at", { ascending: false })
    .limit(120);

  if (error) throw error;

  const rows = ((data ?? []) as ClosetRetrievalRow[]).filter(
    (item) => item.category && item.category !== "待识别" && item.category !== "识别中",
  );

  return Promise.all(
    rows.map(async (item) => {
      const displayImageUrl = item.display_image_path
        ? await createSignedImageUrl(supabase, "closet-images", item.display_image_path)
        : undefined;
      const originalImageUrl = await createSignedImageUrl(supabase, "closet-images", item.image_path);

      return {
        id: item.id,
        name: item.summary || `${item.color ?? ""}${item.category}` || "衣橱单品",
        category: item.category,
        color: item.color ?? "unknown",
        fit: item.fit ?? "unknown",
        styleTags: item.style_tags ?? [],
        seasonTags: item.season ?? [],
        scenarioTags: item.scenario_tags ?? [],
        wearFrequency: item.wear_frequency ?? "unknown",
        status: item.status ?? "active",
        palette: getPaletteByColor(item.color),
        imagePath: item.image_path,
        displayImagePath: item.display_image_path ?? undefined,
        imageUrl: displayImageUrl ?? originalImageUrl,
        displayImageUrl,
        originalImageUrl,
        aiConfidence: item.ai_confidence ?? undefined,
        userCorrected: item.user_corrected ?? false,
        embeddingText: item.embedding_text ?? undefined,
        embedding: parsePgVector(item.embedding),
        summary: item.summary ?? undefined,
      };
    }),
  );
}

export async function createSignedImageUrl(
  supabase: SupabaseClient,
  bucket: "closet-images" | "purchase-screenshots",
  path: string,
) {
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  return data?.signedUrl;
}

function parsePgVector(value: string | number[] | null) {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value.map(Number).filter(Number.isFinite);
  }

  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(Number.isFinite);
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
