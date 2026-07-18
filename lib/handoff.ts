// lib/handoff.ts — VIG-13: the waiting-room interval report (SBAR) for the clinician.
//
// DETERMINISTIC TEMPLATE FIRST — it ships regardless and is always correct. The Claude pass
// is a wording upgrade over the same facts, behind the standard failure funnel: any error,
// refusal, or truncation falls back to the template. Facts only from the persisted log; no
// diagnosis, no treatment suggestions (PLAN §5.2).

import Anthropic from "@anthropic-ai/sdk";
import { supabaseServer } from "./supabase-server";
import { PatientNotFoundError } from "./checkin-service";
import type { Alert, CdsProtocol, CheckinTrace, Question } from "./types";

const TZ = "America/Los_Angeles"; // venue clock for the demo

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

interface HandoffData {
  name: string;
  ageSex: string;
  complaint: string;
  esi: number;
  waitedMinutes: number;
  severityLine: string; // "5 (2:10 PM) → 6 (2:25 PM) → 7 (2:40 PM)"
  redFlags: { label: string; at: string }[];
  watchFlags: { label: string; at: string }[];
  negatives: string[]; // screens asked and answered negative
  alerts: { payload: string; at: string }[];
  ackAt: string | null;
  ackBy: string | null;
}

/**
 * Chip options that confirm nothing are the pertinent negatives when chosen — UNLESS a flag
 * from the same question was confirmed at any point (a negative that later turned positive
 * is not a negative; "no fever at 2:10" must not survive "fever confirmed at 2:40").
 */
function negativesFromTraces(protocol: CdsProtocol, traces: CheckinTrace[]): string[] {
  const confirmedAll = new Set(traces.flatMap((t) => t.confirmedFlags));
  const questions: Question[] = [...protocol.baseline, ...protocol.bank];
  const negatives = new Set<string>();
  for (const t of traces) {
    if (t.event.type !== "answers") continue;
    for (const [qid, val] of Object.entries(t.event.answers)) {
      const q = questions.find((x) => x.id === qid);
      if (q?.kind !== "chips") continue;
      const chosen = Array.isArray(val) ? val.map(String) : [String(val)];
      const opts = q.options.filter((o) => chosen.includes(o.value));
      if (opts.length > 0 && opts.every((o) => !o.flags?.length && !o.watch?.length)) {
        negatives.add(q.text);
      }
    }
  }
  // Drop any question whose flags were ever confirmed for this patient.
  return [...negatives].filter((text) => {
    const q = questions.find((x) => x.text === text);
    if (q?.kind !== "chips") return true;
    return !q.options.some((o) =>
      [...(o.flags ?? []), ...(o.watch ?? [])].some((f) => confirmedAll.has(f)),
    );
  });
}

async function collect(patientId: string): Promise<HandoffData> {
  const db = supabaseServer();
  const { data: p, error: pErr } = await db
    .from("patients")
    .select("name, age, sex, complaint, esi, protocol, created_at, ack_at, ack_by")
    .eq("id", patientId)
    .maybeSingle();
  if (pErr) throw new Error(`handoff: patients read failed: ${pErr.message}`);
  if (!p) throw new PatientNotFoundError(`no patient ${patientId}`);

  const { data: msgs, error: mErr } = await db
    .from("messages")
    .select("role, content, trace, created_at")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: true });
  if (mErr) throw new Error(`handoff: messages read failed: ${mErr.message}`);

  const protocol = p.protocol as CdsProtocol | null;
  const rows = msgs ?? [];
  const traces = rows
    .filter((m) => m.role === "agent" && m.trace && "event" in (m.trace as object))
    .map((m) => ({ trace: m.trace as CheckinTrace, at: m.created_at as string }));
  const alertRows = rows
    .filter((m) => m.role === "system" && (m.trace as Alert | null)?.kind === "alert")
    .map((m) => ({ payload: m.content as string, at: m.created_at as string }));

  // Severity trajectory with clock times (one point per trace that carried a new reading).
  const sevPoints: { sev: number; at: string }[] = [];
  for (const { trace, at } of traces) {
    const len = trace.severityHistory.length;
    if (len > 0 && len > sevPoints.length) {
      sevPoints.push({ sev: trace.severityHistory[len - 1], at });
    }
  }

  // First confirmation time per flag id.
  const flagAt = new Map<string, string>();
  for (const { trace, at } of traces) {
    for (const f of trace.confirmedFlags) {
      if (!flagAt.has(f)) flagAt.set(f, at);
    }
    for (const h of trace.hardPhraseHits) {
      const key = `hard:${h}`;
      if (!flagAt.has(key)) flagAt.set(key, at);
    }
  }
  const redFlags: { label: string; at: string }[] = [];
  const watchFlags: { label: string; at: string }[] = [];
  for (const [id, at] of flagAt) {
    if (id.startsWith("hard:")) {
      redFlags.push({ label: `patient reported "${id.slice(5)}"`, at: clock(at) });
    } else if (protocol && id in protocol.red) {
      redFlags.push({ label: protocol.red[id], at: clock(at) });
    } else if (protocol && id in protocol.watch) {
      watchFlags.push({ label: protocol.watch[id], at: clock(at) });
    }
  }

  return {
    name: p.name as string,
    ageSex: `${p.age ?? "?"}${((p.sex as string | null) ?? "").charAt(0).toUpperCase()}`,
    complaint: protocol?.complaint ?? ((p.complaint as string | null) ?? "unknown"),
    esi: p.esi as number,
    waitedMinutes: Math.max(
      0,
      Math.round((Date.now() - new Date(p.created_at as string).getTime()) / 60_000),
    ),
    severityLine: sevPoints.map((x) => `${x.sev} (${clock(x.at)})`).join(" → "),
    redFlags,
    watchFlags,
    negatives: protocol ? negativesFromTraces(protocol, traces.map((t) => t.trace)) : [],
    alerts: alertRows.map((a) => ({ payload: a.payload, at: clock(a.at) })),
    ackAt: p.ack_at ? clock(p.ack_at as string) : null,
    ackBy: (p.ack_by as string | null) ?? null,
  };
}

/** The deterministic SBAR — ships regardless; the Claude pass only rewords these facts. */
export function sbarTemplate(d: HandoffData): string {
  const lines: string[] = [
    `**Situation** — ${d.name}, ${d.ageSex}, ${d.complaint}, ESI ${d.esi}. Waiting ${d.waitedMinutes} min.`,
    `**Interval course** — ${d.severityLine ? `Severity ${d.severityLine}.` : "No severity readings yet."}${
      d.redFlags.length
        ? ` RED: ${d.redFlags.map((f) => `${f.label} (${f.at})`).join("; ")}.`
        : ""
    }${
      d.watchFlags.length
        ? ` Watch: ${d.watchFlags.map((f) => `${f.label} (${f.at})`).join("; ")}.`
        : ""
    }`,
    `**Pertinent negatives** — ${d.negatives.length ? d.negatives.join(" · ") : "none recorded yet."}`,
    `**Actions** — ${
      d.alerts.length
        ? d.alerts.map((a) => `alert at ${a.at} ("${a.payload}")`).join("; ")
        : "no alerts raised."
    }${d.ackAt ? ` Acknowledged ${d.ackAt}${d.ackBy ? ` by ${d.ackBy}` : ""}.` : ""}`,
  ];
  if (d.alerts.length > 0) {
    lines.push(`Re-triage was suggested at ${d.alerts[0].at}.`);
  }
  return lines.join("\n\n");
}

const HANDOFF_PROMPT = `Generate a waiting-room interval report for the clinician about to see this patient.
≤120 words, markdown, SBAR-style sections:
**Situation** — name, age, complaint, ESI, total time waiting.
**Interval course** — severity trajectory with clock times; red flags CONFIRMED with
timestamps; watch triggers.
**Pertinent negatives** — screens asked and answered negative (list them).
**Actions** — alerts raised, nurse acknowledgment times.
Facts only from the provided log. No diagnosis, no treatment suggestions. If an alert
was raised, end with "Re-triage was suggested at <time>."`;

/**
 * Template first, Claude upgrade behind the funnel (CLAUDE.md §2: omit thinking,
 * effort low, 4096 tokens, 30s timeout, ONE attempt). Never throws past the template.
 */
export async function generateHandoff(
  patientId: string,
): Promise<{ markdown: string; upgraded: boolean }> {
  const data = await collect(patientId);
  const template = sbarTemplate(data);

  try {
    const client = new Anthropic();
    const resp = await client.messages.create(
      {
        model: "claude-sonnet-5",
        max_tokens: 4096,
        output_config: { effort: "low" },
        system: HANDOFF_PROMPT,
        messages: [
          {
            role: "user",
            content: `FACT LOG (the only source of truth):\n${JSON.stringify(data, null, 2)}\n\nDeterministic draft to improve (keep every fact, every timestamp):\n${template}`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 },
    );
    if (resp.stop_reason === "refusal" || resp.stop_reason === "max_tokens") {
      return { markdown: template, upgraded: false };
    }
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // The upgrade must still carry the re-triage line when an alert exists — else template.
    if (!text || (data.alerts.length > 0 && !text.includes("Re-triage was suggested"))) {
      return { markdown: template, upgraded: false };
    }
    return { markdown: text, upgraded: true };
  } catch {
    return { markdown: template, upgraded: false };
  }
}
