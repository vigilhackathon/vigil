// lib/cds.ts — VIG-6: the (mock) CDS that authors the monitoring protocol per visit.
//
// Architecture invariant (see PLAN / STATUS): the CDS *authors* the flag->tier map ONCE at
// intake; it is then FROZEN + cached on `patients.protocol`, and the guardrail *applies* it
// deterministically for the rest of the visit. The model never lowers a tier and never holds
// the pager. This file only authors.
//
// v1 ships a hand-authored cellulitis protocol (the clinical content). Live model authoring
// from a full reference (Glass Health) is roadmap — `MockCds.author` is the seam it slots into.
//
// Caching: the caller (checkin-service) persists the returned protocol to `patients.protocol`
// and reuses it thereafter — one authoring call per visit. This module is pure.

import type { CdsProtocol, Option, Question } from "./types";

// --- Cellulitis (Charumathi's clinical content) ----------------------------------------------

// Baseline red-flag screen: each option confirms a red flag id (see `red` below).
const CELLULITIS_SCREEN: Option[] = [
  { label: "Fever or chills", value: "fever", flags: ["R_FEVER"] },
  { label: "Blisters, or skin turning gray, purple, or black", value: "necrosis", flags: ["R_NECROSIS"] },
  { label: "Red streaks spreading up the limb", value: "streak", flags: ["R_STREAK"] },
  { label: "Numbness over the red area", value: "numb", flags: ["R_NUMB"] },
  { label: "The skin feels crackly, like bubbles under it", value: "crepitus", flags: ["R_CREPITUS"] },
  { label: "None of these", value: "none" },
];

const CELLULITIS: CdsProtocol = {
  complaint: "cellulitis",
  // routine = recheck 30m, watch = recheck 15m, escalate = alert/call now (kept short as a
  // safety re-check while the escalation is handled).
  cadenceMinutes: { routine: 30, watch: 15, escalate: 10 },

  baseline: [
    { id: "b_pain", kind: "scale", text: "How bad is the pain right now, from 0 to 10?" },
    {
      id: "b_landmark",
      kind: "chips",
      text: "Where does the redness reach? We'll mark a line at its edge so we can watch it.",
      options: [
        { label: "Below the knee / ankle area", value: "below_knee" },
        { label: "Up to the knee", value: "knee" },
        { label: "Above the knee / thigh", value: "thigh" },
        { label: "Somewhere else", value: "other" },
      ],
    },
    { id: "b_screen", kind: "chips", multi: true, text: "Right now, do you have any of these?", options: CELLULITIS_SCREEN },
  ],

  bank: [
    { id: "q_pain", kind: "scale", text: "How bad is the pain right now, 0 to 10?" },
    {
      id: "q_spread",
      kind: "chips",
      text: "Is the redness past the line we drew last time?",
      options: [
        { label: "Yes — and it spread fast / a lot", value: "fast", flags: ["R_RAPID"] },
        { label: "Yes — a little past the line", value: "past", watch: ["W_SPREAD"] },
        { label: "No — about the same", value: "same" },
      ],
    },
    {
      id: "q_pop",
      kind: "chips",
      text: "Does the pain feel worse than the skin looks, or is it getting worse fast?",
      options: [
        { label: "Yes", value: "yes", flags: ["R_POP"] },
        { label: "No", value: "no" },
      ],
    },
    {
      id: "q_fever",
      kind: "chips",
      text: "Do you have a fever or chills right now?",
      options: [
        { label: "Yes", value: "yes", flags: ["R_FEVER"] },
        { label: "No", value: "no" },
      ],
    },
    {
      id: "q_skin",
      kind: "chips",
      text: "Any blisters, or skin turning gray, purple, or black?",
      options: [
        { label: "Yes", value: "yes", flags: ["R_NECROSIS"] },
        { label: "No", value: "no" },
      ],
    },
    {
      id: "q_numb",
      kind: "chips",
      text: "Any numbness over the red area?",
      options: [
        { label: "Yes", value: "yes", flags: ["R_NUMB"] },
        { label: "No", value: "no" },
      ],
    },
    {
      id: "q_systemic",
      kind: "chips",
      text: "Do you feel faint, confused, or too sick to stand?",
      options: [
        { label: "Yes", value: "yes", flags: ["R_SYSTEMIC"] },
        { label: "No", value: "no" },
      ],
    },
    {
      id: "q_warmth",
      kind: "chips",
      text: "Is the area more warm to the touch than before?",
      options: [
        { label: "Yes", value: "yes", watch: ["W_WARMTH"] },
        { label: "No", value: "no" },
      ],
    },
    { id: "q_open", kind: "free", text: "Has anything else changed since I last checked?" },
  ],

  // flagId -> nurse-facing label. Escalate tier.
  red: {
    R_POP: "Pain out of proportion to exam — possible early necrotizing infection",
    R_NECROSIS: "Dusky / purple / black skin or blisters (skin necrosis)",
    R_STREAK: "Red streaking up the limb (lymphangitis)",
    R_CREPITUS: "Crepitus — gas in the tissues",
    R_NUMB: "Focal numbness over the erythema",
    R_FEVER: "New fever / chills (systemic sign)",
    R_RAPID: "Rapidly expanding erythema",
    R_SYSTEMIC: "Systemic toxicity — faint / confused / too sick to stand",
  },

  // flagId -> nurse-facing label. Watch tier.
  watch: {
    W_SPREAD: "Redness spread past the marked landmark",
    W_WARMTH: "Increased warmth over the area",
  },

  // Free-text phrases that escalate regardless of the model (the deterministic hard floor).
  hardPhrases: [
    "skin turning black",
    "skin is turning black",
    "skin going black",
    "can't feel my skin",
    "cant feel my skin",
    "worst pain of my life",
    "passing out",
    "about to pass out",
  ],
};

// --- Registry + author seam ------------------------------------------------------------------

const REGISTRY: Record<string, CdsProtocol> = {
  cellulitis: CELLULITIS,
};

// Route a free-text complaint to a protocol key (v1: cellulitis synonyms only).
const ALIASES: Record<string, string> = {
  cellulitis: "cellulitis",
  erysipelas: "cellulitis",
  "skin infection": "cellulitis",
  "leg redness": "cellulitis",
  redness: "cellulitis",
};

function resolveKey(complaint: string): string | undefined {
  const q = complaint.trim().toLowerCase();
  if (REGISTRY[q]) return q;
  for (const [alias, key] of Object.entries(ALIASES)) {
    if (q.includes(alias)) return key;
  }
  return undefined;
}

export class MockCds {
  /**
   * Author (and, in production, freeze) the monitoring protocol for a visit's complaint.
   * Returns a fresh copy so the frozen registry entry is never mutated by callers.
   */
  static author(complaint: string): CdsProtocol {
    const key = resolveKey(complaint);
    if (!key) {
      throw new Error(
        `MockCds: no protocol for complaint "${complaint}". v1 ships cellulitis; ` +
          `additional conditions and live model authoring are roadmap.`,
      );
    }
    return structuredClone(REGISTRY[key]);
  }

  /** Complaints this mock can author (for demo seeding / validation). */
  static complaints(): string[] {
    return Object.keys(REGISTRY);
  }
}
