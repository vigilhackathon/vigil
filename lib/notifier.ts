// lib/notifier.ts — VIG-12: escalation → policy → page the nurse + flag the EMR.
// Lives INSIDE checkin-service (no route). The persisted alert row (messages: role='system',
// trace.kind='alert') is the source of truth the EMR UI renders (escalation flag, MockVoalte
// payload panel, alerts counter). Adapters are side-channels on top:
//   - ConsoleAdapter: always on (integration log).
//   - TwilioAdapter: nurse-page SMS, STRICTLY env-gated (post-pivot stretch — carrier SMS is
//     off the demo critical path; this fires only when all TWILIO_* + NURSE_PHONE are set).
// Same-reason dedup (frozen policy): a NEW page fires only for a NEW flag category; a repeat
// of the same category UPDATES the existing alert ("still worsening — 2nd report"). One
// patient can never machine-gun the nurse.

import { alertCategory, shouldPushAlert } from "./guardrail";
import type { Alert } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Persisted alert + bookkeeping the frozen Alert contract doesn't need (additive only). */
type AlertRow = Alert & { reportCount?: number };

export interface NotifierAdapter {
  name: string;
  send(alert: Alert, isUpdate: boolean): Promise<void>;
}

const consoleAdapter: NotifierAdapter = {
  name: "console",
  async send(alert, isUpdate) {
    console.log(`[notifier:console] ${isUpdate ? "UPDATE" : "PAGE"} → ${alert.payload}`);
  },
};

/** Nurse-page SMS via the Twilio REST API (plain fetch — no SDK dep). Env-gated, never load-bearing. */
function twilioAdapter(): NotifierAdapter | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_NUMBER;
  const to = process.env.NURSE_PHONE;
  if (!sid || !token || !from || !to) return null;
  return {
    name: "twilio-nurse-sms",
    async send(alert, isUpdate) {
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              From: from,
              To: to,
              Body: isUpdate ? `${alert.payload} (update)` : alert.payload,
            }),
          },
        );
        if (!res.ok) console.warn(`[notifier:twilio] ${res.status} ${await res.text()}`);
      } catch (e) {
        console.warn("[notifier:twilio] send failed:", e); // never breaks the check-in path
      }
    },
  };
}

function adapters(): NotifierAdapter[] {
  const list = [consoleAdapter];
  const twilio = twilioAdapter();
  if (twilio) list.push(twilio);
  return list;
}

export interface EscalationEvent {
  patientId: string;
  name: string;
  ageSex: string; // "34F"
  complaint: string;
  reason: string; // one-liner for the nurse
  trend: string; // e.g. "5→6→7"
  confirmedRed: string[];
  hardPhraseHits: string[];
  /** True when THIS turn's rules escalated on severity delta alone (no flags/phrases). */
  deltaDriven?: boolean;
}

export interface NotifyResult {
  paged: boolean; // a NEW page fired
  updated: boolean; // an existing alert was updated instead (same-reason dedup)
  category: string;
}

/** Frozen alert payload format (PLAN §3): do not reword. */
function buildPayload(e: EscalationEvent): string {
  return `WR: ${e.name}, ${e.ageSex}, ${e.complaint} — ${e.reason}; severity ${e.trend}. Suggest re-triage.`;
}

const ordinal = (n: number): string =>
  `${n}${["th", "st", "nd", "rd"][n % 10 <= 3 && Math.floor(n / 10) !== 1 ? n % 10 : 0]}`;

/**
 * Policy + persistence + fan-out for one escalation event. Reads this patient's existing
 * alert rows to apply same-reason dedup; a repeat category updates the existing row
 * ("still worsening — Nth report") instead of paging again.
 */
export async function notifyEscalation(
  db: SupabaseClient,
  e: EscalationEvent,
): Promise<NotifyResult> {
  // Fallback category: a Δ≥3 (or sustained-severity) escalation confirms no flag, but it still
  // escalated the tier — the nurse must still be paged (once; dedup applies like any category).
  // Only when THIS turn genuinely escalated on delta — a quiet turn on a sticky-escalated
  // patient contributes nothing new and must not page (or trigger a call) again.
  const category =
    alertCategory(e.confirmedRed, e.hardPhraseHits) || (e.deltaDriven ? "delta-escalation" : "");
  if (!category) return { paged: false, updated: false, category };

  const { data, error } = await db
    .from("messages")
    .select("id, trace")
    .eq("patient_id", e.patientId)
    .eq("role", "system")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`notifier: alerts read failed: ${error.message}`);

  const alertRows = (data ?? []).filter(
    (r): r is { id: string; trace: AlertRow } =>
      (r.trace as AlertRow | null)?.kind === "alert",
  );
  const pushedCategories = alertRows.map((r) => r.trace.category);
  const payload = buildPayload(e);
  const now = new Date().toISOString();

  if (shouldPushAlert(category, pushedCategories)) {
    // NEW flag category → new page.
    const alert: AlertRow = {
      kind: "alert",
      patientId: e.patientId,
      name: e.name,
      ageSex: e.ageSex,
      complaint: e.complaint,
      reason: e.reason,
      trend: e.trend,
      category,
      payload,
      createdAt: now,
      reportCount: 1,
    };
    const { error: insErr } = await db
      .from("messages")
      .insert({ patient_id: e.patientId, role: "system", content: payload, trace: alert });
    if (insErr) throw new Error(`notifier: alert insert failed: ${insErr.message}`);
    await Promise.all(adapters().map((a) => a.send(alert, false)));
    return { paged: true, updated: false, category };
  }

  // Same category → update the existing alert ("still worsening — 2nd report"), no new page.
  const existing = alertRows.find((r) => r.trace.category === category);
  if (!existing) return { paged: false, updated: false, category }; // unreachable, defensive
  const reportCount = (existing.trace.reportCount ?? 1) + 1;
  const updatedAlert: AlertRow = {
    ...existing.trace,
    reason: e.reason,
    trend: e.trend,
    payload,
    reportCount,
  };
  const content = `${payload} (still worsening — ${ordinal(reportCount)} report)`;
  const { error: updErr } = await db
    .from("messages")
    .update({ content, trace: updatedAlert })
    .eq("id", existing.id);
  if (updErr) throw new Error(`notifier: alert update failed: ${updErr.message}`);
  await Promise.all(adapters().map((a) => a.send({ ...updatedAlert, payload: content }, true)));
  return { paged: false, updated: true, category };
}
