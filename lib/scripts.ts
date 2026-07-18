// lib/scripts.ts — VIG-14: the staged demo beats. Scripted GLUE only: patient_ack wording and
// the batched answers are pre-written, but every beat runs through processCheckin with the
// REAL guardrail — the tiers, flags, cadence, and alerts on stage are genuinely computed.
// (Driver beats batch several answers into one event — allowed by the contract; live patients
// answer one at a time.)
//
// Changing names/beats here is a demo-visible change — keep STATUS.md + the run-of-show in sync.

import type { ScriptedBeat, Tier } from "./types";

/** ED triage vitals captured at registration. Display-only enrichment on the EMR chart. */
export interface Vitals {
  temp_c: number; // °C
  hr: number; // bpm
  bp: string; // systolic/diastolic mmHg, e.g. "128/82"
  rr: number; // breaths/min
  spo2: string; // e.g. "98% RA" (room air)
  pain: number; // 0–10
}

export interface DemoPatientSeed {
  slug: string;
  name: string;
  age: number;
  sex: string;
  dob: string; // ISO date; thread identity gate is pre-confirmed on reset anyway
  phone: string | null;
  complaint: string;
  esi: number;
  triage_note: string;
  vitals: Vitals;
}

/**
 * The driven patient(s). Reset recreates them at T0 (identity pre-confirmed, phone set).
 *
 * Only Maya Chen (cellulitis) is DRIVEN — she has a CDS-authored protocol and scripted
 * check-in beats (see SCRIPTS below), and her arc is the live escalation demo.
 *
 * NOTE (demo-narrative change, 2026-07-18): Dave Okafor's driven "contrast holds steady"
 * cellulitis beat was RETIRED per user decision. Dave is now a DISPLAY-ONLY waiting-room
 * patient with a different complaint (low back pain) — no protocol, no scripted beats.
 * He lives in DEMO_SEED_ROWS with Rosa + Sam. If the contrast beat is ever wanted back,
 * re-add him here and restore SCRIPTS.dave.
 */
export const DEMO_PATIENTS: DemoPatientSeed[] = [
  {
    slug: "chen",
    name: "Maya Chen",
    age: 34,
    sex: "F",
    dob: "1992-04-02",
    phone: null, // driver sets the live phone via reset payload when provided
    complaint: "cellulitis",
    esi: 4,
    triage_note:
      "34F, h/o DM (diabetes) and HTN. Redness and warmth of the right lower leg from knee " +
      "to mid-leg, onset 1 day ago. Pain 5/10. Ambulatory, marked border of erythema.",
    vitals: { temp_c: 37.8, hr: 92, bp: "128/82", rr: 16, spo2: "98% RA", pain: 5 },
  },
];

/**
 * Quiet waiting-room rows so the board doesn't look empty. Never driven — DISPLAY-ONLY.
 * These carry VARIED complaints (not cellulitis) and are NOT monitored: reset authors no
 * protocol for them (MockCds only authors cellulitis), so their `protocol` stays null.
 */
export const DEMO_SEED_ROWS: Omit<DemoPatientSeed, "slug" | "dob" | "phone">[] = [
  {
    name: "Dave Okafor",
    age: 51,
    sex: "M",
    complaint: "low back pain",
    esi: 4,
    triage_note:
      "51M, low back pain x3 days after lifting, radiating down right leg. Pain 6/10. No " +
      "saddle anesthesia, no bowel/bladder changes, no fever. Ambulatory.",
    vitals: { temp_c: 36.9, hr: 78, bp: "134/86", rr: 14, spo2: "99% RA", pain: 6 },
  },
  {
    name: "Rosa Alvarez",
    age: 62,
    sex: "F",
    complaint: "abdominal pain",
    esi: 3,
    triage_note:
      "62F, right lower quadrant abdominal pain x1 day, associated nausea, no vomiting, " +
      "last BM normal. Pain 7/10.",
    vitals: { temp_c: 37.2, hr: 96, bp: "140/88", rr: 18, spo2: "97% RA", pain: 7 },
  },
  {
    name: "Sam Patel",
    age: 27,
    sex: "M",
    complaint: "fever",
    esi: 4,
    triage_note:
      "27M, fever and sore throat x2 days, Tmax 39.1°C at home, mild dysphagia, no " +
      "respiratory distress. Pain 3/10.",
    vitals: { temp_c: 38.9, hr: 104, bp: "118/74", rr: 18, spo2: "98% RA", pain: 3 },
  },
];

// --- Beats -----------------------------------------------------------------------------------
// Hero (Chen): T0 baseline 4/10, clean screen → T+1 redness a little past the line (W_SPREAD,
// Δ1) = quiet WATCH → T+2 spreading fast + new fever + red streaks (R_RAPID + R_FEVER +
// R_STREAK, 4→5→7) = ESCALATE.
//
// Dave's "contrast holds steady" beats were RETIRED (2026-07-18) — he is now display-only
// with a non-cellulitis complaint, so he has no scripted beats. Chen is the only driven arc.

export const SCRIPTS: Record<string, ScriptedBeat[]> = {
  chen: [
    {
      slug: "chen",
      beatIndex: 0,
      event: {
        type: "answers",
        answers: { b_pain: 4, b_landmark: "knee", b_screen: ["none"] },
      },
      patientAck: "Thanks, that's everything for now. I'll check in again soon.",
      expectedTier: "routine",
    },
    {
      slug: "chen",
      beatIndex: 1,
      event: {
        type: "answers",
        answers: { q_pain: 5, q_spread: "past", q_fever: "no" },
      },
      patientAck: "Thanks for the update — I've noted the redness moved a little past the line.",
      expectedTier: "watch",
    },
    {
      slug: "chen",
      beatIndex: 2,
      event: {
        type: "answers",
        // Structured escalation: rapid spread + new fever + red streaks (screen chip re-asked).
        answers: { q_pain: 7, q_spread: "fast", q_fever: "yes", b_screen: ["streak"] },
      },
      // The service appends the mandatory front-desk line for confirmed red flags.
      patientAck: "Thank you for telling me right away.",
      expectedTier: "escalate",
    },
  ],
};

export function beatFor(slug: string, beatIndex: number): ScriptedBeat | null {
  return SCRIPTS[slug]?.[beatIndex] ?? null;
}

export function expectedTierFor(slug: string, beatIndex: number): Tier | null {
  return beatFor(slug, beatIndex)?.expectedTier ?? null;
}
