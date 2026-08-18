import { timingSafeEqual } from "node:crypto";

import { after, type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  dispatchUserDecisionRuns,
  recoverDecisionRunQueue,
} from "@/lib/decision-runs/runner";
import { appEnv } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export async function POST(request: NextRequest) {
  if (!appEnv.decisionRunRecoverySecret) {
    return NextResponse.json(
      { message: "Decision run recovery is not configured." },
      { status: 503 },
    );
  }
  if (!hasValidRecoverySecret(request, appEnv.decisionRunRecoverySecret)) {
    return NextResponse.json({ message: "Invalid recovery token." }, { status: 401 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Invalid recovery request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const recovery = await recoverDecisionRunQueue(parsed.data.limit ?? 100);
    after(async () => {
      const results = await Promise.allSettled(
        recovery.userIds.map((userId) => dispatchUserDecisionRuns(userId)),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error("[decision-runs] recovery dispatch failed", {
            userId: recovery.userIds[index],
            message: getErrorMessage(result.reason),
          });
        }
      });
    });

    return NextResponse.json(
      {
        recoveredRuns: recovery.recoveredRuns,
        recoveredTryOns: recovery.recoveredTryOns,
        scheduledUsers: recovery.userIds.length,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("[decision-runs] recovery failed", { message: getErrorMessage(error) });
    return NextResponse.json({ message: "Decision run recovery failed." }, { status: 500 });
  }
}

function hasValidRecoverySecret(request: NextRequest, expected: string) {
  const authorization = request.headers.get("authorization");
  const actual = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : request.headers.get("x-decision-run-recovery-secret")?.trim();
  if (!actual) return false;

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown_error";
}
