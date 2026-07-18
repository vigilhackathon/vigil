// POST /api/demo — VIG-14: the demo driver's backend. reset | advance(slug, beatIndex).
// 503 unless DEMO_MODE=true. Beats run through processCheckin with the REAL guardrail
// (modelRan=false, ack from lib/scripts.ts) — never through HTTP to another route.
import { z } from "zod";
import { processCheckin } from "@/lib/checkin-service";
import { MockCds } from "@/lib/cds";
import { DEMO_PATIENTS, DEMO_SEED_ROWS, beatFor } from "@/lib/scripts";
import { supabaseServer } from "@/lib/supabase-server";
import type { ApiError, CdsProtocol, CheckinTrace } from "@/lib/types";

export const maxDuration = 30;

/**
 * Author a monitoring protocol for a complaint, or null for display-only patients.
 * MockCds only authors cellulitis (and throws otherwise); the non-cellulitis demo-board
 * patients are display-only, so they get no protocol (the column is nullable). This guard
 * keeps reset from throwing on their varied complaints (low back pain, abdominal pain, fever).
 */
function authorProtocol(complaint: string): CdsProtocol | null {
  try {
    return MockCds.author(complaint);
  } catch {
    return null;
  }
}

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reset"),
    // Optional live phone for the hero (so the escalation call rings a real handset on stage).
    heroPhone: z.string().min(7).max(20).optional(),
  }),
  z.object({
    action: z.literal("advance"),
    slug: z.string(),
    beatIndex: z.number().int().min(0),
  }),
]);

export async function POST(req: Request): Promise<Response> {
  if (process.env.DEMO_MODE !== "true") {
    return Response.json({ error: "demo mode disabled" } satisfies ApiError, { status: 503 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid body" } satisfies ApiError, { status: 400 });
  }

  const db = supabaseServer();

  if (body.action === "reset") {
    // Recreate everything at exact T0: wipe prior demo rows (messages cascade), then seed.
    const { error: delErr } = await db.from("patients").delete().eq("is_demo_seed", true);
    if (delErr) {
      return Response.json({ error: delErr.message } satisfies ApiError, { status: 500 });
    }

    const patients: { slug: string; patientId: string }[] = [];
    for (const p of DEMO_PATIENTS) {
      const { data, error } = await db
        .from("patients")
        .insert({
          name: p.name,
          age: p.age,
          sex: p.sex,
          dob: p.dob,
          phone: p.slug === "chen" ? (body.heroPhone ?? p.phone) : p.phone,
          complaint: p.complaint,
          esi: p.esi,
          triage_note: p.triage_note,
          vitals: p.vitals,
          is_demo_seed: true,
          // Protocol frozen up front + thread identity pre-confirmed: the phone opens straight
          // into the conversation; beat 0 IS the baseline. (Driven patients are cellulitis.)
          protocol: authorProtocol(p.complaint),
          baseline: { complete: false, answers: { __dob_confirmed: "yes" }, severityBaseline: 0 },
        })
        .select("id")
        .single();
      if (error || !data) {
        return Response.json(
          { error: `reset failed for ${p.slug}: ${error?.message}` } satisfies ApiError,
          { status: 500 },
        );
      }
      patients.push({ slug: p.slug, patientId: data.id as string });
    }

    const seedIds: string[] = [];
    for (const s of DEMO_SEED_ROWS) {
      const { data } = await db
        .from("patients")
        // Display-only rows: varied complaints, no monitoring protocol (guarded → null).
        .insert({ ...s, is_demo_seed: true, protocol: authorProtocol(s.complaint) })
        .select("id")
        .single();
      if (data) seedIds.push(data.id as string);
    }

    return Response.json({ patients, seedIds });
  }

  // --- advance ---------------------------------------------------------------------------
  const beat = beatFor(body.slug, body.beatIndex);
  if (!beat) {
    return Response.json({ error: "unknown slug/beat" } satisfies ApiError, { status: 400 });
  }

  const demoPatient = DEMO_PATIENTS.find((p) => p.slug === body.slug);
  const { data: patient, error: pErr } = await db
    .from("patients")
    .select("id")
    .eq("is_demo_seed", true)
    .eq("name", demoPatient?.name ?? "")
    .maybeSingle();
  if (pErr) return Response.json({ error: pErr.message } satisfies ApiError, { status: 500 });
  if (!patient) {
    return Response.json(
      { error: "demo patient not found — run reset first" } satisfies ApiError,
      { status: 404 },
    );
  }
  const patientId = patient.id as string;

  // Idempotency: a beat is one scripted answers-event → one agent trace with modelRan=false.
  // Re-posting an already-applied index is a no-op ({applied:false}).
  const { data: msgs, error: mErr } = await db
    .from("messages")
    .select("role, trace")
    .eq("patient_id", patientId);
  if (mErr) return Response.json({ error: mErr.message } satisfies ApiError, { status: 500 });
  const appliedBeats = (msgs ?? []).filter((m) => {
    if (m.role !== "agent" || !m.trace) return false;
    const t = m.trace as CheckinTrace;
    return "event" in t && t.event.type === "answers" && t.modelRan === false;
  }).length;

  if (body.beatIndex < appliedBeats) {
    return Response.json({ ok: true, applied: false });
  }

  const result = await processCheckin(patientId, beat.event, { scripted: beat });
  const tierMatches = result.tier === beat.expectedTier;
  if (!tierMatches) {
    console.error(
      `[demo] beat ${body.slug}#${body.beatIndex} tier mismatch: expected ${beat.expectedTier}, got ${result.tier}`,
    );
  }

  return Response.json({
    ok: true,
    applied: true,
    tier: result.tier,
    expectedTier: beat.expectedTier,
    tierMatches,
    patientAck: result.patient_ack,
    escalateToCall: result.escalate_to_call,
  });
}
