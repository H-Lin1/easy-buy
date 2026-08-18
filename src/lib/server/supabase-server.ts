import "server-only";

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { appEnv } from "@/lib/env";

export class RequestAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 500,
  ) {
    super(message);
    this.name = "RequestAuthError";
  }
}

export function createServiceRoleSupabaseClient() {
  if (!appEnv.supabaseUrl || !appEnv.supabaseServiceRoleKey) {
    throw new RequestAuthError("Supabase service role is not configured.", 500);
  }

  return createClient(appEnv.supabaseUrl, appEnv.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export async function authenticateSupabaseRequest(request: NextRequest): Promise<{
  user: User;
  token: string;
  supabase: SupabaseClient;
}> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new RequestAuthError("Missing auth token.", 401);
  }
  if (!appEnv.supabaseUrl || !appEnv.supabaseAnonKey) {
    throw new RequestAuthError("Supabase is not configured.", 500);
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) throw new RequestAuthError("Missing auth token.", 401);

  const supabase = createClient(appEnv.supabaseUrl, appEnv.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    throw new RequestAuthError("Invalid auth token.", 401);
  }

  return { user: data.user, token, supabase };
}
