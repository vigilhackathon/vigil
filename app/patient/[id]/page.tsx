"use client";

// app/patient/[id] — the patient "text" channel, mocked as a real SMS conversation.
// NO tap-chips / number-pads: the patient TYPES every reply (a number, "yes"/"no", or free
// text), exactly like a real text thread. The server parses replies deterministically
// (lib/checkin-service mapReplyToAnswer: scale → first number, yes/no → parseYesNo, chips →
// label match). SERVER-STATE-DRIVEN: polls GET /api/state (~2s) and renders from it, so
// driver-injected beats appear automatically.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

interface ThreadMessage {
  role: "agent" | "patient";
  content: string;
  createdAt: string;
}

interface ThreadState {
  patient: { id: string; name: string };
  identityConfirmed: boolean;
  phoneCaptured: boolean;
  baselineComplete: boolean;
  messages: ThreadMessage[];
}

// Short, SMS-length consent. No "front desk" framing; a real 911 safety net instead.
const CONSENT_BUBBLE =
  "Hi, it's VIGIL from the ED care team. I'll text a couple quick questions while you wait. Reply STOP to opt out.";

/** Normalize a typed date ("4/2/1992", "1992-04-02") to YYYY-MM-DD, or null. */
function toISODate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

export default function PatientThread() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<ThreadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [phoneStepDone, setPhoneStepDone] = useState(false);
  const kickoffSent = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?patientId=${id}`, { cache: "no-store" });
      if (!res.ok) {
        setError(res.status === 404 ? "This link isn't active." : "Connection hiccup…");
        return;
      }
      setError(null);
      setState((await res.json()) as ThreadState);
    } catch {
      setError("Connection hiccup…");
    }
  }, [id]);

  useEffect(() => {
    void refetch();
    const t = setInterval(() => void refetch(), 2000);
    return () => clearInterval(t);
  }, [refetch]);

  useEffect(() => {
    const n = state?.messages.length ?? 0;
    if (n !== lastCount.current) {
      lastCount.current = n;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [state?.messages.length]);

  // Once enrolled, fire the first check-in question exactly once.
  const enrolled = Boolean(state?.identityConfirmed && (state?.phoneCaptured || phoneStepDone));
  useEffect(() => {
    if (!state || kickoffSent.current) return;
    if (enrolled && state.messages.length === 0) {
      kickoffSent.current = true;
      void send("__timer__");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, enrolled]);

  // One text composer for everything. Routes by enrollment step.
  async function send(raw: string): Promise<void> {
    const body = raw === "__timer__" ? "" : raw.trim();
    if (raw !== "__timer__" && !body) return;
    setSending(true);
    setNotice(null);
    try {
      if (state && !state.identityConfirmed) {
        const dob = toISODate(body);
        if (!dob) {
          setNotice("Please type your date of birth like 04/02/1992.");
          return;
        }
        const res = await fetch("/api/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId: id, dob }),
        });
        const out = (await res.json()) as { ok: boolean };
        if (!out.ok) setNotice("That doesn't match our records — please try again.");
      } else if (state && !state.phoneCaptured && !phoneStepDone) {
        await fetch("/api/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId: id, phone: body }),
        });
        setPhoneStepDone(true);
      } else {
        await fetch("/api/checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patientId: id,
            event: raw === "__timer__" ? { type: "timer" } : { type: "sms_in", body },
          }),
        });
      }
      await refetch();
    } finally {
      setSending(false);
    }
  }

  function onSubmit() {
    const v = text;
    setText("");
    void send(v);
  }

  // What is VIGIL currently waiting for? (drives the placeholder + a lightweight prompt bubble)
  const promptBubble =
    state && !state.identityConfirmed
      ? "First, what's your date of birth? (MM/DD/YYYY)"
      : state && !state.phoneCaptured && !phoneStepDone
        ? "Thanks. What's the best mobile number to reach you?"
        : null;

  const placeholder =
    state && !state.identityConfirmed
      ? "Date of birth…"
      : state && !state.phoneCaptured && !phoneStepDone
        ? "Mobile number…"
        : "Text a reply…";

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white text-black">
      <header className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-600 font-semibold text-white">
          V
        </div>
        <div>
          <div className="text-sm font-semibold">VIGIL Care Team</div>
          <div className="text-xs text-gray-500">ED waiting room · text check-ins</div>
        </div>
      </header>

      <main className="flex-1 space-y-2 overflow-y-auto px-3 py-4">
        <Bubble role="agent">{CONSENT_BUBBLE}</Bubble>
        {!state && !error && <Bubble role="agent">…</Bubble>}
        {error && <div className="text-center text-xs text-gray-400">{error}</div>}

        {state?.messages.map((m, i) => (
          <Bubble key={`${m.createdAt}-${i}`} role={m.role}>
            {m.content}
          </Bubble>
        ))}

        {/* Enroll prompt only shows before check-ins begin (no messages yet). */}
        {promptBubble && state?.messages.length === 0 && <Bubble role="agent">{promptBubble}</Bubble>}

        {sending && <Bubble role="patient">…</Bubble>}
        <div ref={bottomRef} />
      </main>

      <footer className="border-t border-gray-200 bg-gray-50 px-3 py-3">
        {notice && <div className="mb-2 text-center text-xs text-red-600">{notice}</div>}
        <div className="flex gap-2">
          <input
            type="text"
            inputMode={!state?.identityConfirmed ? "numeric" : "text"}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            maxLength={500}
            className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm"
            aria-label="Message"
          />
          <button
            onClick={onSubmit}
            disabled={sending || !text.trim()}
            className="rounded-full bg-blue-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            aria-label="Send"
          >
            ↑
          </button>
        </div>
      </footer>
    </div>
  );
}

function Bubble({ role, children }: { role: "agent" | "patient"; children: React.ReactNode }) {
  const agent = role === "agent";
  return (
    <div className={`flex ${agent ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-[15px] leading-snug ${
          agent ? "rounded-bl-sm bg-gray-200 text-black" : "rounded-br-sm bg-blue-500 text-white"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
