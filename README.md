# VIGIL — the agent that watches the waiting room

An agentic **reassessment layer** for the gap between ED triage and being seen. A waiting-room patient
(ESI 3–5) scans a QR, is enrolled from the EMR, and gets **SMS check-ins** paced by acuity. A mock
clinical-decision-support tool authors a per-visit monitoring protocol; a **deterministic safety guardrail
the model cannot override** tiers the patient **Routine / Watch / Escalate**. When the model senses
worsening, **VIGIL calls the patient** for a richer conversation. Escalation **pages the nurse and flags
the EMR**; the nurse acknowledges and goes to see the patient. An interval **SBAR handoff** compiles the
whole waiting-room course in seconds.

> *"We built this for the ESI-3 patient: sick enough to be seen, stable enough to wait hours, and the only
> person in the ER whose deterioration is nobody's job to notice."*

Built for **The Future of Agentic AI in Healthcare** hackathon (Abridge × Anthropic × Lightspeed),
San Francisco, July 18, 2026.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — current (v4) system design, component map, integrations, scope tiers.
- **[docs/vigil-architecture.excalidraw](docs/vigil-architecture.excalidraw)** — the flow/integration diagram (open at excalidraw.com → File → Open).
- **[PLAN.md](PLAN.md)** — full build plan, safety model, guardrail tier rules, prompts, Q&A (v3.2; see ARCHITECTURE.md for what v4 changed).
- **[CLAUDE.md](CLAUDE.md)** — operating instructions for the build.

## Architecture at a glance

```
Patient (Messages app) ─SMS─► Twilio ─► /api/sms ─► checkin-service ─► guardrail (deterministic floor)
        ▲                                                │  │  │
        └────── ☎ escalation call ◄── ElevenLabs ────────┘  │  └─► Claude (interpret + next question)
           (Twilio Voice)                                    │      Mock CDS (authors protocol)
                                                             │      Mock FHIR EMR (intake)
                                          on Escalate ──► Notifier ─► page nurse (SMS) + EMR flag
                                                             ▼
                              Supabase ◄────────────────────┘ ──poll──► Mock EMR UI (Dashboard + Record + SBAR)
```

## Safety, in one line

The model proposes; a **deterministic guardrail floor disposes** — `tier_final = max(rulesTier, modelTier)`.
Escalation-grade flags come only from structured confirmations or hard phrases, never from free-text/voice
interpretation alone. The CDS *authors* the flag→tier map once per visit (frozen); the guardrail *applies*
it deterministically. The model never holds the pager.

## Built today

Everything after the 10:30 commit is event-hours work; pre-event = plan, hygiene, and accounts. Commit
history is the receipt. All patient data is synthetic.

## Team

- Pranav Sanghvi — engineering, guardrail/architecture
- Charumathi Raghu — EM physician, clinical content & framing

## License

MIT
