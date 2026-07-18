// GET /api/state?patientId= — VIG-10: server-state snapshot for a patient.
//
// The patient web thread (VIG-11) and the nurse EMR UI (VIG-15) both read from here rather
// than holding a parallel client state machine. Returns the patient row, the latest agent
// message (+ its CheckinTrace), the question the patient is currently on, and ack status.

import { supabaseServer } from "../../../lib/supabase-server";
import type { ApiError, Baseline, CdsProtocol, CheckinTrace, Question } from "../../../lib/types";

interface PatientStateRow {
  id: string;
  name: string;
  age: number | null;
  sex: string | null;
  complaint: string | null;
  esi: number;
  channel: string;
  tier: string;
  review_now: boolean;
  tier_reason: string | null;
  trend: string | null;
  cadence_minutes: number;
  next_checkin_due: string | null;
  last_response_at: string | null;
  ack_at: string | null;
  ack_by: string | null;
  protocol: CdsProtocol | null;
  baseline: Baseline | null;
}

function err(error: string, status: number): Response {
  return Response.json({ error } satisfies ApiError, { status });
}

export async function GET(req: Request): Promise<Response> {
  const patientId = new URL(req.url).searchParams.get("patientId");
  if (!patientId) return err("patientId query param required", 400);

  const db = supabaseServer();

  const { data: patientData, error: pErr } = await db
    .from("patients")
    .select(
      "id, name, age, sex, complaint, esi, channel, tier, review_now, tier_reason, trend, " +
        "cadence_minutes, next_checkin_due, last_response_at, ack_at, ack_by, protocol, baseline",
    )
    .eq("id", patientId)
    .maybeSingle();

  if (pErr) return err(`state read failed: ${pErr.message}`, 500);
  if (!patientData) return err("patient not found", 404);
  const patient = patientData as unknown as PatientStateRow;

  const { data: lastAgentData } = await db
    .from("messages")
    .select("content, trace, created_at")
    .eq("patient_id", patientId)
    .eq("role", "agent")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastAgent = lastAgentData as
    | { content: string; trace: CheckinTrace | null; created_at: string }
    | null;

  // Current question: next unanswered baseline question until baseline is complete; then the
  // question the last agent turn asked.
  const protocol = patient.protocol;
  const answers = patient.baseline?.answers ?? {};
  const baselineComplete = patient.baseline?.complete ?? false;

  let currentQuestion: Question | null = null;
  if (protocol) {
    if (!baselineComplete) {
      currentQuestion = protocol.baseline.find((q) => !(q.id in answers)) ?? null;
    } else {
      const askedId = lastAgent?.trace?.questionAskedId ?? null;
      currentQuestion = askedId
        ? ([...protocol.baseline, ...protocol.bank].find((q) => q.id === askedId) ?? null)
        : null;
    }
  }

  return Response.json({
    patient,
    lastAgentMessage: lastAgent ? { content: lastAgent.content, trace: lastAgent.trace } : null,
    currentQuestion,
    ackAt: patient.ack_at,
    baselineComplete,
  });
}
