"""Apply the FROZEN visit protocol to a single patient message (deterministic).

Run cds/demo.py first (it authors + freezes the protocol for VISIT_ID='demo-visit').
Then:
  python3 cds/ask.py "my redness spread past the line and the pain is a 7"
  python3 cds/ask.py --review "my tongue feels swollen"     # also run the raise-only net
"""

from __future__ import annotations

import argparse

from cds import apply_protocol, load_frozen, model_review
from engine import action_for, max_tier

VISIT_ID = "demo-visit"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("message", help="what the patient said this check-in")
    ap.add_argument("--review", action="store_true", help="also run the raise-only model net")
    args = ap.parse_args()

    frozen = load_frozen(VISIT_ID)
    if frozen is None:
        print("No frozen protocol yet — run `python3 cds/demo.py` first.")
        return

    result = apply_protocol(frozen, args.message)
    tier = result["tier"]
    print(f"  patient: {args.message}")
    print(f"  extract (model, closed set) -> {result['confirmed_ids']}")
    for f in result["confirmed_red"] + result["confirmed_watch"]:
        print(f"    {f['id']}: {f['label']}")
    print(f"  ==> {tier.upper()}  ({action_for(tier)})")

    if args.review:
        review = model_review(args.message, tier)
        final = max_tier(tier, review["proposed_tier"])
        print(f"  model proposes: {review['proposed_tier'].upper()} "
              f"(review_now={review.get('review_now')}) — {review.get('reason', '')}")
        print(f"  ==> FINAL max(rules, model): {final.upper()}")


if __name__ == "__main__":
    main()
