"use client";

// app/emr/patient/[id] — Patient Record tab. Full conversation record (via /api/transcript,
// server-side so it can read messages under RLS) + trace card (guardrail reasoning) + the real
// MockVoalte alert payload + one-click SBAR handoff (/api/handoff) + Acknowledge (/api/ack).
// Nurse-side only: after ack we show acknowledged here; the patient thread stays silent.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import type { Alert, CdsProtocol, CheckinTrace, Tier } from "@/lib/types";
import { ageSex, TIER_LABEL, tierChip, type PatientRow } from "../../_ui";

interface MessageRow {
  id: string;
  role: "agent" | "patient" | "system";
  content: string;
  trace: (CheckinTrace | (Alert & { reportCount?: number }) | null);
  created_at: string;
}

function isTrace(t: MessageRow["trace"]): t is CheckinTrace {
  return t != null && "event" in t;
}
function isAlert(t: MessageRow["trace"]): t is Alert & { reportCount?: number } {
  return t != null && "kind" in t && t.kind === "alert";
}

function flagLine(id: string, protocol: CdsProtocol | null): { label: string; kind: "RED" | "WATCH" } {
  if (protocol?.red[id]) return { label: protocol.red[id], kind: "RED" };
  if (protocol?.watch[id]) return { label: protocol.watch[id], kind: "WATCH" };
  return { label: id, kind: "RED" };
}

export default function PatientRecordPage() {
  const { id } = useParams<{ id: string }>();
  const [patient, setPatient] = useState<PatientRow & { protocol: CdsProtocol | null }>();
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [sbar, setSbar] = useState<string | null>(null);
  const [sbarLoading, setSbarLoading] = useState(false);

  const load = useCallback(async () => {
    const [{ data: p }, res] = await Promise.all([
      supabaseBrowser()
        .from("patients")
        .select(
          "id,name,age,sex,complaint,esi,triage_note,vitals,tier,review_now,tier_reason,trend,cadence_minutes,next_checkin_due,last_response_at,ack_at,ack_by,created_at,protocol",
        )
        .eq("id", id)
        .maybeSingle(),
      fetch(`/api/transcript?patientId=${id}`),
    ]);
    if (p) setPatient(p as unknown as PatientRow & { protocol: CdsProtocol | null });
    if (res.ok) {
      const json = (await res.json()) as { messages: MessageRow[] };
      setMessages(json.messages ?? []);
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  async function generateHandoff() {
    setSbarLoading(true);
    try {
      const res = await fetch("/api/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId: id }),
      });
      const json = (await res.json()) as { markdown?: string; error?: string };
      setSbar(json.markdown ?? json.error ?? "handoff failed");
    } finally {
      setSbarLoading(false);
    }
  }

  async function acknowledge() {
    await fetch("/api/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId: id }),
    });
    load();
  }

  const protocol = patient?.protocol ?? null;
  const traces = messages.filter((m) => m.role === "agent" && isTrace(m.trace)).map((m) => m.trace as CheckinTrace);
  const latest = traces.length ? traces[traces.length - 1] : null;
  const confirmed = Array.from(new Set(traces.flatMap((t) => t.confirmedFlags)));
  const hardPhrases = Array.from(new Set(traces.flatMap((t) => t.hardPhraseHits)));
  const alertRows = messages.filter((m) => isAlert(m.trace)).map((m) => m.trace as Alert & { reportCount?: number });
  const tierFinal: Tier = latest?.tierFinal ?? patient?.tier ?? "routine";

  return (
    <div className="space-y-4">
      {/* Tab strip */}
      <nav className="flex gap-1 text-sm">
        <Link href="/emr" className="rounded px-3 py-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800">
          ER Dashboard
        </Link>
        <span className="rounded bg-neutral-200 px-3 py-1 font-medium dark:bg-neutral-800">Patient Record</span>
      </nav>

      {!patient && <p className="text-sm text-neutral-500">Loading record…</p>}

      {patient && (
        <>
          <header className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold">{patient.name}</h1>
              <p className="text-xs text-neutral-500">
                {ageSex(patient)} · {patient.complaint ?? "—"} · ESI {patient.esi}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${tierChip(tierFinal)}`}>
                {TIER_LABEL[tierFinal]}
              </span>
              {patient.ack_at ? (
                <span className="text-xs text-emerald-600">
                  acknowledged · {patient.ack_by}
                </span>
              ) : (
                tierFinal === "escalate" && (
                  <button
                    onClick={acknowledge}
                    className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
                  >
                    Acknowledge
                  </button>
                )
              )}
            </div>
          </header>

          {/* ED triage note — captured at registration (display-only intake data). */}
          {patient.triage_note && (
            <section className="rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Triage note
              </h2>
              <p className="leading-relaxed text-neutral-700 dark:text-neutral-300">{patient.triage_note}</p>
            </section>
          )}

          {/* Vitals at triage. */}
          {patient.vitals && (
            <section className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Vitals (at triage)
              </h2>
              <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm sm:grid-cols-6">
                {[
                  { k: "Temp", v: `${patient.vitals.temp_c}°C` },
                  { k: "HR", v: `${patient.vitals.hr}` },
                  { k: "BP", v: patient.vitals.bp },
                  { k: "RR", v: `${patient.vitals.rr}` },
                  { k: "SpO₂", v: patient.vitals.spo2 },
                  { k: "Pain", v: `${patient.vitals.pain}/10` },
                ].map(({ k, v }) => (
                  <div key={k}>
                    <dt className="text-[10px] uppercase tracking-wide text-neutral-400">{k}</dt>
                    <dd className="font-medium tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* Trace card — the guardrail's reasoning, human-readable. */}
          <section className="rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Guardrail trace</h2>
            {confirmed.length === 0 && hardPhrases.length === 0 && (
              <p className="text-neutral-500">No confirmed flags yet.</p>
            )}
            <ul className="space-y-1">
              {confirmed.map((f) => {
                const { label, kind } = flagLine(f, protocol);
                return (
                  <li key={f} className="flex items-center gap-2">
                    <span className={kind === "RED" ? "text-red-600" : "text-amber-600"}>
                      {kind === "RED" ? "🔴" : "🟡"} {label}
                    </span>
                    <span className="text-neutral-400">→ {kind} ✓</span>
                  </li>
                );
              })}
              {hardPhrases.map((h) => (
                <li key={h} className="text-red-600">
                  🔴 hard phrase: “{h}” → ESCALATE ✓
                </li>
              ))}
            </ul>
            <div className="mt-2 border-t border-neutral-100 pt-2 text-xs text-neutral-500 dark:border-neutral-800">
              Guardrail floor: <span className="font-semibold">{TIER_LABEL[tierFinal]}</span> · model:{" "}
              {latest?.modelRan ? "ran" : "n/a (deterministic/scripted)"}
            </div>
          </section>

          {/* MockVoalte payload — the real persisted alert row(s). */}
          {alertRows.length > 0 && (
            <section className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/40">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">
                Nurse page sent (MockVoalte)
              </h2>
              <ul className="space-y-1 font-mono text-xs">
                {alertRows.map((a, i) => (
                  <li key={i}>
                    {a.payload}
                    {a.reportCount && a.reportCount > 1 ? ` (report #${a.reportCount})` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* SBAR handoff */}
          <section className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">SBAR interval handoff</h2>
              <button
                onClick={generateHandoff}
                disabled={sbarLoading}
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50"
              >
                {sbarLoading ? "Generating…" : sbar ? "Regenerate" : "Generate handoff"}
              </button>
            </div>
            {sbar ? (
              <pre className="whitespace-pre-wrap text-xs leading-relaxed">{sbar}</pre>
            ) : (
              <p className="text-xs text-neutral-500">Two hours of waiting, compiled in ten seconds.</p>
            )}
          </section>

          {/* Conversation record */}
          <section className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Conversation</h2>
            <ul className="space-y-2">
              {messages.map((m) => {
                if (m.role === "system") {
                  return (
                    <li key={m.id} className="text-center text-[11px] text-red-500">
                      — {m.content} —
                    </li>
                  );
                }
                const agent = m.role === "agent";
                return (
                  <li key={m.id} className={agent ? "text-left" : "text-right"}>
                    <span
                      className={`inline-block max-w-[80%] rounded-lg px-3 py-1.5 text-sm ${
                        agent
                          ? "bg-neutral-100 dark:bg-neutral-800"
                          : "bg-blue-600 text-white"
                      }`}
                    >
                      {m.content}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
