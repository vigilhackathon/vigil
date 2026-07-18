// lib/types.ts — VIGIL v4 FROZEN contracts.
// Do not change after PR0 without both humans agreeing (see CLAUDE.md). Every route + UI reads these shapes.

export type Tier = "routine" | "watch" | "escalate";
export type Channel = "sms" | "voice";
export type Phase = "baseline" | "checkin";
export type Role = "agent" | "patient" | "system";

export interface Option {
  label: string;
  value: string;
  flags?: string[]; // red flag ids this option confirms
  watch?: string[]; // watch flag ids this option confirms
}

export type Question =
  | { id: string; kind: "scale"; text: string } // 0–10 slider
  | { id: string; kind: "chips"; text: string; multi?: boolean; options: Option[] }
  | { id: string; kind: "free"; text: string };

// Authored once per visit by the (mock) CDS, then FROZEN + cached on the patient row.
// The guardrail applies red/watch deterministically; the CDS/model only author it here.
export interface CdsProtocol {
  complaint: string; // e.g. "cellulitis"
  cadenceMinutes: { routine: number; watch: number; escalate: number };
  baseline: Question[];
  bank: Question[];
  red: Record<string, string>; // flagId -> nurse-facing label (escalate)
  watch: Record<string, string>; // flagId -> nurse-facing label (watch)
  hardPhrases: string[];
}

// Mock FHIR intake record returned by the EMRAdapter on enroll.
export interface FhirPatient {
  id: string;
  name: string;
  dob: string; // ISO date (used for the identity-confirm step)
  age: number;
  sex: string; // feeds the "<age><sex>" in the alert payload
  phone?: string; // E.164, verified for the demo
  complaint: string;
  esi: number; // 3..5
  triageNote: string;
}

export interface Baseline {
  complete: boolean;
  answers: Record<string, string | string[] | number>;
  severityBaseline: number;
}

export type CheckinEvent =
  | { type: "answers"; answers: Record<string, string | string[] | number>; freeText?: string }
  | { type: "sms_in"; body: string } // raw inbound text; service+agent interpret it
  | { type: "timer" }
  | { type: "call_result"; transcript?: string; structured?: Record<string, string> };

// Model output. Zod mirror lives in lib/agent.ts; all ids are validated server-side.
export interface CheckinResult {
  interpretation: string;
  free_text_flags_suspected: string[];
  next_question_id: string; // must exist in the bank, else deterministic next-unanswered
  custom_question: string | null;
  tier_proposed: Tier;
  flag_ids_cited: string[]; // only structurally-confirmed flags; never free text alone
  reason_one_liner: string;
  trend_summary: string;
  patient_ack: string;
  confidence: number; // 0..1
  escalate_to_call: boolean; // model may REQUEST a voice call; never escalates a tier itself
}

// THE persisted contract — stored in messages.trace (jsonb).
export interface CheckinTrace {
  phase: Phase;
  event: CheckinEvent;
  channel: Channel;
  questionAskedId: string | null;
  severity: number | null; // latest 0–10
  severityHistory: number[]; // incl. baseline
  confirmedFlags: string[]; // deterministic
  hardPhraseHits: string[];
  modelRan: boolean; // false on scripted/degraded path
  modelTierProposed: Tier | null;
  rulesTier: Tier;
  tierFinal: Tier;
  reviewNow: boolean;
  escalateToCall: boolean;
  createdAt: string; // ISO
}

// Persisted as a role='system' message row; also the frozen alert payload.
export interface Alert {
  kind: "alert";
  patientId: string;
  name: string;
  ageSex: string; // "34F"
  complaint: string;
  reason: string;
  trend: string;
  category: string; // flag category, for same-reason dedup
  payload: string; // "WR: <name>, <age><sex>, <complaint> — <reason>; <trend>. Suggest re-triage."
  createdAt: string;
}

export interface CheckinResponse {
  patient_ack: string;
  next_question: Question | null;
  tier: Tier;
  review_now: boolean;
  escalate_to_call: boolean;
  trace: CheckinTrace;
}

// Demo driver beat (lib/scripts.ts). Scripted glue; guardrail still runs for real.
export interface ScriptedBeat {
  slug: string;
  beatIndex: number; // 0-based
  event: CheckinEvent;
  patientAck: string;
  expectedTier: Tier;
}

export interface ApiError {
  error: string;
}
