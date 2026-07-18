# VIGIL — Build Status Tracker (cross-session source of truth)

> **Read this + [ARCHITECTURE.md](ARCHITECTURE.md) at the start of EVERY session, before doing anything.**
> This is the git-native coordination file — it works even for a session without Linear access. Keep it and
> Linear in sync. Update rules: see **CLAUDE.md → "Session coordination — STATUS.md"**. If you did something
> meaningful and didn't record it here, you're not done.

**Last updated:** 2026-07-18 — PR0 merged. PR2 (colleague) + PR3 (subagent) in flight; Twilio/ElevenLabs setup next.

## Reference map
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — v4 source of truth (design, integrations, scope tiers).
- **[docs/vigil-architecture.excalidraw](docs/vigil-architecture.excalidraw)** — flow / integration diagram.
- **[PLAN.md](PLAN.md)** — safety model, guardrail tier rules, cadence math, SDK usage (v4 banner at top).
- **Linear** team *Vigil Hackathon*: `VIG-5…16` = PR0…PR11 · `VIG-17/18` = setup tasks.

## Ticket / PR status
Legend: ✅ done · 🟡 in progress · ⛔ blocked · ⚪ todo

| PR | Linear | Title | Status | Owner | Branch | Notes |
|----|--------|-------|--------|-------|--------|-------|
| PR0 | VIG-5 | scaffold + frozen v4 contracts | ✅ merged | Pranav/Claude | merged (PR #2) | `lib/types.ts` frozen, migration, `/api/sms` stub, smoke-parse. **zod/v4 required for SDK.** |
| PR1 | VIG-6 | mock CDS + cellulitis protocol | 🟡 | **Charumathi** | — | clinical content; she'll add the protocol MD |
| PR2 | VIG-7 | guardrail engine + tests | 🟡 | colleague | — | in progress |
| PR3 | VIG-8 | check-in agent (SMS + escalate-to-call) | 🟡 | Claude subagent | `pr03-agent` | in progress (background subagent) |
| PR4 | VIG-9 | checkin-service (brain) + supabase-server | ⚪ | — | — | needs PR1,2,3 |
| PR5 | VIG-10 | mock FHIR EMR + enroll + routes + smoke-api | ⚪ | — | — | needs PR4 |
| PR6 | VIG-11 | Twilio SMS channel | ⚪ | — | — | ⛔ needs VIG-17 + PR4 |
| PR7 | VIG-12 | Notifier + nurse paging | ⚪ | — | — | needs PR4 |
| PR8 | VIG-13 | Handoff/SBAR + transcript | ⚪ | — | — | needs PR4 |
| PR9 | VIG-14 | Demo driver + cellulitis scripts | ⚪ | — | — | needs PR6,7 |
| PR10 | VIG-15 | Mock EMR UI (dashboard + record tabs) | ⚪ | — | — | needs PR7,8 |
| PR11 | VIG-16 | [STRETCH] Escalation voice call | ⚪ | — | — | ⛔ needs VIG-18 + PR6 |
| SETUP | VIG-17 | Twilio account/number/verify/webhook | ⚪ | Pranav | — | **before lunch** |
| SETUP | VIG-18 | ElevenLabs Conv AI agent + import number | ⚪ | Pranav | — | stretch support |

## Setup checklist
- [ ] Supabase SQL run (patients + messages + realtime + RLS) — verify in dashboard
- [ ] Vercel import / deployed URL live
- [ ] Twilio: account + number (SMS+Voice) + verify both iPhones + webhook → `/api/sms` (VIG-17)
- [ ] ElevenLabs: Conv AI agent + import Twilio number (VIG-18)
- [x] Anthropic key in `.env.local`
- [x] ElevenLabs key + voice id in `.env.local`
- [x] Supabase URL + anon + service-role keys in `.env.local`

## Env vars (`.env.local`, never commit)
- **Present:** `ANTHROPIC_API_KEY` · `ELEVENLABS_API_KEY` · `ELEVENLABS_VOICE_ID` · `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY` · `DEMO_MODE`
- **Still needed:** `TWILIO_ACCOUNT_SID` · `TWILIO_AUTH_TOKEN` · `TWILIO_NUMBER` · `ELEVENLABS_AGENT_ID` · `ELEVENLABS_AGENT_PHONE_NUMBER_ID`

## Key decisions (log)
- **v4 pivot:** SMS-first (Twilio) · cellulitis hero · mock CDS authors the protocol per visit (frozen/cached) · mock FHIR EMR intake · escalation = ElevenLabs + Twilio **voice call** · nurse surface = mock EMR UI (dashboard + record tabs) · after-ack the agent is **silent** (no patient banner).
- **No standalone TTS / STT / pre-gen audio / MMS voice notes** — the only voice is the Conversational-AI call.
- **Safety invariant preserved under dynamic protocols:** CDS *authors* the flag→tier map once; the guardrail *applies* it deterministically. Model never lowers a tier, never holds the pager.
- **⚠️ zod/v4 REQUIRED for the SDK:** `@anthropic-ai/sdk@0.112.3`'s `zodOutputFormat` (from `@anthropic-ai/sdk/helpers/zod`) imports **`zod/v4`**. Any zod schema fed to `messages.parse` (agent.ts mirror, etc.) MUST `import { z } from "zod/v4"` — plain `import { z } from "zod"` fails type-check. `client.messages.parse({ …, output_config: { format: zodOutputFormat(schema) } }, { timeout, maxRetries: 0 })` confirmed working against the live API.
- **Workflow:** real GitHub PRs, squash-merge, checkpoint before each merge; branch per ticket. STATUS.md/coordination docs go straight to `main`.

## Build log (newest first)
### 2026-07-18
- **PR0 merged to main (PR #2).** VIG-5 → Done. Dispatched a background subagent for **PR3** (`lib/agent.ts`, branch `pr03-agent`) — opens its own PR, no merge. **PR2** (guardrail) in progress by a colleague. **PR1** (CDS/cellulitis) with Charumathi. Next: Twilio (VIG-17) + ElevenLabs (VIG-18) account setup with Pranav.
- **PR0 built + PR #2 opened** (awaiting checkpoint merge). Wrote `lib/types.ts` (frozen), `supabase/migrations/001_init.sql`, `app/api/sms/route.ts` (stub), `scripts/smoke-parse.ts`. Gate green: `npm run build` ✓ + live `smoke-parse` ✓. **Found: SDK needs `zod/v4`** (see decisions).
- **Added STATUS.md** (this file) + CLAUDE.md coordination rule (direct to main).
- **Linear rewritten to v4** (VIG-5…16 repurposed; VIG-17/18 setup added). VIG-6 assigned to Charumathi (In Progress). SMS/call tickets carry exact Twilio/ElevenLabs API specs.
- **Docs PR #1 merged to main:** ARCHITECTURE.md, excalidraw diagram, README (v4), PLAN/CLAUDE v4 banners.
- **Scaffold done** (Next 15.5.20 / React 19.1.0) + deps installed (uncommitted, rides on PR0 branch).

## Now / Next / Blocked
- **NOW:** PR1 (Charumathi), PR2 (colleague), PR3 (Claude subagent) in flight — all on the frozen types. Pranav + Claude doing Twilio (VIG-17) + ElevenLabs (VIG-18) setup.
- **NEXT:** PR4 (checkin-service, the integrator) once PR1+PR2+PR3 land; then PR5 routes, PR6 SMS (needs Twilio), PR7 notifier.
- **BLOCKED:** PR6 (SMS) & PR11 (call) on Twilio/ElevenLabs setup (VIG-17/18) — do the account setup in parallel with coding.
