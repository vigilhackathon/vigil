// POST /api/ack — VIG-10: nurse acknowledges an alert.
//
// Unauthenticated demo acknowledgment (ack_by = "charge-desk-demo"); production ties this to
// nurse identity via the hospital's SSO/badge — we never claim identity was verified.
// After ack the agent stays SILENT — the patient is NOT told; the nurse just goes (v4 rule).

import { z } from "zod";
import { supabaseServer } from "@/lib/supabase-server";
import type { ApiError } from "@/lib/types";

const Body = z.object({ patientId: z.string().min(1) });

function err(error: string, status: number): Response {
  return Response.json({ error } satisfies ApiError, { status });
}

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return err("invalid JSON body", 400);
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return err("body must be { patientId }", 400);
  }

  const db = supabaseServer();
  const { data, error } = await db
    .from("patients")
    .update({ ack_at: new Date().toISOString(), ack_by: "charge-desk-demo" })
    .eq("id", parsed.data.patientId)
    .select("id")
    .maybeSingle();

  if (error) return err(`ack failed: ${error.message}`, 500);
  if (!data) return err("patient not found", 404);

  return Response.json({ ok: true }, { status: 200 });
}
