// app/emr/_ui.ts — shared shapes + presentation helpers for the mock EMR UI.
// (Underscore prefix → not a route.) Pure functions; no I/O.

import type { Tier } from "@/lib/types";

/** The anon-readable patients columns the board renders (RLS: anon can select patients). */
export interface PatientRow {
  id: string;
  name: string;
  age: number | null;
  sex: string | null;
  complaint: string | null;
  esi: number;
  tier: Tier;
  review_now: boolean;
  tier_reason: string | null;
  trend: string | null;
  cadence_minutes: number;
  next_checkin_due: string | null;
  last_response_at: string | null;
  ack_at: string | null;
  ack_by: string | null;
  created_at: string;
}

/** Board sort priority: escalate → review_now → watch → routine. */
export function sortRank(p: PatientRow): number {
  if (p.tier === "escalate") return 4;
  if (p.review_now) return 3;
  if (p.tier === "watch") return 2;
  return 1;
}

export function sortPatients(rows: PatientRow[]): PatientRow[] {
  return [...rows].sort((a, b) => {
    const r = sortRank(b) - sortRank(a);
    if (r !== 0) return r;
    // within a tier, most-overdue first (earliest next_checkin_due)
    const ad = a.next_checkin_due ? Date.parse(a.next_checkin_due) : Infinity;
    const bd = b.next_checkin_due ? Date.parse(b.next_checkin_due) : Infinity;
    return ad - bd;
  });
}

/** Overdue = past next_checkin_due (monitoring lost). `nowMs` passed in so callers control the clock. */
export function isOverdue(p: PatientRow, nowMs: number): boolean {
  return p.next_checkin_due != null && nowMs > Date.parse(p.next_checkin_due);
}

/** "34F" style, matching the alert payload's ageSex. */
export function ageSex(p: PatientRow): string {
  return `${p.age ?? "?"}${(p.sex ?? "").charAt(0).toUpperCase()}`;
}

/** Reconstructed nurse-page preview (the real persisted Alert.payload shows in the record tab). */
export function pagePreview(p: PatientRow): string {
  const reason = p.tier_reason ?? "worsening";
  const trend = p.trend ? `severity ${p.trend}` : "interval change";
  return `WR: ${p.name}, ${ageSex(p)}, ${p.complaint ?? "—"} — ${reason}; ${trend}. Suggest re-triage.`;
}

export const TIER_LABEL: Record<Tier, string> = {
  escalate: "ESCALATE",
  watch: "WATCH",
  routine: "ROUTINE",
};

/** Tailwind classes for a tier chip (works in light + dark). */
export function tierChip(tier: Tier): string {
  switch (tier) {
    case "escalate":
      return "bg-red-600 text-white";
    case "watch":
      return "bg-amber-500 text-black";
    default:
      return "bg-emerald-600 text-white";
  }
}

/** Left border accent for a row card by tier. */
export function tierAccent(tier: Tier): string {
  switch (tier) {
    case "escalate":
      return "border-l-red-600";
    case "watch":
      return "border-l-amber-500";
    default:
      return "border-l-emerald-600";
  }
}
