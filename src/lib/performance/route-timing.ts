import { NextResponse, type NextRequest } from "next/server";

import {
  createTimingHeaders,
  createTimingTrace,
  emitTimingSummary,
  resolveTimingId,
  type TimingMetadata,
  type TimingOutcome,
} from "./timing";

type RouteTimingOptions = {
  operation: string;
  route: string;
  metadata?: Record<string, unknown>;
};

type TimingResponseInit = ResponseInit & {
  outcome?: TimingOutcome;
  metadata?: Record<string, unknown>;
};

export function createRouteTiming(request: NextRequest, options: RouteTimingOptions) {
  const traceId = resolveTimingId(request.headers.get("x-closet-trace-id"));
  const requestId = resolveTimingId(request.headers.get("x-request-id"));
  const trace = createTimingTrace({
    operation: options.operation,
    traceId,
    requestId,
  });
  let metadata: Record<string, unknown> = {
    route: options.route,
    ...(process.env.VERCEL_REGION ? { region: process.env.VERCEL_REGION } : {}),
    ...options.metadata,
  };
  let emitted = false;

  function addMetadata(patch: Record<string, unknown>) {
    metadata = { ...metadata, ...patch };
  }

  function json<T>(body: T, init: TimingResponseInit = {}) {
    const {
      outcome = (init.status ?? 200) >= 400 ? "failure" : "success",
      metadata: responseMetadata,
      ...responseInit
    } = init;
    const httpStatus = responseInit.status ?? 200;
    const summary = trace.summarize(outcome, {
      ...metadata,
      ...responseMetadata,
      httpStatus,
    });
    const headers = new Headers(responseInit.headers);

    for (const [name, value] of Object.entries(createTimingHeaders(summary))) {
      headers.set(name, value);
    }

    if (!emitted) {
      emitted = true;
      emitTimingSummary(summary);
    }

    return NextResponse.json(body, {
      ...responseInit,
      headers,
    });
  }

  return {
    trace,
    traceId,
    requestId,
    addMetadata: (patch: TimingMetadata | Record<string, unknown>) => addMetadata(patch),
    json,
  };
}
