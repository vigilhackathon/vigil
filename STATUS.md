# VIGIL — Build Status Tracker (cross-session source of truth)

> **Read this + [ARCHITECTURE.md](ARCHITECTURE.md) at the start of EVERY session, before doing anything.**
> This is the git-native coordination file — it works even for a session without Linear access. Keep it and
> Linear in sync. Update rules: see **CLAUDE.md → "Session coordination — STATUS.md"**. If you did something
> meaningful and didn't record it here, you're not done.

**Last updated:** 2026-07-18 — **PR4 MERGED** (#7) + **DEMO CHANNEL PIVOT** (text = mock web thread; ElevenLabs call = REQUIRED live channel). Split: guardrail session → **PR7 notifier** (then PR8) · orchestrator → **PR6 mock thread / PR11 call** · Charumathi → PR5+PR10 · Pranav → VIG-18 + Vercel env vars.

> **⚠️ ONE DIRECTORY = ONE SESSION.** The main clone `~/Hackathon/vigil` is the orchestrator (main). The guardrail session must work from a **separate clone** on `pr02-guardrail` (its WIP is already committed+pushed there). Do NOT run two sessions in the same folder — it shares one git HEAD and corrupts state.

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
| PR1 | VIG-6 | mock CDS + cellulitis protocol | ✅ merged | **Charumathi** | merged (PR #5) | `lib/cds.ts` (`MockCds.author`) + `scripts/test-cds.ts` green. Flags `R_*`/`W_*`; cadence routine 30 / watch 15 / escalate 5 |
| PR2 | VIG-7 | guardrail engine + tests | ✅ merged | Claude (guardrail clone) | merged (PR #4) | 17/17 + build green. **Guardrail × real CDS integration smoke: 8/8 green** (post-merge) |
| PR3 | VIG-8 | check-in agent (SMS + escalate-to-call) | ✅ merged | Claude subagent | merged (PR #3) | `lib/agent.ts` invariant-compliant (zod/v4, sonnet-5, no temp, 8s/0-retry funnel) |
| PR4 | VIG-9 | checkin-service (brain) + supabase-server | ✅ merged | Claude (guardrail clone) | merged (PR #7) | Live smoke 15/15 (real Supabase + Claude); re-smoked green after env fix incl. red-chip-mid-baseline case |
| PR5 | VIG-10 | mock FHIR EMR + enroll + routes + smoke-api | 🟡 in review | **Charumathi** | `charumathiraghus/vig-10-…` | **PR #10** — `lib/emr.ts` + `/api/enroll` (the missing patient-creation path) + `/api/ack` + `scripts/smoke-api.ts`; merged main, checkin/state deferred to PR6. Build+smoke pending Node |
| PR6 | VIG-11 | Patient text channel (MOCK web thread) + enroll UI | ✅ merged | Claude (guardrail clone) | merged (PR #9) | Thread + /api/state + /api/checkin + /api/confirm + QR; click-through verified |
| PR7 | VIG-12 | Notifier + nurse paging | 🟡 in review | Claude (guardrail clone) | `pr07-notifier` | **PR #8 open.** Live-smoked: page → same-category "2nd report" update → distinct-category breakthrough. Alert rows = `role='system'` + `trace.kind='alert'` (UI reads these). Twilio nurse-SMS env-gated stretch |
| PR8 | VIG-13 | Handoff/SBAR + transcript | 🟡 in review | Claude (guardrail clone) | `pr08-handoff` | **PR #11 open.** Template-first + Claude upgrade (funnel); negatives exclude later-positives; re-triage line enforced. Live-smoked + routes curled |
| PR9 | VIG-14 | Demo driver + cellulitis scripts | ⚪ | — | — | needs PR6,7 |
| PR10 | VIG-15 | Mock EMR UI (dashboard + record tabs) | 🟡 | **Charumathi** | — | **start fixture-first NOW** against frozen types; swap to real APIs when PR5/7/8 land |
| PR11 | VIG-16 | Escalation voice call (ElevenLabs) [REQUIRED — live channel] | ⚪ | — | — | needs VIG-18 + PR4; Twilio Voice works now |
| SETUP | VIG-17 | Twilio account/number/verify/webhook | ⚪ | Pranav | — | **before lunch** |
| SETUP | VIG-18 | ElevenLabs Conv AI agent + import number | ⚪ | Pranav | — | stretch support |

## Setup checklist
- [x] Supabase SQL run (patients + messages + realtime + RLS) ✓
- [x] Vercel auto-deploy wired (14 deploys) — ⚠️ add env vars in Vercel dashboard (only in local .env.local so far)
- [x] Twilio: account + funds + toll-free `+18559214240` (Voice) **imported into ElevenLabs**. SMS dropped (A2P); text mocked in-app. VIG-17 Done.
- [x] ElevenLabs (VIG-18 Done, via API): agent `agent_5101kxvhjabme0t9dg9ya5fgjdbw` (prompt+first msg, **5 data-collection fields**, voice set) + toll-free `phnum_3801kxvjper5e93s4p6n1bn5m2hy` + **post-call webhook → `https://vigil-six-psi.vercel.app/api/call-result` (HMAC, linked)**. ⚠️ **PR11 must implement `/api/call-result`** or the webhook 404s (fallback: poll `GET /v1/convai/conversations/{id}`).
- [x] Anthropic key in `.env.local`
- [x] ElevenLabs key + voice id in `.env.local`
- [x] Supabase URL + anon + service-role keys in `.env.local`

## Env vars (`.env.local`, never commit)
- **Present:** `ANTHROPIC_API_KEY` · `ELEVENLABS_API_KEY` · `ELEVENLABS_VOICE_ID` · `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY` · `DEMO_MODE`
- **Now also present:** `TWILIO_ACCOUNT_SID` · `TWILIO_AUTH_TOKEN` · `ELEVENLABS_AGENT_ID` · `ELEVENLABS_AGENT_PHONE_NUMBER_ID` · `ELEVENLABS_WEBHOOK_SECRET`
- **Still needed:** none for the demo (`TWILIO_NUMBER` only if we switch text→real SMS). ⚠️ **Mirror all of these into Vercel env vars** or the deployed app + call webhook won't work.

## Key decisions (log)
- **⚠️ `.env.local` gotcha:** `NEXT_PUBLIC_SUPABASE_URL` was pasted WITH a trailing `/rest/v1/` — supabase-js needs the bare project URL. `lib/supabase-server.ts` normalizes it defensively; **Session B's `lib/supabase-browser.ts` must normalize too (or fix the env value + Vercel copy).**
- **Escalate cadence = 10 min** (Pranav, resolving the 5-vs-10 discrepancy between the authored protocol and the VIG-9 spec). Fix = **PR #6** (`lib/cds.ts` one-liner, gates green) — touches Charumathi's PR1 file, so it awaits her sign-off before merge. PR4 reads cadence from `protocol.cadenceMinutes[tierFinal]` via `evaluate()`.
- **⚠️ DEMO CHANNEL PIVOT (SMS blocked on A2P):** patient "text" is **MOCKED as an in-app web thread** (server-state-driven, QR-opened, driver-injected beats); the **real ElevenLabs voice call is the live external channel** (Twilio Voice, no A2P). Twilio = Voice-only for demo. Channel kept as config (`mock-web`|`sms`|`whatsapp`) to flip later. Tickets: VIG-11 (mock thread), VIG-16 (call → REQUIRED), VIG-17 (Voice-only).
- **v4 pivot:** SMS-first (Twilio) · cellulitis hero · mock CDS authors the protocol per visit (frozen/cached) · mock FHIR EMR intake · escalation = ElevenLabs + Twilio **voice call** · nurse surface = mock EMR UI (dashboard + record tabs) · after-ack the agent is **silent** (no patient banner).
- **No standalone TTS / STT / pre-gen audio / MMS voice notes** — the only voice is the Conversational-AI call.
- **Safety invariant preserved under dynamic protocols:** CDS *authors* the flag→tier map once; the guardrail *applies* it deterministically. Model never lowers a tier, never holds the pager.
- **⚠️ zod/v4 REQUIRED for the SDK:** `@anthropic-ai/sdk@0.112.3`'s `zodOutputFormat` (from `@anthropic-ai/sdk/helpers/zod`) imports **`zod/v4`**. Any zod schema fed to `messages.parse` (agent.ts mirror, etc.) MUST `import { z } from "zod/v4"` — plain `import { z } from "zod"` fails type-check. `client.messages.parse({ …, output_config: { format: zodOutputFormat(schema) } }, { timeout, maxRetries: 0 })` confirmed working against the live API.
- **Workflow:** real GitHub PRs, squash-merge, checkpoint before each merge; branch per ticket. STATUS.md/coordination docs go straight to `main`.

## Build log (newest first)
### 2026-07-18
- **PR #10 (VIG-10) reconciled + updated (Charumathi session).** VIG-10 ships only the non-overlapping pieces now: `lib/emr.ts` (seeded mock FHIR list + `lookup(name,dob)`/`getById` token; 3 cellulitis presentations incl. the 50M HTN+DM hero), `POST /api/enroll` (the **first patient-creation path** — EMR lookup → `MockCds.author` protocol frozen at intake → INSERT `patients`; feeds PR6's `/patient/[id]` thread), `POST /api/ack` (`ack_by='charge-desk-demo'`), and `scripts/smoke-api.ts` (enroll→confirm→baseline→watch→escalate→ack; tiers asserted from `/api/checkin`, ack verified via a direct DB read). Merged `main`; **took PR6's `/api/checkin` + `/api/state`** (no duplication); `@/lib` imports. ⚠️ **Build + smoke-api NOT yet run (no Node in that session)** — run `npm run build` + `node --env-file=.env.local --import tsx scripts/smoke-api.ts` (dev server up) before merge. Next from this session: VIG-15/PR10 UI.
- **PR8 built → PR #11 open (guardrail-clone session).** `lib/handoff.ts` (deterministic SBAR template first; Claude upgrade behind the funnel — upgrade REJECTED if it drops the re-triage line) + `POST /api/handoff` + `GET /api/transcript` (nurse-side, traces + alert rows). Live-smoked on a Chen-equivalent arc: trajectory w/ clock times, flags w/ timestamps, **negatives exclude later-positives** (smoke caught fever listed as negative after it turned RED — fixed), alert + ack, re-triage line; routes curled on dev (200/404). PR6 (#9) merged; **Charumathi's PR #10 (VIG-10) open**. Remaining unclaimed: VIG-14 driver, VIG-16 call.
- **PR6 built → PR #9 open (guardrail-clone session).** Mock web thread (`app/patient/[id]`, iMessage-styled, server-state-driven 2s polling, consent bubble, DOB gate w/ server-side check, phone capture for the escalation call, chips/multi/scale taps, free text → sms_in) + `/patient/[id]/qr` + **new routes `GET /api/state` (patient-safe: no traces/tiers/ack), `POST /api/checkin`, `POST /api/confirm`** + `lib/channel.ts` (mock-web|sms|whatsapp config). checkin-service polish: readable patient transcript rows (labels not JSON), first-contact ack, **pager copy deterministic-first** (flag labels + numeric trend). **Click-through verified on the running app:** wrong DOB rejected → enroll → baseline walk → red-flag chip escalated at baseline (tier/cadence/alert row all correct in DB) → live-model bank turn. Gates green. **PR10/PR9 note:** thread consumes /api/state; driver beats will appear on it automatically.
- **PR7 built → PR #8 open (guardrail-clone session).** `lib/notifier.ts` (`notifyEscalation` — persisted alert rows as UI source of truth, frozen `WR:` payload, same-reason dedup via `alertCategory`/`shouldPushAlert`, Console always-on + env-gated Twilio nurse-SMS via plain fetch) + checkin-service wiring (fires on every deterministic escalate; notifier errors never 500 a check-in). **Live-smoked vs real Supabase:** page → same-category "2nd report" in-place update → distinct-category breakthrough → check-ins unaffected. Found + fixed: prior-trace extraction crashed on alert rows. **PR10 note:** UI reads alerts via `role='system'` + `trace.kind='alert'`. Next from this session: VIG-13/PR8 handoff.
- **DEMO CHANNEL PIVOT (Pranav):** real SMS blocked on A2P/toll-free verification → **text mocked as an in-app web thread**; **ElevenLabs voice call promoted to the REQUIRED live channel** (Twilio Voice works now). Updated VIG-11 (mock web thread), VIG-16 (required), VIG-17 (Voice-only) + ARCHITECTURE. The escalation-call "wow" no longer depends on carrier SMS.
- **PR4 MERGED (#7); next-wave split (updated post-pivot).** VIG-9 → Done (re-smoked green post env-fix, incl. red-chip-mid-baseline escalation). Assignments: guardrail session → **VIG-12/PR7 notifier** (In Progress, `pr07-notifier`), then VIG-13/PR8 · orchestrator → **VIG-11/PR6 = MOCK web thread + enroll UI** (pivot supersedes the earlier Twilio-SMS guidance on that ticket) or **VIG-16 call wiring** once VIG-18 completes · Charumathi → VIG-10 + VIG-15 · Pranav → VIG-18 (ElevenLabs agent + import TF number), Vercel env vars.
- **PR4 built → PR #7 open (guardrail-clone session).** `lib/checkin-service.ts` (`processCheckin` — baseline accumulation, protocol freeze via MockCds, deterministic SMS→answer mapping, model funnel, guardrail floor, cadence 30/15/10, one agent row per question w/ CheckinTrace) + `lib/supabase-server.ts` (server-only boundary). **Verified live:** 15/15 smoke vs real Supabase + real Claude — incl. a live-model turn where cited-but-unconfirmed flags were discarded (invariant 5). Found + fixed: severityHistory double-seeded baseline; found: env URL gotcha (see decisions). Gates green. Once #7 merges: PR5 routes wire up, PR7 notifier + PR8 handoff unblock.
- **PR #6 merged (cadence 30/15/10) + WORK SPLIT assigned** (3 sessions + Pranav-on-Twilio): guardrail-clone session → **VIG-9/PR4** (In Progress, branch `pr04-checkin-service`) · orchestrator session → **VIG-10/PR5 fixture-first** (`lib/emr.ts` + smoke-api skeleton now; routes when PR4 lands — guidance commented on the ticket) · Charumathi → **VIG-15/PR10 fixture-first** (guidance commented). Next picks after PR4: VIG-12 (notifier), VIG-13 (handoff); VIG-11 (SMS) when Twilio verify clears.
- **Cadence decision + Linear graph wiring (guardrail-clone session):** Pranav decided **escalate cadence = 10 min**; opened **PR #6** (one-line `lib/cds.ts` fix, all gates + updated integration smoke green) — flagged for Charumathi since it's her PR1 file. Also wired the 7 missing `blockedBy` relations in Linear (VIG-10/12/13←VIG-9 · VIG-14←VIG-11+12 · VIG-15←VIG-12+13) so the board shows the true build order; decision + guidance commented on VIG-9.
- **Health check on merged main (guardrail-clone session):** PRs #3 (agent), #4 (guardrail), #5 (CDS) all squash-merged; no open PRs. Full gate sweep on `main`: `npm run build` ✓ · `test-guardrail` 17/17 ✓ · `test-cds` ✓. **Cross-integration smoke (guardrail × real `MockCds.author("cellulitis")`) 8/8 green** — baseline red chip escalates, W_SPREAD watches, R_RAPID escalates, real hardPhrases escalate on degraded model, model-escalate-w/o-flag → watch+review_now, cadence map (30/15/5) flows through, next-question substitution + dedup work on real ids. **Nothing broken.** ⚠️ Note for PR4: VIG-9's ticket text says escalate cadence 10; the authored protocol says 5 — the guardrail reads `protocol.cadenceMinutes[tier]`, so the protocol (5) wins unless humans say otherwise. Linear synced: VIG-6 → Done, VIG-9 noted unblocked.
- **PR #4 (guardrail) opened** from the separate `vigil-guardrail` clone — VIG-7 → In Review, **not merged** (checkpoint). `lib/guardrail.ts` is pure + protocol-agnostic (applies any `CdsProtocol`; decoupled from PR1's `lib/cds.ts`). `scripts/test-guardrail.ts` = cellulitis fixture + 17/17 PLAN §7.1 cases green; `npm run build` green. Exports for PR4/PR7: `evaluate`, `confirmedFlagsFromAnswers`, `hardPhraseHits`, `rulesTier`, `validateModel`, `validateNextQuestionId`, `parseYesNo`, `alertCategory`, `shouldPushAlert`, `maxTier`. Cadence read from `protocol.cadenceMinutes[tier]`.
- **Setup:** Supabase SQL run ✓. Twilio funded; toll-free number has Voice but **SMS blocked pending toll-free verification** (submitted) — got a local number as backup. Vercel auto-deploy confirmed (env vars still need adding in dashboard). ElevenLabs Conv AI agent setup in progress.
- **PR #3 (agent.ts) opened** by the subagent — build green, mergeable, **not merged** (awaiting checkpoint). Notable: `confidence` unbounded in zod; history folded into one user message.
- **Deconflicted the shared working tree:** the guardrail session was coding in the SAME directory. Committed its WIP to `pr02-guardrail` + pushed; returned this dir to `main`. Guardrail must continue from a **separate clone**.
- **Setup progress:** Twilio Account SID + Auth Token added to `.env.local` (phone number pending). Supabase SQL **not yet run**. Vercel: assumed auto-deploy (verifying).
- **PR0 merged to main (PR #2).** VIG-5 → Done. Dispatched a background subagent for **PR3** (`lib/agent.ts`, branch `pr03-agent`) — opens its own PR, no merge. **PR2** (guardrail) in progress by a colleague. **PR1** (CDS/cellulitis) with Charumathi. Next: Twilio (VIG-17) + ElevenLabs (VIG-18) account setup with Pranav.
- **PR0 built + PR #2 opened** (awaiting checkpoint merge). Wrote `lib/types.ts` (frozen), `supabase/migrations/001_init.sql`, `app/api/sms/route.ts` (stub), `scripts/smoke-parse.ts`. Gate green: `npm run build` ✓ + live `smoke-parse` ✓. **Found: SDK needs `zod/v4`** (see decisions).
- **Added STATUS.md** (this file) + CLAUDE.md coordination rule (direct to main).
- **Linear rewritten to v4** (VIG-5…16 repurposed; VIG-17/18 setup added). VIG-6 assigned to Charumathi (In Progress). SMS/call tickets carry exact Twilio/ElevenLabs API specs.
- **Docs PR #1 merged to main:** ARCHITECTURE.md, excalidraw diagram, README (v4), PLAN/CLAUDE v4 banners.
- **Scaffold done** (Next 15.5.20 / React 19.1.0) + deps installed (uncommitted, rides on PR0 branch).

## Now / Next / Blocked
- **NOW:** PR7 notifier (guardrail session) · PR6 mock web thread (orchestrator) · PR5+PR10 (Charumathi) · VIG-18 ElevenLabs setup + Vercel env vars (Pranav). Freeze 15:45 — demo-critical order post-pivot: mock thread → notifier → driver → UI → **voice call (now REQUIRED)**; handoff fits between.
- **NEXT:** PR5 (EMR/enroll/routes/smoke-api) right behind PR4; then PR6 SMS (needs Twilio verify), PR7 notifier, PR8 handoff. Add env vars in the Vercel dashboard.
- **BLOCKED:** PR6 (SMS) & PR11 (call) on Twilio/ElevenLabs setup (VIG-17/18) — do the account setup in parallel with coding.
