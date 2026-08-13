export type ClosetUploadTaskProgressState = "in_progress" | "complete" | "failed" | "waiting";

export type ClosetUploadTaskProgress = Readonly<{
  state: ClosetUploadTaskProgressState;
  label: string;
}>;

type ClosetAnalysisProgressInput = Readonly<{
  imageQualityFlags?: readonly string[] | null;
  category?: string | null;
  styleTags?: readonly string[] | null;
  isQueued?: boolean;
}>;

type ClosetDisplayProgressInput = Readonly<{
  displayImageStatus?: "not_started" | "queued" | "processing" | "ready" | "failed" | null;
}>;

function hasAnyTag(tags: readonly string[] | null | undefined, candidates: readonly string[]) {
  return (tags ?? []).some((tag) => candidates.includes(tag));
}

export function getClosetAnalysisProgress(
  input: ClosetAnalysisProgressInput,
): ClosetUploadTaskProgress {
  const flags = input.imageQualityFlags ?? [];
  const hasFlag = (flag: string) => flags.includes(flag);

  if (input.isQueued) {
    return { state: "in_progress", label: "衣服信息识别中" };
  }

  if (hasFlag("closet_analysis_processing")) {
    return { state: "in_progress", label: "衣服信息识别中" };
  }

  if (hasFlag("closet_analysis_failed")) {
    return { state: "failed", label: "衣服信息识别失败" };
  }

  if (hasFlag("closet_analysis_queued") && !hasFlag("ai_label_ready")) {
    return { state: "in_progress", label: "衣服信息识别中" };
  }

  if (
    input.category === "待识别" ||
    input.category === "识别中" ||
    hasAnyTag(input.styleTags, ["待识别", "AI 识别中"])
  ) {
    return { state: "in_progress", label: "衣服信息识别中" };
  }

  return { state: "complete", label: "衣服信息已识别" };
}

export function getClosetDisplayProgress(
  input: ClosetDisplayProgressInput,
): ClosetUploadTaskProgress {
  const status = input.displayImageStatus ?? "not_started";

  if (status === "queued" || status === "processing") {
    return { state: "in_progress", label: "展示图生成中" };
  }

  if (status === "failed") {
    return { state: "failed", label: "展示图生成失败" };
  }

  if (status === "ready") {
    return { state: "complete", label: "展示图已生成" };
  }

  return { state: "waiting", label: "展示图待生成" };
}
