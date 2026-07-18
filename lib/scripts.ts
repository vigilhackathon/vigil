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
// SCRIPTED HERO (Chen) — two texts, then the call. (You can also drive this live by opening
// Chen's thread and typing the replies — the beats are the click-through fallback.)
//   Beat 0  "Has your pain increased?"  → NO                          → ROUTINE
//   Beat 1  "Has the redness spread past your ankle?" → YES (R_RAPID) → WATCH + 📞 CALL PLACED
//           (the "yes" is a red flag → VIGIL calls to verify; nurse NOT paged yet)
//   Beat 2  call_result confirms on the call                         → ESCALATE + nurse paged
// Contrast (Dave): steady, every screen negative — HOLDS routine throughout.

export const SCRIPTS: Record<string, ScriptedBeat[]> = {
  chen: [
    {
      slug: "chen",
      beatIndex: 0,
      event: { type: "answers", answers: { q_pain_inc: "no" } }, // "Has your pain increased?" → No
      patientAck: "Got it, thanks.",
      expectedTier: "routine",
    },
    {
      slug: "chen",
      beatIndex: 1,
      // "Has the redness spread past your ankle?" → Yes (R_RAPID). Call-first: HOLD at watch,
      // place the verification call — no page yet.
      event: { type: "answers", answers: { q_ankle: "yes" } },
      patientAck: "Thanks — a nurse will call you shortly to check in.",
      expectedTier: "watch",
    },
    {
      slug: "chen",
      beatIndex: 2,
      event: {
        // The verification call comes back. Live, VIG-16's post-call webhook posts this; in the
        // scripted demo the driver injects it. Confirms rapid spread → guardrail escalates → page.
        type: "call_result",
        transcript:
          "On the call the patient said her redness was only to mid-leg on arrival but is now up to the ankle, she's had cellulitis before but nothing that spreads this fast, and her pain is now about 8/10.",
        structured: { q_ankle: "yes", q_pain_inc: "yes" },
      },
      patientAck: "Thanks for talking just now.",
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
      patientAck: "Got it, thanks.",
      expectedTier: "routine",
    },
    {
      slug: "dave",
      beatIndex: 1,
      event: {
        type: "answers",
        answers: { q_pain: 6, q_spread: "same", q_fever: "no" },
      },
      patientAck: "Thanks, noted.",
      expectedTier: "routine",
    },
    {
      slug: "dave",
      beatIndex: 2,
      event: {
        type: "answers",
        answers: { q_pain: 5, q_warmth: "no", q_skin: "no" },
      },
      patientAck: "Thanks, noted.",
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
