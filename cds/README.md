# VIGIL CDS tool (VIG-6 prototype)

The "mock CDS" that authors a monitoring protocol per visit, then hands it to a
deterministic guardrail. Runnable Python prototype; ports to `lib/cds.ts`.

## The invariant (why it's split into two moments)

    MOMENT 1  author  — ONCE at intake. The model reads the FULL verbatim clinical
                        reference and authors a structured protocol (RED/WATCH flags,
                        cadence, questions). Then it is FROZEN for the visit.

    MOMENT 2  apply   — EVERY check-in. Split further:
                          extract : model reads free text, reports which FROZEN flags are
                                    present (closed set — cannot invent flags or set a tier)
                          decide  : PURE code maps confirmed flags -> tier (RED->high,
                                    WATCH->medium). Same flags => same tier, always.

The rules are frozen; the **tier still escalates** whenever new answers newly match a
frozen RED flag (see the demo: LOW -> MEDIUM -> HIGH on turn 3, rules unchanged).

`model_review()` is a raise-only net: the model may PROPOSE a higher tier for something the
protocol never anticipated; `final = max(rules, model)`. Gas pedal, never a brake.

## Files
- `resources/*.txt` — verbatim clinical reference per condition. **Clinician-owned.**
  Ships with: `cellulitis`, `abdominal_pain`, `fever`, `back_pain`.
- `cds.py` — `author_protocol` / `freeze_protocol` / `extract_flags` / `decide_tier` / `model_review`.
- `engine.py` — reference loading, triage-note routing (model-based chief-complaint match with a
  keyword fallback), stdlib Anthropic client (Opus 4.8).
- `demo.py` — the 50M / HTN+DM cellulitis patient, intake -> 3 check-ins -> escalation.
- `ask.py` — apply the frozen protocol to a single message.
- `selftest.py` — routing across all conditions + one authoring roundtrip.
- `visits/<id>.json` — a frozen protocol (written by the demo; the DB in VIGIL).

## Run
```bash
python3 cds/demo.py                              # full walkthrough
ANTHROPIC_API_KEY=sk-... python3 cds/demo.py     # live Claude authoring + extraction
python3 cds/ask.py "the pain is worse than it looks and the skin is going black"
```
Offline (no key) falls back to a bundled protocol + substring extraction so it still runs.

## Add a condition
Drop `resources/<id>.txt` (verbatim text). Model-based routing picks it up automatically;
add an entry to `engine.ROUTING_ALIASES` only for the offline keyword fallback. No clinical
logic in code — the model authors the protocol from the text.

## Production notes (for the TS port)
- Cache the frozen protocol per visit in the DB (one `author` call per patient).
- Replace the `extract` step with **tap-to-confirm chips** for escalation-grade RED flags —
  that removes model variance from the safety-critical path; `decide_tier` stays pure code.
- `decide_tier` is the deterministic guardrail floor; keep it dependency-free and unit-tested.
