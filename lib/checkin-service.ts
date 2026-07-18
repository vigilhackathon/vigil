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
import { evaluate, parseYesNo, type AnswerMap } from "./guardrail";
import { notifyEscalation } from "./notifier";
import { buildCallContext, placeEscalationCall } from "./voice-call";
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
  phone: string | null;
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
    const trimmed = body.trim().toLowerCase();
    // Exact option value typed back (demo driver / power users).
    if (values.has(trimmed)) return { [q.id]: trimmed };
    // Deterministic yes/no confirmation parse (real SMS: "Yes." / "nope" / voice transcript).
    if (values.has("yes") && values.has("no")) {
      const yn = parseYesNo(body);
      if (yn) return { [q.id]: yn };
    }
    // Natural-text label match (real SMS: "up to the knee" → the matching chip option).
    if (trimmed) {
      const hit = q.options.find((o) => {
        const lbl = o.label.toLowerCase();
        return lbl === trimmed || lbl.includes(trimmed) || trimmed.includes(lbl);
      });
      if (hit) return { [q.id]: hit.value };
    }
  }

  return {};
}

/** Human-readable transcript line for a structured answer ("4 · Up to the knee"), not raw JSON. */
function answersToText(protocol: CdsProtocol, answers: AnswerMap): string {
  const all = [...protocol.baseline, ...protocol.bank];
  const parts: string[] = [];
  for (const [qid, value] of Object.entries(answers)) {
    const q = all.find((x) => x.id === qid);
    if (q?.kind === "chips") {
      const chosen = Array.isArray(value) ? value : [value];
      const labels = chosen.map(
        (v) => q.options.find((o) => o.value === String(v))?.label ?? String(v),
      );
      parts.push(labels.join(", "));
    } else {
      parts.push(String(value));
    }
  }
  return parts.join(" · ");
}

/** Next unanswered baseline question, or null when baseline is complete. */
function nextBaselineQuestion(protocol: CdsProtocol, answers: AnswerMap): Question | null {
  return protocol.baseline.find((q) => !(q.id in answers)) ?? null;
}

function questionById(protocol: CdsProtocol, id: string | null): Question | null {
  if (!id) return null;
  return [...protocol.baseline, ...protocol.bank].find((q) => q.id === id) ?? null;
}

// Deterministic patient acks. Never diagnose, never reassure ("you're fine" banned), never
// claim a nurse was notified (invariant 8). "Always call first": a concerning text answer is
// NOT met with a "go to the front desk" instruction — the care team calls to verify.
// Kept SMS-short (real texts). No "front desk"; call-first announces the call.
const ACK_CALLING = "Thanks — a nurse will call you shortly to check in.";
const ACK_ROUTINE = "Got it, thanks.";
const ACK_POST_CALL = "Thanks for talking just now.";
const ACK_SCREEN_DONE = "Thanks — all set for now. I'll check in again a bit later.";

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
    .select("id, name, age, sex, complaint, esi, phone, channel, protocol, baseline, tier, review_now, stable_cycles")
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

  // 9. Next question. The TEXT is a SHORT SCREEN — at most TEXT_SCREEN_MAX quick questions per
  //    check-in round (a round = since the last timer/scheduled check-in), re-asked each round.
  //    Detailed probing is the voice call's job, not the text's. (Overridden to null below when
  //    a flag triggers the call — the call takes over the follow-up.)
  const TEXT_SCREEN_MAX = 4;
  let nextQuestion: Question | null;
  if (phase === "baseline") {
    nextQuestion = nextBaselineQuestion(protocol, baseline.answers);
  } else {
    const bankIds = new Set(protocol.bank.map((q) => q.id));
    // Bank questions already asked THIS round (walk back to the round-starting timer trace).
    const askedThisRound = new Set<string>();
    for (let i = priorTraces.length - 1; i >= 0; i--) {
      const t = priorTraces[i];
      if (t.questionAskedId && bankIds.has(t.questionAskedId)) askedThisRound.add(t.questionAskedId);
      if (t.event.type === "timer") break; // round boundary
    }
    // The TEXT screen is yes/no-friendly ONLY: the 0–10 scale + true yes/no chips. Multi-option
    // chips (e.g. "a lot / a little / no") and free text don't parse from a typed reply — those
    // are the voice call's territory.
    const isYesNo = (q: Question) =>
      q.kind === "chips" &&
      q.options.some((o) => o.value === "yes") &&
      q.options.some((o) => o.value === "no");
    const screenBank = protocol.bank.filter((q) => q.kind === "scale" || isYesNo(q));
    if (askedThisRound.size >= TEXT_SCREEN_MAX) {
      nextQuestion = null; // short screen complete for this round
    } else {
      // Honor the model's pick if it's a not-yet-asked screen question; else next unasked one.
      const pick = model?.next_question_id;
      const validPick =
        pick && bankIds.has(pick) && !askedThisRound.has(pick) && screenBank.some((q) => q.id === pick)
          ? pick
          : (screenBank.find((q) => !askedThisRound.has(q.id))?.id ?? null);
      nextQuestion = questionById(protocol, validPick);
    }
  }

  // 10. TWO-STAGE ESCALATION — "always call first" (human decision 2026-07-18).
  //     A concern found in the TEXT triggers a VERIFICATION CALL, not a nurse page. Only a
  //     voice-verified event (call_result) — or an already-committed (sticky) escalation —
  //     reaches 'escalate' + pages. The deterministic guardrail still computes the clinical
  //     floor (trace.rulesTier / confirmedFlags); this layer decides the ACTION.
  const isCallResult = event.type === "call_result";
  const alreadyEscalated = patient.tier === "escalate";
  // A red flag or hard phrase in the text (or a model call-request) is a "concern" worth a call.
  const textConcern =
    decision.confirmedRed.length > 0 ||
    decision.hardPhraseHits.length > 0 ||
    decision.escalateToCall;

  let committedTier: Tier;
  let callRequested = false;
  let paging = false;

  if (isCallResult) {
    // Voice-verified: the guardrail's escalate is real → page.
    committedTier = decision.tierFinal;
    paging = committedTier === "escalate";
  } else if (alreadyEscalated) {
    // Sticky post-call escalation; a later text turn never re-pages (dedup) nor downgrades.
    committedTier = "escalate";
  } else if (textConcern) {
    // Hold the page, place the call. Escalate-grade text is capped to watch until verified.
    committedTier = decision.tierFinal === "escalate" ? "watch" : decision.tierFinal;
    callRequested = true;
  } else {
    committedTier = decision.tierFinal;
  }

  // Flag caught in the text → STOP texting; the voice call takes over the follow-up questions.
  if (callRequested) nextQuestion = null;
  // Short screen finished with nothing flaggable → end this round (wait for the next check-in).
  const screenComplete = phase === "checkin" && !callRequested && !isCallResult && nextQuestion === null;

  // 11. Patient ack. Scripted wording wins; a call-triggering turn gets a deterministic ack
  //     (guarantees no "front desk", always announces the call); otherwise model / neutral copy.
  const kickoffAck =
    history.length === 0 ? "Hi — a couple quick questions while you wait." : "Checking in.";
  let patientAck: string;
  if (opts.scripted) {
    patientAck = opts.scripted.patientAck;
  } else if (callRequested) {
    patientAck = ACK_CALLING;
  } else if (isCallResult) {
    patientAck = ACK_POST_CALL;
  } else if (screenComplete) {
    patientAck = ACK_SCREEN_DONE;
  } else if (event.type === "timer") {
    patientAck = kickoffAck;
  } else {
    patientAck = model?.patient_ack ?? ACK_ROUTINE;
  }

  // `escalate_to_call` now means "place the verification call" — the signal VIG-16's call
  // layer acts on. False on the call_result turn itself (the call already happened).
  const escalateToCall = callRequested;

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
    rulesTier: decision.rulesTier, // the clinical floor (may be escalate even when we call-first)
    tierFinal: committedTier, // the ACTIONED tier (call-first holds text escalate at watch)
    reviewNow: decision.reviewNow || callRequested,
    escalateToCall,
    createdAt: now.toISOString(),
  };

  const patientContent =
    event.type === "sms_in"
      ? event.body.slice(0, FREE_TEXT_CAP)
      : event.type === "answers"
        ? [answersToText(protocol, event.answers), event.freeText].filter(Boolean).join(" — ")
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
      tier: committedTier,
      review_now: decision.reviewNow || callRequested || (patient.review_now && committedTier !== "routine"),
      // "calling" surfaces the 📞 board state while we verify by voice; cleared once resolved.
      suggested_action: callRequested ? "calling" : committedTier === "escalate" ? "seen" : null,
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

  // 14. Escalation VOICE CALL (VIG-16) under "ALWAYS CALL FIRST": when the TEXT screen catches a
  //     concern (`callRequested`), VIGIL places the verification call and the nurse is NOT paged
  //     yet. Env/phone-gated — a no-op when unconfigured (the demo driver then injects the
  //     call_result). Never on a call_result event (no loops); failure never 500s a check-in.
  if (callRequested && event.type !== "call_result") {
    try {
      const callReason =
        decision.confirmedFlags.map((f) => protocol.red[f] ?? protocol.watch[f] ?? f).join("; ") ||
        (decision.hardPhraseHits.length > 0
          ? `patient reported "${decision.hardPhraseHits[0]}"`
          : "your recent check-in suggested things may be changing");
      const res = await placeEscalationCall(
        patient.phone,
        buildCallContext({
          patientId,
          name: patient.name,
          protocol,
          severityHistory: trace.severityHistory,
          confirmedFlags: decision.confirmedFlags,
          reason: callReason,
        }),
      );
      if (res.ok) {
        console.log(`[voice-call] placed for ${patientId} (conversation ${res.conversationId})`);
        await db.from("messages").insert({
          patient_id: patientId,
          role: "system",
          content: "VIGIL placed a verification call to the patient.",
          trace: { kind: "call", conversationId: res.conversationId },
        });
      } else {
        console.warn("[voice-call] not placed:", res.detail);
      }
    } catch (e) {
      console.error("[voice-call] failed (check-in continues):", e);
    }
  }

  // 15. Nurse paging (VIG-12): fires ONLY when a call_result VERIFIED the escalation (`paging`) —
  //     never from a text turn ("always call first"). Same-reason dedup lives in the notifier;
  //     a notifier failure must not 500 a check-in.
  if (paging) {
    // Pager copy is DETERMINISTIC-FIRST: confirmed flag labels + numeric trend (the frozen
    // "WR:" format wants facts, not model prose). Model wording only when no flag exists.
    const reason =
      decision.confirmedFlags.map((f) => protocol.red[f] ?? protocol.watch[f] ?? f).join("; ") ||
      (decision.hardPhraseHits.length > 0
        ? `patient reported "${decision.hardPhraseHits[0]}"`
        : model?.reason_one_liner || "deterministic escalation");
    try {
      await notifyEscalation(db, {
        patientId,
        name: patient.name,
        ageSex: `${patient.age ?? "?"}${(patient.sex ?? "").charAt(0).toUpperCase()}`,
        complaint: protocol.complaint,
        reason,
        trend: trace.severityHistory.join("→") || model?.trend_summary || "n/a",
        confirmedRed: decision.confirmedRed,
        hardPhraseHits: decision.hardPhraseHits,
        deltaDriven:
          decision.rulesTier === "escalate" &&
          decision.confirmedRed.length === 0 &&
          decision.hardPhraseHits.length === 0,
      });
    } catch (e) {
      console.error("[notifier] failed (check-in continues):", e);
    }
  }

  return {
    patient_ack: patientAck,
    next_question: nextQuestion,
    tier: committedTier,
    review_now: trace.reviewNow,
    escalate_to_call: escalateToCall,
    trace,
  };
}
