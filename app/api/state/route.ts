// GET /api/state?patientId= — the patient thread is SERVER-STATE-DRIVEN: it polls this (~2s)
// and renders from it. Driver-injected beats appear on the phone automatically because the
// phone is a viewer of server state, never a parallel state machine.
//
// Patient-safe by construction: no traces, no tiers, no flags, no system/alert rows — the
// patient never sees clinical reasoning (safety invariant 8 adjacent).
import { supabaseServer } from "@/lib/supabase-server";
import type { ApiError, Baseline, CdsProtocol, CheckinTrace, Question } from "@/lib/types";

interface ThreadMessage {
  role: "agent" | "patient";
  content: string;
  createdAt: string;
}

export async function GET(req: Request): Promise<Response> {
  const patientId = new URL(req.url).searchParams.get("patientId");
  if (!patientId) {
    return Response.json({ error: "patientId required" } satisfies ApiError, { status: 400 });
  }

  const db = supabaseServer();
  // NOTE: no ack_at here — v4: after a nurse acknowledges, the agent stays SILENT;
  // the patient page must have no way to render an ack banner.
  const { data: patient, error: pErr } = await db
    .from("patients")
    .select("id, name, phone, protocol, baseline")
    .eq("id", patientId)
    .maybeSingle();
  if (pErr) return Response.json({ error: pErr.message } satisfies ApiError, { status: 500 });
  if (!patient) {
    return Response.json({ error: "patient not found" } satisfies ApiError, { status: 404 });
  }

  const { data: msgs, error: mErr } = await db
    .from("messages")
    .select("role, content, trace, created_at")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: true })
    .limit(100);
  if (mErr) return Response.json({ error: mErr.message } satisfies ApiError, { status: 500 });

  const protocol = patient.protocol as CdsProtocol | null;
  const baseline = patient.baseline as Baseline | null;

  // Latest issued question comes from the newest agent trace (one agent row per question).
  const agentTraces = (msgs ?? [])
    .filter((m) => m.role === "agent" && m.trace && "event" in (m.trace as object))
    .map((m) => m.trace as CheckinTrace);
  const lastTrace = agentTraces.length ? agentTraces[agentTraces.length - 1] : null;

  let currentQuestion: Question | null = null;
  if (protocol) {
    if (!baseline?.complete) {
      // Baseline walk: next unanswered baseline question, deterministically.
      const answered = baseline?.answers ?? {};
      currentQuestion = protocol.baseline.find((q) => answered[q.id] === undefined) ?? null;
    } else if (lastTrace?.questionAskedId) {
      currentQuestion =
        [...protocol.baseline, ...protocol.bank].find((q) => q.id === lastTrace.questionAskedId) ??
        null;
    }
  }

  const thread: ThreadMessage[] = (msgs ?? [])
    .filter((m): m is typeof m & { role: "agent" | "patient" } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at as string }));

  return Response.json({
    patient: { id: patient.id, name: patient.name },
    identityConfirmed: Boolean((baseline?.answers ?? {})["__dob_confirmed"]),
    phoneCaptured: Boolean(patient.phone),
    baselineComplete: Boolean(baseline?.complete),
    currentQuestion,
    messages: thread,
  });
}
