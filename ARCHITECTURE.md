# VIGIL — Architecture (v4, current source of truth)

> **This document supersedes the pivoted sections of `PLAN.md`.** `PLAN.md` (v3.2) remains the
> reference for the safety model, guardrail tier rules, SDK usage, and Q&A — all still valid — but the
> **channel, clinical-content source, patient surface, and escalation mechanism changed in v4.** Where
> the two disagree, this file wins. Diagram: [`docs/vigil-architecture.excalidraw`](docs/vigil-architecture.excalidraw)
> (open at excalidraw.com → File → Open).

## One-liner

VIGIL is the reassessment layer for ESI 3–5 waiting-room patients. A patient scans a QR, is enrolled
from the EMR, and gets **SMS check-ins** paced by acuity. A **mock CDS authors a per-visit monitoring
protocol**; a **deterministic guardrail** the model can't override tiers them Routine/Watch/Escalate.
When the model senses worsening, **VIGIL calls the patient** for a richer, unscripted conversation.
Escalation pages the nurse and flags the EMR; the nurse acknowledges and goes to see the patient.

## What changed from v3.2 → v4

| Area | v3.2 (PLAN.md) | v4 (this doc) |
|---|---|---|
| Patient channel | Web page (QR → server-state-driven page) | **Twilio SMS** — patient uses the native Messages app; no web patient page |
| Hero case | Chen, abdominal pain (ABDO) | **Cellulitis** (leg redness / SKIN) |
| Clinical content | Hardcoded ABDO/BACK protocols | **Mock CDS authors the protocol per visit** (frozen + cached); real Glass Health = roadmap |
| Intake | Nurse triage form | **Mock FHIR EMR** lookup (works for any patient in a fake FHIR list) |
| Voice | Pre-generated mp3 on the web page | **Escalation phone call** (ElevenLabs Conversational AI + Twilio Voice) — the model calls when it senses worsening |
| Nurse surface | Standalone board | **Mock EMR UI**: ER Dashboard tab + Patient Record tab (framed as living inside the EMR) |
| After ack | Patient sees "a nurse reviewed" banner | **Silent** — patient is not told; the nurse just goes |

**Unchanged and still load-bearing:** the deterministic guardrail floor, `tier_final = max(rules, model)`,
delta-anchored severity, structured-confirmation-only escalation, the parse-failure funnel, cadence math,
escalate-sticky + stable-cycle hysteresis, same-reason dedup, the frozen alert payload, "the model never
holds the pager."

**Demo-channel note (v4.1):** real carrier SMS is blocked on Twilio A2P / toll-free verification, so for the
demo the patient "text" conversation is **mocked as an in-app web thread** (server-state-driven, opened via
QR, driver-injected beats) — and the **ElevenLabs voice call is the live external channel** (Twilio Voice,
no A2P needed). The outbound channel is a config value (`mock-web` | `sms` | `whatsapp`), so real SMS is a
one-flag switch once A2P clears (roadmap). Escalation-call wow no longer depends on carrier delivery.

## The safety invariant under dynamic protocols (the key idea)

Dynamic, CDS-authored protocols do **not** weaken the floor, because authoring and enforcement are split:

- **Author once (per visit):** the mock CDS + model produce a structured protocol — the questions and the
  **enumerated red/watch flag criteria, each tagged with its tier.** This is **frozen and cached** in the DB.
- **Enforce every check-in:** the deterministic guardrail maps each *confirmed structured answer* to its
  flag id and applies the frozen flag→tier map in code. The check-in model only picks the next question
  and drafts wording — it can never invent a flag or lower a tier.

So "the model learns what to ask" lives at authoring time; "the model can't override the floor" holds at
runtime. Free-text / open-ended voice answers can *suspect* flags but never escalate alone — they route to
a structured yes/no confirmation that parses deterministically.

## Component map

| Component | File(s) | Role |
|---|---|---|
| Types (frozen at PR0) | `lib/types.ts` | Tier · FhirPatient · CdsProtocol · CheckinEvent (sms_in \| timer \| call_result) · CheckinResult · CheckinTrace · Alert · Channel |
| Mock CDS | `lib/cds.ts` | `author(complaint) → CdsProtocol` (cellulitis content from Charumathi); cached per visit |
| Guardrail | `lib/guardrail.ts` | Pure deterministic floor + tests (`scripts/test-guardrail.ts`) |
| Check-in agent | `lib/agent.ts` | Claude: interpret answers, next question, `escalate_to_call` request; parse funnel |
| Brain | `lib/checkin-service.ts` | `processCheckin()` — one service for SMS webhook, call-result, and demo driver |
| EMR adapter | `lib/emr.ts` | Lookup over a seeded fake FHIR patient list |
| Notifier | `lib/notifier.ts` | Policy + dedup → nurse page (Twilio SMS) + EMR flag; alerts persisted as message rows |
| Server DB client | `lib/supabase-server.ts` | `import "server-only"`, secret key; all writes + transcript reads |
| Routes | `app/api/**` | `sms` (Twilio webhook), `enroll`, `ack`, `state`, `handoff`, `transcript`, `demo` |
| Nurse UI | `app/(emr)/**` | ER Dashboard tab + Patient Record tab (polling) |
| Demo driver | `app/demo`, `lib/scripts.ts` | Reset + per-beat advance (real guardrail, scripted glue) |
| Voice call [stretch] | ElevenLabs Conv AI + Twilio Voice | Escalation call; transcript re-enters the brain |

## Integrations / external services

- **Anthropic (Claude `claude-sonnet-5`)** — check-in interpretation + SBAR handoff. Server-side only.
- **Twilio** — SMS (required channel) + Voice (stretch call). Trial account texts **verified numbers only**;
  verify both demo iPhones before lunch.
- **ElevenLabs Conversational AI** — the real-time voice agent for the escalation call [stretch].
- **Supabase** — Postgres (patients, messages) + the mock EMR's data store.
- **Mock CDS (→ Glass Health)** — mocked for the demo; real API is roadmap.
- **Mock FHIR EMR** — seeded fake FHIR patient list; real FHIR/EMR write-back is roadmap.

## Scope tiers (pitch big, ship small)

- **Tier 1 — must ship, live-demoable (VIG-5 → VIG-15):** SMS text loop, mock FHIR/EMR enroll, mock CDS
  cellulitis protocol, deterministic guardrail, mock-EMR UI (dashboard + record), escalation flag + chime,
  nurse page, SBAR handoff.
- **Tier 2 — the wow, stretch (VIG-16):** the ElevenLabs escalation phone call. Guaranteed in the video;
  attempted live only after two clean dress runs.
- **Roadmap (spoken, not built):** real Glass Health CDS, real FHIR/EMR write-back, real paging
  (Voalte / TigerConnect / Epic Secure Chat), a live cadence scheduler.

## Demo plan (see PLAN §8 for the word-for-word script, updated for cellulitis)

- **3-min live** — reliability first. Scripted synthetic patients via the driver → real guardrail → real
  SMS → mock-EMR UI. Voice = the agent's questions (and, if stretch ships, the live call). Judges don't
  touch; the team drives throughout.
- **1-min video** — the tight, real-voice cut (recorded, retakeable); also the fallback floor if the live
  network dies.

## Linear

Team **Vigil Hackathon**. Tickets **VIG-5 … VIG-16** = **PR0 … PR11**, one PR per ticket, squash-merged to
`main` with a checkpoint before each merge. VIG-6 (mock CDS + cellulitis) is owned by Charumathi.
