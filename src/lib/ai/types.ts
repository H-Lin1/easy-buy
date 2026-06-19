import type { ClothingItem, DecisionStatus } from "@/lib/types";

export type UserStyleProfile = {
  heightCm?: number;
  weightKg?: number;
  bmi?: number;
  stylePreferences?: string[];
  commonScenarios?: string[];
  budgetSensitivity?: "low" | "medium" | "high";
};

export type PurchaseAssessmentRequest = {
  message: string;
  imageDataUrl?: string;
  userProfile?: UserStyleProfile;
  candidate?: PurchaseCandidateAIProfile;
  candidateEmbedding?: number[];
  closetItems?: ClothingItem[];
};

export type PurchaseCandidateAIProfile = {
  productName: string;
  category: string;
  color: string;
  secondaryColors?: string[];
  fit: "slim" | "regular" | "oversized" | "unknown";
  styleTags: string[];
  possibleScenarios: string[];
  estimatedPrice?: number;
  detectedText?: string;
  sellingPoints: string[];
  summary: string;
  embeddingText?: string;
  aiConfidence?: number;
  screenshotPath?: string;
  screenshotUrl?: string;
};

export type ClosetMatch = {
  item: ClothingItem;
  matchType: "outfit" | "duplicate" | "alternative";
  score: number;
  reason: string;
};

export type FashionKnowledgeSnippet = {
  cardId?: string;
  topic: string;
  knowledgeType?: string;
  tags: string[];
  content: string;
  decisionPoints?: string[];
  outfitSuggestions?: string[];
  riskSignals?: string[];
  decisionBias?: Record<string, string>;
  sourceRefs?: string[];
  score?: number;
};

export type OutfitCombination = {
  title: string;
  scenario: string;
  items: string[];
  closetItemIds?: string[];
  summary: string;
  visualType?: "evidence_board";
  visualItems?: OutfitEvidenceItem[];
};

export type OutfitEvidenceItem = {
  id: string;
  name: string;
  category: string;
  imageUrl?: string;
  badge: string;
  reason: string;
  tags: string[];
};

export type PurchaseDecisionReport = {
  candidate: PurchaseCandidateAIProfile;
  decision: "buy" | "save" | "skip";
  decisionStatus: DecisionStatus;
  decisionLabel: string;
  confidence: number;
  summary: string;
  scores: {
    wardrobeFit: number;
    outfitPotential: number;
    duplicateRisk: number;
    styleConsistency: number;
    priceValue: number;
    fitComfort: number;
    careCost: number;
  };
  reasonsToBuy: string[];
  reasonsToSave: string[];
  risks: string[];
  bodyFitNotes: string[];
  outfitCombinations: OutfitCombination[];
  retrievedClosetItems: ClosetMatch[];
  knowledgeSnippets: FashionKnowledgeSnippet[];
  nextStep: string;
  usedModel: boolean;
};

export type PurchaseWorkflowState = {
  request: PurchaseAssessmentRequest;
  candidate?: PurchaseCandidateAIProfile;
  closetMatches: ClosetMatch[];
  knowledgeSnippets: FashionKnowledgeSnippet[];
  report?: PurchaseDecisionReport;
  errors: string[];
};
