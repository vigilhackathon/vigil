// lib/scripts.ts — VIG-14: the staged demo beats. Scripted GLUE only: patient_ack wording and
// the batched answers are pre-written, but every beat runs through processCheckin with the
// REAL guardrail — the tiers, flags, cadence, and alerts on stage are genuinely computed.
// (Driver beats batch several answers into one event — allowed by the contract; live patients
// answer one at a time.)
//
// Changing names/beats here is a demo-visible change — keep STATUS.md + the run-of-show in sync.

import type { ScriptedBeat, Tier } from "./types";

export interface DemoPatientSeed {
  slug: string;
  name: string;
  age: number;
  sex: string;
  dob: string; // ISO date; thread identity gate is pre-confirmed on reset anyway
  phone: string | null;
  complaint: string;
  esi: number;
}

/** The two driven patients. Reset recreates them at T0 (identity pre-confirmed, phone set). */
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
  },
  {
    slug: "dave",
    name: "Dave Okafor",
    age: 51,
    sex: "M",
    dob: "1975-09-21",
    phone: null,
    complaint: "cellulitis",
    esi: 4,
  },
];

/** Quiet waiting-room rows so the board doesn't look empty. Never driven. */
export const DEMO_SEED_ROWS: Omit<DemoPatientSeed, "slug" | "dob" | "phone">[] = [
  { name: "Rosa Alvarez", age: 62, sex: "F", complaint: "cellulitis", esi: 3 },
  { name: "Sam Patel", age: 27, sex: "M", complaint: "cellulitis", esi: 5 },
];

// --- Beats -----------------------------------------------------------------------------------
// Hero (Chen): T0 baseline 4/10, clean screen → T+1 redness a little past the line (W_SPREAD,
// Δ1) = quiet WATCH → T+2 spreading fast + new fever + red streaks (R_RAPID + R_FEVER +
// R_STREAK, 4→5→7) = ESCALATE. Contrast (Dave): steady 6/10, every screen negative — HOLDS.

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
  dave: [
    {
      slug: "dave",
      beatIndex: 0,
      event: {
        type: "answers",
        answers: { b_pain: 6, b_landmark: "below_knee", b_screen: ["none"] },
      },
      patientAck: "Thanks, that's everything for now. I'll check in again soon.",
      expectedTier: "routine",
    },
    {
      slug: "dave",
      beatIndex: 1,
      event: {
        type: "answers",
        answers: { q_pain: 6, q_spread: "same", q_fever: "no" },
      },
      patientAck: "Thanks — noted, no changes.",
      expectedTier: "routine",
    },
    {
      slug: "dave",
      beatIndex: 2,
      event: {
        type: "answers",
        answers: { q_pain: 5, q_warmth: "no", q_skin: "no" },
      },
      patientAck: "Thanks — noted, no changes.",
      expectedTier: "routine",
    },
  ],
};

export function beatFor(slug: string, beatIndex: number): ScriptedBeat | null {
  return SCRIPTS[slug]?.[beatIndex] ?? null;
}

export function expectedTierFor(slug: string, beatIndex: number): Tier | null {
  return beatFor(slug, beatIndex)?.expectedTier ?? null;
}
