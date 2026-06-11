import "server-only";

import { NextRequest } from "next/server";

export function getOptionalUserId(request: NextRequest) {
  return (
    request.headers.get("x-user-id") ??
    request.nextUrl.searchParams.get("userId") ??
    process.env.DEMO_USER_ID ??
    null
  );
}

export function mapDecisionStatusToDb(status: string) {
  if (
    status === "decided_to_buy" ||
    status === "saved_for_later" ||
    status === "not_considering"
  ) {
    return status;
  }

  return null;
}
