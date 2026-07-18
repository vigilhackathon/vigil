// app/page.tsx — VIGIL landing: what this is + the three demo surfaces.
import Link from "next/link";

const SURFACES = [
  {
    href: "/emr",
    title: "Mock EMR — ER Dashboard",
    desc: "The nurse-facing board: every monitored patient, tier-sorted, escalation flag + chime, Acknowledge.",
  },
  {
    href: "/demo",
    title: "Demo Driver",
    desc: "Reset the staged patients and advance scripted beats through the real guardrail.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 p-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">
          VIGIL <span className="font-normal text-neutral-400">— the agent that watches the waiting room</span>
        </h1>
        <p className="text-sm leading-relaxed text-neutral-500">
          The reassessment layer for ED waiting-room patients (ESI 3–5). A patient enrolls from the
          EMR by QR, gets text check-ins paced by acuity, and a CDS-authored protocol with a{" "}
          <strong>deterministic guardrail the model cannot override</strong> tiers them
          Routine / Watch / Escalate. When things change, VIGIL calls the patient, pages the nurse,
          and compiles the SBAR interval handoff.
        </p>
        <p className="text-xs text-neutral-400">
          Built at The Future of Agentic AI in Healthcare (Abridge × Anthropic × Lightspeed), July 18, 2026.
          All patients synthetic. The model proposes; the guardrail floor disposes — the model never has the pager.
        </p>
      </header>

      <main className="space-y-3">
        {SURFACES.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="block rounded-lg border border-neutral-200 p-4 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
          >
            <div className="font-semibold">{s.title}</div>
            <div className="text-sm text-neutral-500">{s.desc}</div>
          </Link>
        ))}
        <p className="px-1 text-xs text-neutral-400">
          The patient surface (<code>/patient/[id]</code>) opens from each patient&apos;s QR — see the
          Demo Driver for links.
        </p>
      </main>
    </div>
  );
}
