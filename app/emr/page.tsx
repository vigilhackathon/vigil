"use client";

// app/emr — ER Dashboard tab. 1s polling of `patients` via the anon browser client (RLS
// allows anon select on patients). Sorted escalate → review_now → watch → routine. New
// escalations raise a flag + chime (Web Audio, behind a one-time sound-unlock click). Overdue
// ("monitoring lost") derived client-side from next_checkin_due. Unacked escalations render a
// MockVoalte page-preview + Acknowledge (→ /api/ack). After ack the agent stays silent.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import {
  ageSex,
  isOverdue,
  pagePreview,
  sortPatients,
  tierAccent,
  tierChip,
  TIER_LABEL,
  type PatientRow,
} from "./_ui";

const COLUMNS =
  "id,name,age,sex,complaint,esi,tier,review_now,suggested_action,tier_reason,trend,cadence_minutes,next_checkin_due,last_response_at,ack_at,ack_by,created_at";

export default function DashboardPage() {
  const [rows, setRows] = useState<PatientRow[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [soundOn, setSoundOn] = useState(false);

  const audioRef = useRef<AudioContext | null>(null);
  const prevEscalated = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  const chime = useCallback(() => {
    const ctx = audioRef.current;
    if (!ctx) return;
    const beep = (freq: number, start: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.24);
    };
    beep(880, 0);
    beep(1174, 0.16);
  }, []);

  const poll = useCallback(async () => {
    try {
      const { data, error: e } = await supabaseBrowser().from("patients").select(COLUMNS);
      if (e) throw new Error(e.message);
      const next = sortPatients((data ?? []) as unknown as PatientRow[]);
      setRows(next);
      setNowMs(Date.now());
      setError(null);

      // Chime on a NEW escalation (skip the first primed load so we don't blast on refresh).
      const escalatedNow = new Set(next.filter((p) => p.tier === "escalate" && !p.ack_at).map((p) => p.id));
      if (primed.current && soundOn) {
        for (const id of escalatedNow) {
          if (!prevEscalated.current.has(id)) {
            chime();
            break;
          }
        }
      }
      prevEscalated.current = escalatedNow;
      primed.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "poll failed");
    } finally {
      setLoaded(true);
    }
  }, [chime, soundOn]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, [poll]);

  function enableSound() {
    if (!audioRef.current) audioRef.current = new AudioContext();
    void audioRef.current.resume();
    setSoundOn(true);
  }

  async function acknowledge(patientId: string) {
    await fetch("/api/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patientId }),
    });
    poll();
  }

  const alerts = rows.filter((p) => p.tier === "escalate" && !p.ack_at);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Waiting room — active monitoring</h1>
        {soundOn ? (
          <span className="text-xs text-emerald-600">🔊 sound on</span>
        ) : (
          <button
            onClick={enableSound}
            className="rounded bg-neutral-800 px-3 py-1 text-xs text-white hover:bg-neutral-700"
          >
            🔊 enable sound
          </button>
        )}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          Board read failed: {error}
        </div>
      )}

      {/* MockVoalte page panel — the "in production this is Voalte/TigerConnect/Epic Secure Chat" beat. */}
      {alerts.length > 0 && (
        <section className="rounded-lg border-2 border-red-500 bg-red-50 p-3 dark:bg-red-950/40">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-600" />
            Nurse page — {alerts.length} unacknowledged escalation{alerts.length > 1 ? "s" : ""}
            <span className="font-normal text-red-400">(MockVoalte)</span>
          </div>
          <ul className="space-y-2">
            {alerts.map((p) => (
              <li key={p.id} className="flex items-start justify-between gap-3 rounded bg-white p-2 font-mono text-xs shadow-sm dark:bg-neutral-900">
                <span className="flex-1">{pagePreview(p)}</span>
                <button
                  onClick={() => acknowledge(p.id)}
                  className="shrink-0 rounded bg-red-600 px-3 py-1 font-sans text-white hover:bg-red-700"
                >
                  Acknowledge
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!loaded && <p className="text-sm text-neutral-500">Loading board…</p>}
      {loaded && rows.length === 0 && !error && (
        <p className="text-sm text-neutral-500">No patients enrolled yet.</p>
      )}

      <ul className="space-y-2">
        {rows.map((p) => {
          const overdue = isOverdue(p, nowMs);
          return (
            <li key={p.id}>
              <Link
                href={`/emr/patient/${p.id}`}
                className={`flex items-center justify-between gap-4 rounded-lg border border-l-4 border-neutral-200 bg-white p-3 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800 ${tierAccent(p.tier)}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-neutral-500">
                      {ageSex(p)} · {p.complaint ?? "—"} · ESI {p.esi}
                    </span>
                  </div>
                  <div className="truncate text-xs text-neutral-500">
                    {p.tier_reason ?? "no interval change"}
                    {p.trend ? ` · ${p.trend}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {overdue && (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                      monitoring lost — eyeball check
                    </span>
                  )}
                  {p.suggested_action === "calling" && p.tier !== "escalate" ? (
                    <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-900/50 dark:text-sky-300">
                      📞 calling to verify
                    </span>
                  ) : (
                    p.review_now &&
                    p.tier !== "escalate" && (
                      <span className="rounded bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-800 dark:bg-purple-900/50 dark:text-purple-300">
                        review now
                      </span>
                    )
                  )}
                  {p.ack_at && (
                    <span className="text-[10px] text-emerald-600">acknowledged</span>
                  )}
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${tierChip(p.tier)}`}>
                    {TIER_LABEL[p.tier]}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
