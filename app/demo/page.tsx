"use client";

// app/demo — VIG-14: the driver console. The team drives from here during the 3-min demo:
// Reset recreates Chen + Dave + seeds at T0; each Advance pushes one scripted beat through
// the REAL guardrail. The patient thread(s) update automatically (they poll /api/state).

import { useState } from "react";
import { SCRIPTS } from "@/lib/scripts";
import type { Tier } from "@/lib/types";

interface DemoPatient {
  slug: string;
  patientId: string;
}

interface AdvanceResult {
  ok: boolean;
  applied: boolean;
  tier?: Tier;
  expectedTier?: Tier;
  tierMatches?: boolean;
  patientAck?: string;
  escalateToCall?: boolean;
  error?: string;
}

const TIER_STYLE: Record<Tier, string> = {
  routine: "bg-emerald-100 text-emerald-800",
  watch: "bg-amber-100 text-amber-900",
  escalate: "bg-red-600 text-white",
};

export default function DemoDriver() {
  const [patients, setPatients] = useState<DemoPatient[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [lastTier, setLastTier] = useState<Record<string, Tier>>({});
  const [heroPhone, setHeroPhone] = useState("");

  const append = (line: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()} — ${line}`, ...l].slice(0, 30));

  async function reset(): Promise<void> {
    setBusy("reset");
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", ...(heroPhone ? { heroPhone } : {}) }),
      });
      const out = (await res.json()) as { patients?: DemoPatient[]; error?: string };
      if (!res.ok || !out.patients) {
        append(`RESET FAILED: ${out.error ?? res.status}`);
        return;
      }
      setPatients(out.patients);
      setLastTier({});
      append(`Reset ✓ — ${out.patients.map((p) => p.slug).join(", ")} recreated at T0`);
    } finally {
      setBusy(null);
    }
  }

  async function advance(slug: string, beatIndex: number): Promise<void> {
    setBusy(`${slug}-${beatIndex}`);
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "advance", slug, beatIndex }),
      });
      const out = (await res.json()) as AdvanceResult;
      if (!res.ok) {
        append(`${slug} beat ${beatIndex} FAILED: ${out.error}`);
        return;
      }
      if (!out.applied) {
        append(`${slug} beat ${beatIndex}: already applied (no-op)`);
        return;
      }
      if (out.tier) setLastTier((t) => ({ ...t, [slug]: out.tier! }));
      append(
        `${slug} beat ${beatIndex} → ${out.tier?.toUpperCase()}${out.escalateToCall ? " · 📞 CALL PLACED" : ""}${out.tierMatches ? "" : ` ⚠️ EXPECTED ${out.expectedTier}`} · "${out.patientAck}"`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 text-black">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">VIGIL — Demo Driver</h1>
          <p className="text-sm text-gray-500">
            Reset → advance beats in order. Threads update on their own.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="tel"
            placeholder="hero phone (for the call)"
            value={heroPhone}
            onChange={(e) => setHeroPhone(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            onClick={() => void reset()}
            disabled={busy !== null}
            className="rounded bg-black px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy === "reset" ? "Resetting…" : "Reset demo"}
          </button>
        </div>
      </header>

      {patients.map((p) => (
        <section key={p.slug} className="rounded-lg border border-gray-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold capitalize">
              {p.slug}
              {lastTier[p.slug] && (
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-xs font-bold uppercase ${TIER_STYLE[lastTier[p.slug]]}`}
                >
                  {lastTier[p.slug]}
                </span>
              )}
            </h2>
            <div className="flex gap-3 text-sm">
              <a className="text-blue-600 underline" href={`/patient/${p.patientId}`} target="_blank">
                thread
              </a>
              <a className="text-blue-600 underline" href={`/patient/${p.patientId}/qr`} target="_blank">
                QR
              </a>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(SCRIPTS[p.slug] ?? []).map((beat) => (
              <button
                key={beat.beatIndex}
                onClick={() => void advance(p.slug, beat.beatIndex)}
                disabled={busy !== null}
                className="rounded border border-gray-400 px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-40"
              >
                {busy === `${p.slug}-${beat.beatIndex}`
                  ? "Sending…"
                  : `Beat ${beat.beatIndex}: ${beat.event.type === "call_result" ? "📞 call result" : beat.beatIndex === 0 ? "baseline" : "text"} → ${beat.expectedTier}`}
              </button>
            ))}
          </div>
        </section>
      ))}

      {patients.length === 0 && (
        <p className="text-sm text-gray-400">No demo patients yet — hit Reset.</p>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-600">Driver log</h3>
        <div className="space-y-1 rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-700">
          {log.length === 0 ? "—" : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </section>
    </div>
  );
}
