// lib/checkin-service.ts — VIG-9: THE one brain. Every check-in, from every channel, funnels
// through processCheckin(): the SMS webhook (live model), the voice-call result handler, and
// the demo driver (scripted glue, real guardrail). No route ever HTTP-fetches another route.
//
// Architecture (CLAUDE.md / ARCHITECTURE.md — don't deviate):
// - Protocol is CDS-authored ONCE per visit (MockCds.author) then FROZEN on patients.protocol.
// - Baseline ACCUMULATES across one-at-a-time posts; complete flips only when every baseline
//   question id is answered; flags are evaluated on every accumulated update (a red chip
//   mid-baseline escalates immediately).
// - The guardrail (lib/guardrail.ts) is the deterministic floor; the model can never lower a
//   tier, never invent a flag, never hold the pager. Model failure ⇒ degraded mode, never a 500.
// - One agent message row is persisted per issued question; CheckinTrace is THE contract.
// - Escalation paging itself is PR7 (lib/notifier.ts) — this file exposes the decision
//   (tierFinal / reviewNow / escalateToCall) for that layer to consume.

import { MockCds } from "./cds";
import { runCheckin } from "./agent";
import {
  evaluate,
  parseYesNo,
  validateNextQuestionId,
  type AnswerMap,
} from "./guardrail";
import { notifyEscalation } from "./notifier";
import { supabaseServer } from "./supabase-server";
import type {
  Baseline,
  CdsProtocol,
  Channel,
  CheckinEvent,
  CheckinResponse,
  CheckinResult,
  CheckinTrace,
  Phase,
  Question,
  ScriptedBeat,
  Tier,
} from "./types";

/** Routes catch this and return 404 {error}. */
export class PatientNotFoundError extends Error {}

// --- DB row shapes (only the columns this service touches) ---------------------------------

interface PatientRow {
  id: string;
  name: string;
  age: number | null;
  sex: string | null;
  complaint: string | null;
  esi: number;
  channel: Channel;
  protocol: CdsProtocol | null;
  baseline: Baseline | null;
  tier: Tier;
  review_now: boolean;
  stable_cycles: number;
}

interface MessageRow {
  role: "agent" | "patient" | "system";
  content: string;
  trace: CheckinTrace | null;
}

const FREE_TEXT_CAP = 500; // invariant 6: freeText capped server-side
const HISTORY_LIMIT = 30;

// --- pure helpers ---------------------------------------------------------------------------

function scaleIds(protocol: CdsProtocol): Set<string> {
  return new Set(
    [...protocol.baseline, ...protocol.bank].filter((q) => q.kind === "scale").map((q) => q.id),
  );
}

/** Severity from a set of answers (first scale-question answer that parses as 0–10). */
function severityFrom(protocol: CdsProtocol, answers: AnswerMap): number | null {
  for (const id of scaleIds(protocol)) {
    const v = answers[id];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
  }
  return null;
}

/**
 * Deterministically map an inbound SMS/voice reply onto the pending structured question.
 * Scale → first 0–10 integer in the text. Yes/no chips → parseYesNo. Anything else stays
 * unmapped free text (the model may route it to a confirmation question, but free text alone
 * never escalates — invariant 4).
 */
function mapReplyToAnswer(
  protocol: CdsProtocol,
  pendingQuestionId: string | null,
  body: string,
): AnswerMap {
  if (!pendingQuestionId) return {};
  const q = [...protocol.baseline, ...protocol.bank].find((x) => x.id === pendingQuestionId);
  if (!q) return {};

  if (q.kind === "scale") {
    const m = body.match(/\b(10|[0-9])\b/);
    if (m) return { [q.id]: Number(m[1]) };
    return {};
  }

  if (q.kind === "chips") {
    const values = new Set(q.options.map((o) => o.value));
    // Exact option value typed back (chip tap surfaces, demo driver).
    const trimmed = body.trim().toLowerCase();
    if (values.has(trimmed)) return { [q.id]: trimmed };
    // Deterministic yes/no confirmation parse (SMS "Yes." / "nope" / voice transcript).
    if (values.has("yes") && values.has("no")) {
      const yn = parseYesNo(body);
      if (yn) return { [q.id]: yn };
    }
  }

  return {};
}

/** Next unanswered baseline question, or null when baseline is complete. */
function nextBaselineQuestion(protocol: CdsProtocol, answers: AnswerMap): Question | null {
  return protocol.baseline.find((q) => !(q.id in answers)) ?? null;
}

function questionById(protocol: CdsProtocol, id: string | null): Question | null {
  if (!id) return null;
  return [...protocol.baseline, ...protocol.bank].find((q) => q.id === id) ?? null;
}

/**
 * Deterministic patient ack for degraded / scripted-less turns. Never diagnoses, never
 * reassures, never claims a nurse was told (invariant 8). Red flag ⇒ front-desk line.
 */
function deterministicAck(redConfirmed: boolean): string {
  return redConfirmed
    ? "Thank you for telling me. Please tell the front desk right away."
    : "Thanks, I've noted that. I'll check in with you again soon.";
}

const FRONT_DESK_LINE = "Please tell the front desk right away.";

/**
 * Severity trajectory incl. baseline, without double-counting the baseline reading (the
 * first scale answer IS the baseline — seed from it once, then append per-event readings).
 */
function buildSeverityHistory(
  lastTrace: CheckinTrace | null,
  eventSeverity: number | null,
  severityBaseline: number | null,
): number[] {
  const history = lastTrace ? [...lastTrace.severityHistory] : [];
  if (eventSeverity != null) history.push(eventSeverity);
  if (history.length === 0 && severityBaseline != null) history.push(severityBaseline);
  return history;
}

// --- the brain ------------------------------------------------------------------------------

export interface ProcessOpts {
  /** Demo driver beat: modelRan=false, ack from the script, guardrail still real. */
  scripted?: ScriptedBeat;
}

export async function processCheckin(
  patientId: string,
  event: CheckinEvent,
  opts: ProcessOpts = {},
): Promise<CheckinResponse> {
  const db = supabaseServer();

  // 1. Load patient.
  const { data: patientData, error: pErr } = await db
    .from("patients")
    .select("id, name, age, sex, complaint, esi, channel, protocol, baseline, tier, review_now, stable_cycles")
    .eq("id", patientId)
    .maybeSingle();
  if (pErr) throw new Error(`patients read failed: ${pErr.message}`);
  if (!patientData) throw new PatientNotFoundError(`no patient ${patientId}`);
  const patient = patientData as PatientRow;

  // 2. Protocol: authored once per visit (mock CDS), then frozen on the row.
  let protocol = patient.protocol;
  if (!protocol) {
    protocol = MockCds.author(patient.complaint ?? "cellulitis");
    const { error } = await db.from("patients").update({ protocol }).eq("id", patientId);
    if (error) throw new Error(`protocol freeze failed: ${error.message}`);
  }

  // 3. Recent conversation (model context + answered-id tracking + severity history).
  const { data: msgData, error: mErr } = await db
    .from("messages")
    .select("role, content, trace")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: true })
    .limit(HISTORY_LIMIT);
  if (mErr) throw new Error(`messages read failed: ${mErr.message}`);
  const history = (msgData ?? []) as MessageRow[];

  // Only agent rows carry CheckinTrace — system rows hold Alert payloads (trace.kind='alert').
  const priorTraces = history
    .filter((m) => m.role === "agent")
    .map((m) => m.trace)
    .filter((t): t is CheckinTrace => t != null && "event" in t);
  const lastTrace = priorTraces.length ? priorTraces[priorTraces.length - 1] : null;
  const pendingQuestionId = lastTrace?.questionAskedId ?? null;

  // 4. Normalize the event into structured answers + capped free text.
  const baseline: Baseline = patient.baseline ?? {
    complete: false,
    answers: {},
    severityBaseline: 0,
  };
  let eventAnswers: AnswerMap = {};
  let freeText: string | undefined;

  if (event.type === "answers") {
    eventAnswers = { ...event.answers };
    freeText = event.freeText?.slice(0, FREE_TEXT_CAP);
  } else if (event.type === "sms_in") {
    const body = event.body.slice(0, FREE_TEXT_CAP);
    eventAnswers = mapReplyToAnswer(protocol, pendingQuestionId, body);
    freeText = body;
  } else if (event.type === "call_result") {
    // Only the call agent's structured yes/no confirmations map to answers; free talk is
    // context for the model + hard-phrase scan, never an escalation on its own.
    for (const [qId, raw] of Object.entries(event.structured ?? {})) {
      const mapped = mapReplyToAnswer(protocol, qId, raw);
      Object.assign(eventAnswers, mapped);
    }
    freeText = event.transcript?.slice(0, FREE_TEXT_CAP);
  }
  // timer → no answers, no free text.

  // 5. Baseline accumulation. `complete` flips only when EVERY baseline id is answered.
  const wasBaseline: Phase = baseline.complete ? "checkin" : "baseline";
  if (wasBaseline === "baseline" && Object.keys(eventAnswers).length > 0) {
    baseline.answers = { ...baseline.answers, ...eventAnswers };
    const baselineSev = severityFrom(protocol, baseline.answers);
    if (baselineSev != null) baseline.severityBaseline = baselineSev;
    baseline.complete = protocol.baseline.every((q) => q.id in baseline.answers);
  }
  const phase: Phase = baseline.complete ? "checkin" : "baseline";

  // 6. Severity, delta-anchored to THIS patient's baseline.
  const baselineScaleAnswered = severityFrom(protocol, baseline.answers) != null;
  const severityBaseline = baselineScaleAnswered ? baseline.severityBaseline : null;
  const eventSeverity = severityFrom(protocol, eventAnswers);
  const lastKnownSeverity = lastTrace?.severity ?? null;
  const severityCurrent = eventSeverity ?? lastKnownSeverity ?? severityBaseline;

  // 7. Model (live, checkin phase only) — scripted beats and baseline walking are deterministic.
  //    The §2 funnel lives in runCheckin: any failure returns null ⇒ degraded mode here.
  let model: CheckinResult | null = null;
  let modelRan = false;
  const isLiveModelTurn = !opts.scripted && phase === "checkin" && event.type !== "timer";
  if (isLiveModelTurn) {
    model = await runCheckin({
      protocol,
      baseline,
      history: history
        .filter((m): m is MessageRow & { role: "agent" | "patient" } => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content })),
      event,
    });
    modelRan = model !== null;
  }

  // 8. THE GUARDRAIL — deterministic floor over structured evidence.
  //    Baseline phase evaluates the ACCUMULATED baseline answers (red chip mid-baseline
  //    escalates immediately); checkin phase evaluates this event's interval answers
  //    (prior triggers persist via sticky-escalate + watch hysteresis, not re-fed answers).
  const decision = evaluate({
    protocol,
    answers: phase === "baseline" || wasBaseline === "baseline" ? baseline.answers : eventAnswers,
    freeText,
    severityBaseline,
    severityCurrent,
    model,
    priorTier: patient.tier,
    priorStableCycles: patient.stable_cycles,
  });

  // 9. Next question.
  let nextQuestion: Question | null;
  if (phase === "baseline") {
    nextQuestion = nextBaselineQuestion(protocol, baseline.answers);
  } else {
    const answeredBankIds = [
      ...priorTraces.flatMap((t) => (t.event.type === "answers" ? Object.keys(t.event.answers) : [])),
      ...Object.keys(eventAnswers),
    ].filter((id) => protocol.bank.some((q) => q.id === id));
    const vq = validateNextQuestionId(protocol, model?.next_question_id ?? null, answeredBankIds);
    nextQuestion =
      vq.id === "CUSTOM" && model?.custom_question
        ? { id: "CUSTOM", kind: "free", text: model.custom_question }
        : questionById(protocol, vq.id);
  }

  // 10. Patient ack. Model copy when it ran; deterministic otherwise. A confirmed red flag
  //     ALWAYS carries the front-desk line (prompt hard rule, enforced here too).
  const redConfirmed = decision.confirmedRed.length > 0 || decision.hardPhraseHits.length > 0;
  let patientAck =
    opts.scripted?.patientAck ?? model?.patient_ack ?? deterministicAck(redConfirmed);
  if (redConfirmed && !patientAck.includes(FRONT_DESK_LINE)) {
    patientAck = `${patientAck} ${FRONT_DESK_LINE}`;
  }

  // 11. Escalation call: the model may REQUEST it; only a guardrail-warranted escalation
  //     actually triggers one (wired to the call layer in PR7/PR11).
  const escalateToCall = decision.escalateToCall && decision.tierFinal === "escalate";

  // 12. Persist. Patient message (when they said something), then ONE agent message per
  //     issued question, trace attached (THE contract every route/UI reads).
  const now = new Date();
  const trace: CheckinTrace = {
    phase,
    event,
    channel: patient.channel,
    questionAskedId: nextQuestion?.id ?? null,
    severity: severityCurrent,
    severityHistory: buildSeverityHistory(lastTrace, eventSeverity, severityBaseline),
    confirmedFlags: decision.confirmedFlags,
    hardPhraseHits: decision.hardPhraseHits,
    modelRan,
    modelTierProposed: decision.modelTierProposed,
    rulesTier: decision.rulesTier,
    tierFinal: decision.tierFinal,
    reviewNow: decision.reviewNow,
    escalateToCall,
    createdAt: now.toISOString(),
  };

  const patientContent =
    event.type === "sms_in"
      ? event.body.slice(0, FREE_TEXT_CAP)
      : event.type === "answers"
        ? [JSON.stringify(event.answers), event.freeText].filter(Boolean).join(" — ")
        : event.type === "call_result"
          ? (event.transcript?.slice(0, FREE_TEXT_CAP) ?? "[call completed]")
          : null;

  const rows: Array<{ patient_id: string; role: string; content: string; trace: CheckinTrace | null }> = [];
  if (patientContent) {
    rows.push({ patient_id: patientId, role: "patient", content: patientContent, trace: null });
  }
  rows.push({
    patient_id: patientId,
    role: "agent",
    content: nextQuestion ? `${patientAck} ${nextQuestion.text}` : patientAck,
    trace,
  });
  const { error: insErr } = await db.from("messages").insert(rows);
  if (insErr) throw new Error(`messages insert failed: ${insErr.message}`);

  // 13. Update the patient row — cadence recomputed from the FROZEN protocol map each event
  //     (never compounds); stable_cycles from the guardrail; escalate sticky by construction.
  const cadence = decision.cadenceMinutes;
  const { error: updErr } = await db
    .from("patients")
    .update({
      baseline,
      tier: decision.tierFinal,
      review_now: decision.reviewNow || (patient.review_now && decision.tierFinal !== "routine"),
      tier_reason:
        model?.reason_one_liner ||
        decision.confirmedFlags.map((f) => protocol.red[f] ?? protocol.watch[f] ?? f).join("; ") ||
        null,
      trend: model?.trend_summary || trace.severityHistory.join("→") || null,
      stable_cycles: decision.stableCycles,
      cadence_minutes: cadence,
      next_checkin_due: new Date(now.getTime() + cadence * 60_000).toISOString(),
      last_response_at: patientContent ? now.toISOString() : undefined,
    })
    .eq("id", patientId);
  if (updErr) throw new Error(`patients update failed: ${updErr.message}`);

  if (decision.discardedFlags.length > 0) {
    console.warn(`[guardrail] discarded model flag ids for ${patientId}:`, decision.discardedFlags);
  }

  // 14. Nurse paging (VIG-12): every escalation flows through the notifier's policy —
  //     same-reason dedup means a repeat category updates the alert instead of re-paging.
  //     Only fires on a deterministic escalate; a notifier failure must not 500 a check-in.
  if (decision.tierFinal === "escalate") {
    const reason =
      model?.reason_one_liner ||
      decision.confirmedFlags.map((f) => protocol.red[f] ?? protocol.watch[f] ?? f).join("; ") ||
      (decision.hardPhraseHits.length > 0
        ? `patient reported "${decision.hardPhraseHits[0]}"`
        : "deterministic escalation");
    try {
      await notifyEscalation(db, {
        patientId,
        name: patient.name,
        ageSex: `${patient.age ?? "?"}${(patient.sex ?? "").charAt(0).toUpperCase()}`,
        complaint: protocol.complaint,
        reason,
        trend: model?.trend_summary || trace.severityHistory.join("→") || "n/a",
        confirmedRed: decision.confirmedRed,
        hardPhraseHits: decision.hardPhraseHits,
      });
    } catch (e) {
      console.error("[notifier] failed (check-in continues):", e);
    }
  }

  return {
    patient_ack: patientAck,
    next_question: nextQuestion,
    tier: decision.tierFinal,
    review_now: trace.reviewNow,
    escalate_to_call: escalateToCall,
    trace,
  };
}
