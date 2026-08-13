export type TimingOutcome = "success" | "failure" | "timeout";

export type TimingSpan = {
  name: string;
  startOffsetMs: number;
  durationMs: number;
  outcome: TimingOutcome;
};

export type TimingMetadataValue = string | number | boolean | null;
export type TimingMetadata = Record<string, TimingMetadataValue>;

export type TimingSummary = {
  event: "closet_pipeline_timing";
  schemaVersion: 1;
  traceId: string;
  requestId?: string;
  operation: string;
  outcome: TimingOutcome;
  totalMs: number;
  spans: TimingSpan[];
  metadata: TimingMetadata;
};

export type TimingSpanHandle = {
  finish: (outcome?: TimingOutcome) => TimingSpan;
};

export type TimingTrace = {
  traceId: string;
  requestId?: string;
  operation: string;
  startSpan: (name: string) => TimingSpanHandle;
  measure: <T>(
    name: string,
    task: () => PromiseLike<T>,
    classify?: (result: T) => TimingOutcome,
  ) => Promise<T>;
  measureSync: <T>(
    name: string,
    task: () => T,
    classify?: (result: T) => TimingOutcome,
  ) => T;
  summarize: (outcome?: TimingOutcome, metadata?: Record<string, unknown>) => TimingSummary;
};

const timingIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const safeMetadataKeys = new Set([
  "analysisRequestId",
  "analysisServerTiming",
  "batchSize",
  "dataUrlChars",
  "displayRequestId",
  "displayServerTiming",
  "failureKind",
  "fileBytes",
  "httpStatus",
  "imageCount",
  "inputBytes",
  "inputChars",
  "model",
  "outputBytes",
  "outputKind",
  "provider",
  "providerContentLength",
  "providerHttpStatus",
  "providerRequestId",
  "providerResponseBytes",
  "providerServerTiming",
  "region",
  "route",
]);

const defaultNow = () => performance.now();

function roundMilliseconds(value: number) {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function normalizeSpanName(value: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 64);
  return normalized || "unknown";
}

function sanitizeMetadataString(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 2048);
}

export function sanitizeTimingMetadata(metadata: Record<string, unknown> = {}): TimingMetadata {
  const sanitized: TimingMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!safeMetadataKeys.has(key)) continue;

    if (typeof value === "string") {
      sanitized[key] = sanitizeMetadataString(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export function resolveTimingId(
  candidate?: string | null,
  randomUUID: () => string = () => crypto.randomUUID(),
) {
  const normalized = candidate?.trim();
  return normalized && timingIdPattern.test(normalized) ? normalized : randomUUID();
}

export function createTimingTrace({
  operation,
  traceId = resolveTimingId(),
  requestId,
  now = defaultNow,
}: {
  operation: string;
  traceId?: string;
  requestId?: string;
  now?: () => number;
}): TimingTrace {
  const startedAt = now();
  const spans: TimingSpan[] = [];

  function startSpan(name: string): TimingSpanHandle {
    const normalizedName = normalizeSpanName(name);
    const spanStartedAt = now();
    let finishedSpan: TimingSpan | undefined;

    return {
      finish(outcome = "success") {
        if (finishedSpan) return finishedSpan;

        finishedSpan = {
          name: normalizedName,
          startOffsetMs: roundMilliseconds(spanStartedAt - startedAt),
          durationMs: roundMilliseconds(now() - spanStartedAt),
          outcome,
        };
        spans.push(finishedSpan);
        return finishedSpan;
      },
    };
  }

  async function measure<T>(
    name: string,
    task: () => PromiseLike<T>,
    classify: (result: T) => TimingOutcome = () => "success",
  ) {
    const span = startSpan(name);
    try {
      const result = await task();
      span.finish(classify(result));
      return result;
    } catch (error) {
      span.finish("failure");
      throw error;
    }
  }

  function measureSync<T>(
    name: string,
    task: () => T,
    classify: (result: T) => TimingOutcome = () => "success",
  ) {
    const span = startSpan(name);
    try {
      const result = task();
      span.finish(classify(result));
      return result;
    } catch (error) {
      span.finish("failure");
      throw error;
    }
  }

  function summarize(
    outcome: TimingOutcome = "success",
    metadata: Record<string, unknown> = {},
  ): TimingSummary {
    return {
      event: "closet_pipeline_timing",
      schemaVersion: 1,
      traceId,
      ...(requestId ? { requestId } : {}),
      operation: normalizeSpanName(operation),
      outcome,
      totalMs: roundMilliseconds(now() - startedAt),
      spans: [...spans].sort(
        (left, right) => left.startOffsetMs - right.startOffsetMs || left.name.localeCompare(right.name),
      ),
      metadata: sanitizeTimingMetadata(metadata),
    };
  }

  return {
    traceId,
    requestId,
    operation: normalizeSpanName(operation),
    startSpan,
    measure,
    measureSync,
    summarize,
  };
}

export function formatServerTiming(summary: TimingSummary) {
  const metricCounts = new Map<string, number>();
  const metrics = summary.spans.map((span) => {
    const baseName = normalizeSpanName(span.name);
    const count = metricCounts.get(baseName) ?? 0;
    metricCounts.set(baseName, count + 1);
    const metricName = count === 0 ? baseName : `${baseName}_${count + 1}`;
    return `${metricName};dur=${span.durationMs.toFixed(1)}`;
  });
  metrics.push(`total;dur=${summary.totalMs.toFixed(1)}`);
  return metrics.join(", ");
}

export function createTimingHeaders(summary: TimingSummary) {
  return {
    "Server-Timing": formatServerTiming(summary),
    "X-Closet-Trace-Id": summary.traceId,
    ...(summary.requestId ? { "X-Request-Id": summary.requestId } : {}),
  };
}

export function emitTimingSummary(summary: TimingSummary) {
  try {
    console.info("[closet-upload-performance]", JSON.stringify(summary));
  } catch {
    // Diagnostics must never change the upload result.
  }
}
