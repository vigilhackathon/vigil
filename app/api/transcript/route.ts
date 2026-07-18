// GET /api/transcript?patientId= — the FULL conversation record for the EMR patient tab
// (nurse-side: includes traces + alert rows, unlike the patient-safe /api/state).
// Server-side read only — messages has no anon RLS policy by design.
import { supabaseServer } from "@/lib/supabase-server";
import type { ApiError } from "@/lib/types";

export async function GET(req: Request): Promise<Response> {
  const patientId = new URL(req.url).searchParams.get("patientId");
  if (!patientId) {
    return Response.json({ error: "patientId required" } satisfies ApiError, { status: 400 });
  }

  const db = supabaseServer();
  const { data: patient, error: pErr } = await db
    .from("patients")
    .select("id")
    .eq("id", patientId)
    .maybeSingle();
  if (pErr) return Response.json({ error: pErr.message } satisfies ApiError, { status: 500 });
  if (!patient) {
    return Response.json({ error: "patient not found" } satisfies ApiError, { status: 404 });
  }

  const { data: messages, error } = await db
    .from("messages")
    .select("id, role, content, trace, created_at")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: true });
  if (error) return Response.json({ error: error.message } satisfies ApiError, { status: 500 });

  return Response.json({ messages: messages ?? [] });
}
