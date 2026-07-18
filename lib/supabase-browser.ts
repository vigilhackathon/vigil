// lib/supabase-browser.ts — the ANON client for browser reads (the nurse board polls
// `patients` directly; RLS allows anon `select` on patients only). Never holds the service
// key; `messages`/alerts/transcript come from server routes, never from here.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** Anon Supabase client (public keys only). */
export function supabaseBrowser(): SupabaseClient {
  if (cached) return cached;
  // Normalize like supabase-server: the venue .env had a trailing /rest/v1/ (STATUS decision).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("supabase-browser: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing");
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
