import assert from "node:assert/strict";
import test from "node:test";

import {
  createTimingHeaders,
  createTimingTrace,
  formatServerTiming,
  resolveTimingId,
  sanitizeTimingMetadata,
} from "./timing.ts";

const traceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

function createClock() {
  let current = 0;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

test("records deterministic sequential and parallel span offsets", () => {
  const clock = createClock();
  const trace = createTimingTrace({
    operation: "closet_upload",
    traceId,
    now: clock.now,
  });

  const upload = trace.startSpan("original_storage_upload");
  clock.advance(12.34);
  upload.finish();

  const analysis = trace.startSpan("analysis_branch_total");
  clock.advance(3);
  const display = trace.startSpan("display_branch_total");
  clock.advance(7);
  analysis.finish();
  clock.advance(11);
  display.finish();

  const summary = trace.summarize();
  assert.equal(summary.totalMs, 33.3);
  assert.deepEqual(summary.spans, [
    {
      name: "original_storage_upload",
      startOffsetMs: 0,
      durationMs: 12.3,
      outcome: "success",
    },
    {
      name: "analysis_branch_total",
      startOffsetMs: 12.3,
      durationMs: 10,
      outcome: "success",
    },
    {
      name: "display_branch_total",
      startOffsetMs: 15.3,
      durationMs: 18,
      outcome: "success",
    },
  ]);
});

test("marks rejected async and thrown sync work as failures", async () => {
  const clock = createClock();
  const trace = createTimingTrace({ operation: "failure_test", traceId, now: clock.now });

  await assert.rejects(
    trace.measure("async_failure", async () => {
      clock.advance(4);
      throw new Error("private upstream detail");
    }),
  );
  assert.throws(() =>
    trace.measureSync("sync_failure", () => {
      clock.advance(2);
      throw new Error("private parse detail");
    }),
  );

  const summary = trace.summarize("failure", { failureKind: "provider_failed" });
  assert.deepEqual(summary.spans.map((span) => span.outcome), ["failure", "failure"]);
  assert.equal(JSON.stringify(summary).includes("private"), false);
});

test("classifies non-throwing error results and finishes a span only once", async () => {
  const clock = createClock();
  const trace = createTimingTrace({ operation: "result_test", traceId, now: clock.now });
  const handle = trace.startSpan("manual");
  clock.advance(1);
  handle.finish("failure");
  clock.advance(5);
  handle.finish("success");

  await trace.measure(
    "supabase_result",
    async () => {
      clock.advance(3);
      return { error: { code: "test" } };
    },
    (result) => (result.error ? "failure" : "success"),
  );

  const summary = trace.summarize("failure");
  assert.equal(summary.spans.length, 2);
  assert.deepEqual(summary.spans.map((span) => span.outcome), ["failure", "failure"]);
});

test("accepts UUID timing IDs and replaces unsafe incoming IDs", () => {
  assert.equal(resolveTimingId(` ${traceId} `, () => requestId), traceId);
  assert.equal(resolveTimingId("Bearer secret-token", () => requestId), requestId);
  assert.equal(resolveTimingId(undefined, () => requestId), requestId);
});

test("keeps only bounded allowlisted metadata", () => {
  const sanitized = sanitizeTimingMetadata({
    provider: "tripo",
    model: "gpt-image-2",
    inputBytes: 415845,
    providerHttpStatus: 200,
    providerRequestId: "req_abc-123",
    providerServerTiming: "inference;dur=48580.2",
    providerContentLength: 975452,
    providerResponseBytes: 975452,
    failureKind: "provider_failed\nnext-line",
    apiKey: "secret-key",
    authorization: "Bearer secret-token",
    imageDataUrl: "data:image/png;base64,secret-image",
    prompt: "private prompt",
    signedUrl: "https://example.test/private?token=secret",
  });

  assert.deepEqual(sanitized, {
    provider: "tripo",
    model: "gpt-image-2",
    inputBytes: 415845,
    providerHttpStatus: 200,
    providerRequestId: "req_abc-123",
    providerServerTiming: "inference;dur=48580.2",
    providerContentLength: 975452,
    providerResponseBytes: 975452,
    failureKind: "provider_failed next-line",
  });
  assert.equal(JSON.stringify(sanitized).includes("secret"), false);
});

test("formats parseable server timing and correlation headers", () => {
  const clock = createClock();
  const trace = createTimingTrace({
    operation: "closet_display_image",
    traceId,
    requestId,
    now: clock.now,
  });
  const provider = trace.startSpan("provider fetch ttfb");
  clock.advance(23.08);
  provider.finish();
  const summary = trace.summarize("success", { httpStatus: 200 });

  assert.equal(formatServerTiming(summary), "provider_fetch_ttfb;dur=23.1, total;dur=23.1");
  assert.deepEqual(createTimingHeaders(summary), {
    "Server-Timing": "provider_fetch_ttfb;dur=23.1, total;dur=23.1",
    "X-Closet-Trace-Id": traceId,
    "X-Request-Id": requestId,
  });
});
