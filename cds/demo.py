"""VIG-6 hybrid demo: author once (frozen) -> apply deterministically every check-in.

Patient: 50 y/o male, HTN + poorly-controlled DM, right lower-leg redness, pain 5/10.

Shows:
  1. INTAKE   — the model reads the full cellulitis reference and authors a protocol; frozen.
  2. CHECK-INS — a deterministic guardrail applies the FROZEN protocol; tier escalates on
     turn 3 without the rules ever changing.
  3. REPRODUCIBLE — the same answer yields the same tier every time.
  4. RAISE-ONLY NET — the model can push a novel concern up, never down (max(rules, model)).

Run:
  python3 cds/demo.py                              # simulated (no key)
  ANTHROPIC_API_KEY=sk-... python3 cds/demo.py     # live Claude authoring
"""

from __future__ import annotations

import os

from cds import (
    apply_protocol,
    author_protocol,
    decide_tier,
    freeze_protocol,
    load_frozen,
    model_review,
)
from engine import action_for, get_condition_reference, max_tier

VISIT_ID = "demo-visit"

TRIAGE_NOTE = (
    "50 y/o male. PMH: hypertension, type 2 diabetes (poorly controlled). Right lower-leg "
    "redness and warmth, started a few hours ago. Pain 5/10. Ambulatory, alert."
)

BEATS = [
    "No fever. No blisters or sores. The redness looks the same as the mark you drew. Pain still about 5.",
    "The red area is a bit bigger than the line the nurse drew, and it feels warmer. Pain is up to about 7.",
    "The pain is a 9 now and it hurts way more than it looks. Some skin is turning dark purple, almost black, and part of it feels numb.",
]

NOVEL_BEAT = "My leg looks the same, but my tongue feels swollen and I'm a bit short of breath."


def bar():
    print("=" * 74)


def main() -> None:
    refs_hit = get_condition_reference(TRIAGE_NOTE)
    if refs_hit is None:
        print("No matching reference. Add one to resources/.")
        return
    condition_id, reference = refs_hit

    bar()
    print("VIG-6 CDS — author once (frozen), apply deterministically")
    bar()
    live = bool(os.environ.get("ANTHROPIC_API_KEY"))
    print(f"reasoning mode: {'LIVE Claude authoring' if live else 'SIMULATED (no key)'}")
    print(f"\nTRIAGE NOTE:\n  {TRIAGE_NOTE}")

    # ---- MOMENT 1: author + freeze (once) ----
    print("\n" + "-" * 74)
    print("INTAKE  — model reads the FULL reference and authors the protocol (ONCE)")
    print("-" * 74)
    protocol = author_protocol(condition_id, reference)
    path = freeze_protocol(protocol, VISIT_ID)
    print(f"[cds] authored + FROZEN -> {path.name}")
    print("  RED (escalate):")
    for f in protocol["red"]:
        print(f"    {f['id']}  {f['label']}")
    print("  WATCH (recheck 15m):")
    for f in protocol["watch"]:
        print(f"    {f['id']}  {f['label']}")

    # ---- MOMENT 2: apply the frozen protocol every check-in (deterministic) ----
    frozen = load_frozen(VISIT_ID)  # re-load to prove we apply the locked copy
    print("\n" + "-" * 74)
    print("CHECK-INS  — deterministic guardrail applies the FROZEN protocol (no model)")
    print("-" * 74)
    last_confirmed = []
    for i, reply in enumerate(BEATS):
        result = apply_protocol(frozen, reply)
        tier = result["tier"]
        fired = result["confirmed_red"] + result["confirmed_watch"]
        last_confirmed = result["confirmed_ids"]
        print(f"\nturn {i + 1}  patient: {reply}")
        print(f"          extract (model, closed set) -> {result['confirmed_ids']}")
        for f in fired:
            print(f"          {f['id']}: {f['label']}")
        print(f"   ==> {tier.upper()}  ({action_for(tier)})")

    # ---- REPRODUCIBILITY ----
    print("\n" + "-" * 74)
    print("REPRODUCIBLE  — decide_tier is PURE: same confirmed flags => same tier, always")
    print("-" * 74)
    tiers = [decide_tier(frozen, last_confirmed)["tier"] for _ in range(5)]
    print(f"  confirmed {last_confirmed} -> {tiers}  (deterministic: {len(set(tiers)) == 1})")
    print("  (extraction uses the model; production uses tap-to-confirm chips for red flags,")
    print("   removing even that variance — the flag->tier mapping is always frozen code.)")

    # ---- RAISE-ONLY NET ----
    print("\n" + "-" * 74)
    print("RAISE-ONLY NET  — a concern the cellulitis protocol never anticipated")
    print("-" * 74)
    rules_tier = apply_protocol(frozen, NOVEL_BEAT)["tier"]
    print(f"\npatient: {NOVEL_BEAT}")
    print(f"  frozen rules alone   : {rules_tier.upper()} (no cellulitis phrase matched)")
    review = model_review(NOVEL_BEAT, rules_tier)
    final = max_tier(rules_tier, review["proposed_tier"])
    print(f"  model proposes       : {review['proposed_tier'].upper()} "
          f"(review_now={review.get('review_now')}) — {review.get('reason', '')}")
    print(f"   ==> FINAL max(rules, model): {final.upper()}  "
          f"(model raised, never lowered)")

    print("\n" + "=" * 74)
    print("Rules frozen at intake; tier still escalated on turn 3, reproducibly;")
    print("and the model can only ever push a tier UP.")
    print("=" * 74)


if __name__ == "__main__":
    main()
