// POST /api/confirm — enroll-UI identity gate: server-side DOB check + phone capture.
// The DOB never leaves the server; the page only learns ok/not-ok. Phone is captured so the
// escalation call (VIG-16) can ring the right handset. Confirmation is recorded as an extra
// key in the baseline answers JSON (additive; never satisfies a protocol question id).
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase-server";
import type { ApiError, Baseline } from "@/lib/types";

const BodySchema = z.object({
  patientId: z.string().uuid(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // from <input type="date">
  phone: z.string().min(7).max(20).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid body" } satisfies ApiError, { status: 400 });
  }

  const db = supabaseServer();
  const { data: patient, error } = await db
    .from("patients")
    .select("id, dob, phone, baseline")
    .eq("id", body.patientId)
    .maybeSingle();
  if (error) return Response.json({ error: error.message } satisfies ApiError, { status: 500 });
  if (!patient) {
    return Response.json({ error: "patient not found" } satisfies ApiError, { status: 404 });
  }

  const baseline: Baseline = (patient.baseline as Baseline | null) ?? {
    complete: false,
    answers: {},
    severityBaseline: 0,
  };
  const alreadyConfirmed = Boolean(baseline.answers["__dob_confirmed"]);

  // DOB step. A seeded demo patient without a dob on file confirms on any input (logged).
  if (body.dob && !alreadyConfirmed) {
    const onFile = patient.dob as string | null;
    if (onFile && onFile !== body.dob) {
      return Response.json({ ok: false, reason: "dob_mismatch" });
    }
    if (!onFile) console.warn(`[confirm] no dob on file for ${body.patientId}; accepting`);
    baseline.answers = { ...baseline.answers, __dob_confirmed: "yes" };
  }

  const update: { baseline: Baseline; phone?: string } = { baseline };
  if (body.phone) update.phone = body.phone;

  const { error: updErr } = await db.from("patients").update(update).eq("id", body.patientId);
  if (updErr) return Response.json({ error: updErr.message } satisfies ApiError, { status: 500 });

  return Response.json({
    ok: alreadyConfirmed || Boolean(body.dob) || Boolean(body.phone),
    identityConfirmed: Boolean(baseline.answers["__dob_confirmed"]),
    phoneCaptured: Boolean(body.phone || patient.phone),
  });
}
