export type AppView = "chat" | "closet" | "decisions" | "settings";

export type ClosetStatus = "active" | "idle" | "archived";

export type DecisionStatus =
  | "decided_to_buy"
  | "saved_for_later"
  | "not_considering";

export type BudgetSensitivity = "low" | "medium" | "high";

export type UserProfile = {
  id?: string;
  userId: string;
  heightCm: number | null;
  weightKg: number | null;
  bmi: number | null;
  bmiBand: "underweight" | "normal" | "overweight" | "obese" | null;
  stylePreferences: string[];
  dislikedCategories: string[];
  commonScenarios: string[];
  budgetSensitivity: BudgetSensitivity;
};

export type ClothingItem = {
  id: string;
  name: string;
  category: string;
  color: string;
  fit: "slim" | "regular" | "oversized" | "unknown";
  styleTags: string[];
  seasonTags?: string[];
  scenarioTags: string[];
  wearFrequency: "often" | "sometimes" | "rarely" | "unknown";
  status: ClosetStatus;
  palette: string;
  imagePath?: string;
  processedImagePath?: string;
  displayImagePath?: string;
  displayImageStatus?: "not_started" | "queued" | "processing" | "ready" | "failed";
  displayImageModel?: string;
  displayImagePromptVersion?: string;
  imageUrl?: string;
  displayImageUrl?: string;
  originalImageUrl?: string;
  imageQualityFlags?: string[];
  aiConfidence?: number;
  userCorrected?: boolean;
  embeddingText?: string;
  embedding?: number[];
  summary?: string;
};

export type OutfitIdea = {
  id: string;
  title: string;
  scenario: string;
  itemIds: string[];
  summary: string;
};

export type DecisionItem = {
  id: string;
  productName: string;
  merchant: string;
  price: number;
  status: DecisionStatus;
  color: string;
  size: string;
  summary: string;
  outfitTips: string[];
  risks: string[];
  lastAskedAt: string;
  reminderAt?: string;
  imagePath?: string;
  imageUrl?: string;
  palette: string;
};

export type ScoreItem = {
  label: string;
  value: number;
};

export type ChatSession = {
  id: string;
  title: string;
  subtitle: string;
  favorite?: boolean;
  palette: string;
  thumbnailUrl?: string;
  imagePath?: string;
  updatedAt?: string;
};
