// lib/voice-call.ts — VIG-16 (PR11): the escalation voice call.
//
// Flow: checkin-service, on a deterministic escalate, calls placeEscalationCall() → ElevenLabs
// Conversational AI dials the patient over Twilio Voice with per-visit context (dynamic vars
// built from the FROZEN CdsProtocol). After the call, ElevenLabs POSTs its analysis to
// /api/call-result, which uses parseCallResult() to turn the agent's structured findings into
// deterministic yes/no answers and feeds them back through the guardrail (checkin-service).
//
// Safety: the call GATHERS; it never decides. Only structured confirmations map to flags (via
// the exact protocol option values), and the transcript is passed separately as free text so the
// guardrail's hard-phrase scan still runs. The model/agent never lowers a tier or holds the pager.
//
// Env (all required to actually place a call — otherwise this no-ops gracefully):
//   ELEVENLABS_API_KEY · ELEVENLABS_AGENT_ID · ELEVENLABS_AGENT_PHONE_NUMBER_ID

import type { CdsProtocol, Option, Question } from "./types";

const EL_BASE = "https://api.elevenlabs.io";

/** Bank chips questions that confirm a RED flag — the yes/no concerns the call should probe. */
function redProbeQuestions(protocol: CdsProtocol): Array<Question & { kind: "chips"; options: Option[] }> {
  return protocol.bank.filter(
    (q): q is Question & { kind: "chips"; options: Option[] } =>
      q.kind === "chips" && q.options.some((o) => (o.flags?.length ?? 0) > 0),
  );
}

// --- placing the call -----------------------------------------------------------------------

export interface CallContext {
  patient_name: string;
  complaint: string;
  context: string;
  reason_for_call: string;
  areas_to_probe: string;
  patient_id: string; // echoed back via the webhook for correlation
}

export function buildCallContext(args: {
  patientId: string;
  name: string;
  protocol: CdsProtocol;
  severityHistory: number[];
  confirmedFlags: string[];
  reason: string;
}): CallContext {
  const { patientId, name, protocol, severityHistory, confirmedFlags, reason } = args;
  const areas = redProbeQuestions(protocol)
    .map((q) => `- ${q.text}`)
    .join("\n");
  const trend = severityHistory.length ? `severity ${severityHistory.join("→")}` : "no severity recorded";
  const flags = confirmedFlags.length
    ? `already reported: ${confirmedFlags.map((f) => protocol.red[f] ?? protocol.watch[f] ?? f).join("; ")}`
    : "no red flags confirmed yet";
  return {
    patient_name: name || "there",
    complaint: protocol.complaint,
    context: `${trend}; ${flags}`,
    reason_for_call: reason || "your recent check-in suggested things may be changing",
    areas_to_probe: areas || "Have your symptoms gotten worse since we last checked?",
    patient_id: patientId,
  };
}

export interface PlaceCallResult {
  ok: boolean;
  conversationId: string | null;
  detail?: string;
}

/** Trigger an ElevenLabs → Twilio outbound call. No-ops (ok:false) if env or phone is missing. */
export async function placeEscalationCall(
  toNumber: string | null,
  ctx: CallContext,
): Promise<PlaceCallResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const phoneId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID;
  if (!apiKey || !agentId || !phoneId) {
    return { ok: false, conversationId: null, detail: "ElevenLabs call env not configured" };
  }
  if (!toNumber) return { ok: false, conversationId: null, detail: "patient has no phone number" };

  const resp = await fetch(`${EL_BASE}/v1/convai/twilio/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      agent_phone_number_id: phoneId,
      to_number: toNumber,
      conversation_initiation_client_data: { dynamic_variables: { ...ctx } },
    }),
  });
  const text = await resp.text();
  if (!resp.ok) return { ok: false, conversationId: null, detail: `${resp.status} ${text.slice(0, 200)}` };
  let conversationId: string | null = null;
  try {
    conversationId = (JSON.parse(text) as { conversation_id?: string }).conversation_id ?? null;
  } catch {
    /* keep null */
  }
  return { ok: true, conversationId };
}

// --- parsing the post-call result -----------------------------------------------------------

export interface CallDataCollection {
  confirmed_findings?: string | null;
  denied_findings?: string | null;
  patient_summary?: string | null;
  severity_0_10?: number | string | null;
  sounds_worse?: boolean | null;
}

const STOPWORDS = new Set([
  "the", "and", "you", "your", "are", "was", "that", "this", "have", "has", "for", "with",
  "right", "now", "last", "time", "over", "any", "does", "feel", "from", "since", "else",
  "about", "than", "too", "get", "getting", "line", "drew", "area", "red", "like", "look",
  "looks", "there", "here", "some", "into", "onto", "what", "when", "where",
]);

function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** A finding text "echoes" a question if ≥2 of its keywords appear, or one distinctive (≥6) one. */
function echoes(questionText: string, hay: string): boolean {
  const kw = keywords(questionText);
  const hits = kw.filter((k) => hay.includes(k));
  return hits.length >= 2 || kw.some((k) => k.length >= 6 && hay.includes(k));
}

/**
 * Map the agent's post-call data collection onto structured answers for the guardrail,
 * DETERMINISTICALLY. A red-flag probe is confirmed only if its (verbatim) wording is echoed in
 * `confirmed_findings` → we set its red-bearing option value; echoed in `denied_findings` → its
 * negative option. Everything else stays unmapped (free talk never escalates on its own).
 * Also lifts a stated severity onto the bank's scale question.
 */
export function parseCallResult(
  protocol: CdsProtocol,
  dc: CallDataCollection,
): { structured: Record<string, string> } {
  const structured: Record<string, string> = {};
  const confirmed = (dc.confirmed_findings ?? "").toLowerCase();
  const denied = (dc.denied_findings ?? "").toLowerCase();

  for (const q of redProbeQuestions(protocol)) {
    const redOpt = q.options.find((o) => (o.flags?.length ?? 0) > 0);
    if (!redOpt) continue;
    const negOpt = q.options.find((o) => !(o.flags?.length ?? 0) && !(o.watch?.length ?? 0));
    if (echoes(q.text, confirmed)) structured[q.id] = redOpt.value;
    else if (negOpt && echoes(q.text, denied)) structured[q.id] = negOpt.value;
  }

  const sev = dc.severity_0_10;
  if (sev != null && sev !== "") {
    const scale = protocol.bank.find((q) => q.kind === "scale");
    const n = Number(sev);
    if (scale && Number.isFinite(n) && n >= 0 && n <= 10) structured[scale.id] = String(Math.round(n));
  }

  return { structured };
}
