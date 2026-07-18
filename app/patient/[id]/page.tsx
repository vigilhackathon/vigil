"use client";

// app/patient/[id] — VIG-11: the patient "text" channel, MOCKED as an in-app thread styled
// like an SMS/iMessage conversation (real carrier SMS = env-flagged roadmap, see lib/channel).
//
// SERVER-STATE-DRIVEN: this page polls GET /api/state (~2s) and renders whatever the server
// says — the latest agent bubble, the current question's chips/scale. Taps POST /api/checkin
// then refetch. There is NO parallel client state machine: driver-injected beats appear here
// automatically because the phone is a viewer of server state.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { Question } from "@/lib/types";

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
  currentQuestion: Question | null;
  messages: ThreadMessage[];
}

const CONSENT_BUBBLE =
  "Hi, this is VIGIL, the ED waiting-room check-in assistant. I'll text you short questions while you wait so the care team can see how you're doing. I'm not a clinician and this isn't a substitute for emergency care — if anything feels like an emergency, tell the front desk immediately. Reply STOP to opt out.";

export default function PatientThread() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<ThreadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [dobError, setDobError] = useState(false);
  const [phoneStepDone, setPhoneStepDone] = useState(false);
  const [multiSel, setMultiSel] = useState<string[]>([]);
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

  // Auto-scroll when new bubbles arrive.
  useEffect(() => {
    const n = state?.messages.length ?? 0;
    if (n !== lastCount.current) {
      lastCount.current = n;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [state?.messages.length]);

  // After enroll completes, kick off the first agent question exactly once.
  useEffect(() => {
    if (!state || kickoffSent.current) return;
    const enrolled = state.identityConfirmed && (state.phoneCaptured || phoneStepDone);
    if (enrolled && state.messages.length === 0) {
      kickoffSent.current = true;
      void postEvent({ type: "timer" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, phoneStepDone]);

  async function postEvent(event: object): Promise<void> {
    setSending(true);
    try {
      await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: id, event }),
      });
      await refetch();
    } finally {
      setSending(false);
    }
  }

  async function confirmDob(): Promise<void> {
    if (!dob) return;
    setSending(true);
    setDobError(false);
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: id, dob }),
      });
      const out = (await res.json()) as { ok: boolean };
      if (!out.ok) setDobError(true);
      await refetch();
    } finally {
      setSending(false);
    }
  }

  async function submitPhone(skip: boolean): Promise<void> {
    if (!skip && phone) {
      await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: id, phone }),
      });
    }
    setPhoneStepDone(true);
    await refetch();
  }

  function answer(qid: string, value: string | string[] | number): void {
    setMultiSel([]);
    void postEvent({ type: "answers", answers: { [qid]: value } });
  }

  function sendText(): void {
    const body = text.trim();
    if (!body) return;
    setText("");
    void postEvent({ type: "sms_in", body });
  }

  const q = state?.currentQuestion ?? null;
  const enrolled = Boolean(state?.identityConfirmed && (state?.phoneCaptured || phoneStepDone));

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-white text-black">
      {/* SMS-thread header */}
      <header className="flex items-center gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-600 font-semibold text-white">
          V
        </div>
        <div>
          <div className="text-sm font-semibold">VIGIL Care Team</div>
          <div className="text-xs text-gray-500">ED waiting room · text check-ins</div>
        </div>
      </header>

      {/* Bubbles */}
      <main className="flex-1 space-y-2 overflow-y-auto px-3 py-4">
        <Bubble role="agent">{CONSENT_BUBBLE}</Bubble>

        {!state && !error && <Bubble role="agent">…</Bubble>}
        {error && <div className="text-center text-xs text-gray-400">{error}</div>}

        {state && !state.identityConfirmed && (
          <Bubble role="agent">
            First, let&apos;s confirm it&apos;s you. What&apos;s your date of birth?
            {dobError && (
              <span className="mt-1 block text-red-600">
                That doesn&apos;t match our records — please try again.
              </span>
            )}
          </Bubble>
        )}

        {state?.identityConfirmed && !state.phoneCaptured && !phoneStepDone && (
          <Bubble role="agent">
            Thanks. What&apos;s the best mobile number in case the care team needs to call you?
          </Bubble>
        )}

        {state?.messages.map((m, i) => (
          <Bubble key={`${m.createdAt}-${i}`} role={m.role}>
            {m.content}
          </Bubble>
        ))}

        {sending && <Bubble role="patient">…</Bubble>}
        <div ref={bottomRef} />
      </main>

      {/* Composer */}
      <footer className="border-t border-gray-200 bg-gray-50 px-3 py-3">
        {state && !state.identityConfirmed && (
          <div className="flex gap-2">
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm"
              aria-label="Date of birth"
            />
            <SendButton onClick={() => void confirmDob()} disabled={sending || !dob} />
          </div>
        )}

        {state?.identityConfirmed && !state.phoneCaptured && !phoneStepDone && (
          <div className="flex gap-2">
            <input
              type="tel"
              placeholder="(555) 555-0123"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm"
              aria-label="Mobile number"
            />
            <SendButton onClick={() => void submitPhone(false)} disabled={sending || !phone} />
            <button
              onClick={() => void submitPhone(true)}
              className="rounded-full px-3 py-2 text-xs text-gray-500"
            >
              Skip
            </button>
          </div>
        )}

        {enrolled && (
          <div className="space-y-2">
            {/* Structured answers for the current question */}
            {q?.kind === "scale" && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {Array.from({ length: 11 }, (_, n) => (
                  <button
                    key={n}
                    disabled={sending}
                    onClick={() => answer(q.id, n)}
                    className="h-9 w-9 rounded-full border border-teal-600 text-sm font-medium text-teal-700 active:bg-teal-600 active:text-white disabled:opacity-40"
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}

            {q?.kind === "chips" && !q.multi && (
              <div className="flex flex-wrap justify-center gap-2">
                {q.options.map((o) => (
                  <button
                    key={o.value}
                    disabled={sending}
                    onClick={() => answer(q.id, o.value)}
                    className="rounded-full border border-teal-600 px-4 py-2 text-sm text-teal-700 active:bg-teal-600 active:text-white disabled:opacity-40"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}

            {q?.kind === "chips" && q.multi && (
              <div className="space-y-2">
                <div className="flex flex-wrap justify-center gap-2">
                  {q.options.map((o) => {
                    const on = multiSel.includes(o.value);
                    return (
                      <button
                        key={o.value}
                        disabled={sending}
                        onClick={() =>
                          setMultiSel((s) =>
                            on ? s.filter((v) => v !== o.value) : [...s, o.value],
                          )
                        }
                        className={`rounded-full border px-4 py-2 text-sm disabled:opacity-40 ${
                          on
                            ? "border-teal-600 bg-teal-600 text-white"
                            : "border-teal-600 text-teal-700"
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  disabled={sending || multiSel.length === 0}
                  onClick={() => answer(q.id, multiSel)}
                  className="w-full rounded-full bg-teal-600 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            )}

            {/* Free text is always available — "something changed" path */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={q?.kind === "free" ? q.text : "Something changed? Type here…"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendText()}
                maxLength={500}
                className="flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm"
                aria-label="Message"
              />
              <SendButton onClick={sendText} disabled={sending || !text.trim()} />
            </div>
          </div>
        )}
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
          agent
            ? "rounded-bl-sm bg-gray-200 text-black"
            : "rounded-br-sm bg-blue-500 text-white"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function SendButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-blue-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      aria-label="Send"
    >
      ↑
    </button>
  );
}
