// lib/supabase-server.ts — THE secret boundary (see CLAUDE.md: boundary is a module, not a comment).
// Holds the service-role client; importable only from server code. Client components must import
// lib/supabase-browser.ts (anon) instead. SUPABASE_SERVICE_ROLE_KEY never appears client-side.

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** Service-role Supabase client (bypasses RLS — all writes + transcript reads go through here). */
export function supabaseServer(): SupabaseClient {
  if (cached) return cached;
  // Normalize: supabase-js wants the bare project URL and appends /rest/v1 itself.
  // (The venue .env.local was pasted with a trailing /rest/v1/ — tolerate it.)
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("supabase-server: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
