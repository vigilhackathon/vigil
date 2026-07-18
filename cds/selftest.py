"""Quick multi-condition check: routing (offline) + one authoring roundtrip (live if key)."""

from __future__ import annotations

from cds import apply_protocol, author_protocol, freeze_protocol, load_frozen
from engine import action_for, get_condition_reference, load_references

ROUTING_CASES = [
    ("50M redness and warmth right lower leg, pain 5/10", "cellulitis"),
    ("72F periumbilical pain migrating to RLQ, nausea, low-grade fever", "abdominal_pain"),
    ("3-week-old, temperature 38.4, fussy, feeding less", "fever"),
    ("64M known prostate cancer, worsening mid-back pain, worse at night", "back_pain"),
]


def main() -> None:
    refs = load_references()
    print("references loaded:", sorted(refs.keys()))
    print("\nrouting:")
    ok = True
    for note, expected in ROUTING_CASES:
        hit = get_condition_reference(note)
        got = hit[0] if hit else None
        flag = "OK " if got == expected else "XX "
        ok = ok and got == expected
        print(f"  {flag}{expected:14} <- {note[:52]}")
    print(f"routing all-correct: {ok}")

    # One live authoring roundtrip on abdominal pain (the appendicitis arc).
    note = "72F periumbilical abdominal pain, ESI 3, waiting."
    cid, reference = get_condition_reference(note)
    print(f"\nauthoring protocol for '{cid}' from full reference ({len(reference)} chars)...")
    protocol = author_protocol(cid, reference)
    freeze_protocol(protocol, "selftest-abdo")
    frozen = load_frozen("selftest-abdo")
    print(f"  RED flags:   {len(frozen.get('red', []))}")
    print(f"  WATCH flags: {len(frozen.get('watch', []))}")

    beats = [
        "The pain is around my belly button, about a 4. No fever, no vomiting.",
        "The pain moved to my lower right side and I have a fever now, feeling nauseous.",
        "I feel faint and my belly is rock hard, the pain is a 10.",
    ]
    print("\n  check-ins (frozen protocol applied):")
    for i, b in enumerate(beats):
        r = apply_protocol(frozen, b)
        fired = [f["id"] for f in r["confirmed_red"] + r["confirmed_watch"]]
        print(f"    turn {i+1}: {r['tier'].upper():6} {fired}  ({action_for(r['tier'])})")


if __name__ == "__main__":
    main()
