"""The (mock) CDS — VIG-6.

Two moments, and the whole safety story lives in the split between them:

  MOMENT 1  author_protocol()  — happens ONCE at intake.
      The model reads the FULL verbatim clinical reference and authors a structured
      monitoring protocol for this visit: RED (escalate) and WATCH criteria, each with the
      plain phrases a patient might text, plus cadence and the interval-change question.
      Then freeze_protocol() locks it (here: a JSON file per visit; in VIGIL: the DB).

  MOMENT 2  apply_protocol()   — happens EVERY check-in, deterministically.
      Pure code. No model. It matches the patient's answer against the FROZEN phrases and
      returns a tier. Same answers -> same tier, forever. This is the guardrail floor.

  model_review()  — optional raise-only net. The model may PROPOSE a higher tier for
      something the frozen protocol never anticipated; final = max(rules, model). The model
      has a gas pedal, never a brake.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from engine import TIER_CADENCE, call_model_json, max_tier

VISITS_DIR = Path(__file__).parent / "visits"


# --------------------------------------------------------------------------- #
# MOMENT 1 — author once, from the full reference
# --------------------------------------------------------------------------- #
AUTHOR_SYSTEM = """You are a clinical decision-support authoring service. You are given the \
FULL clinical reference for a patient's presenting complaint. Author a monitoring protocol \
that a deterministic guardrail will apply, unchanged, for the rest of this visit.

Return ONLY JSON:
{
  "condition": "<id>",
  "red":   [ {"id":"R1","label":"<clinician-facing criterion>","patient_signals":["<plain lowercase phrase a patient might type>", ...]} ],
  "watch": [ {"id":"W1","label":"<criterion>","patient_signals":["<phrase>", ...]} ],
  "interval_question": "<the one recurring plain question that best tracks change, <=6th grade>",
  "baseline_questions": ["<plain question>", ...]
}

Rules:
- RED = findings the reference says warrant urgent escalation / surgical or IV escalation.
- WATCH = concerning but not emergent (systemic-risk or mild progression).
- patient_signals are how a lay patient in a waiting room would describe that finding in a
  text message — short, lowercase, no jargon. Include several phrasings each.
- Derive everything from the reference. Do not invent findings it does not mention."""


def author_protocol(condition_id: str, reference: str) -> dict:
    """MOMENT 1: model reads the full reference and authors the protocol (once)."""
    user = f"Condition id: {condition_id}\n\nFULL CLINICAL REFERENCE:\n{reference}"
    authored = call_model_json(AUTHOR_SYSTEM, user, max_tokens=4000)
    if authored is None:
        # NEVER substitute another condition's rules — that is a silent, dangerous fallback.
        # The only offline fallback is cellulitis's own bundled protocol (for keyless demos).
        if condition_id == "cellulitis":
            authored = json.loads(json.dumps(_SIMULATED_PROTOCOL))
        else:
            raise RuntimeError(
                f"CDS authoring failed for '{condition_id}': model returned no valid JSON "
                f"(set ANTHROPIC_API_KEY, or the output was truncated). Refusing to fall back "
                f"to a different condition's protocol."
            )
    authored["condition"] = condition_id
    authored["cadence_minutes"] = dict(TIER_CADENCE)
    return authored


def freeze_protocol(protocol: dict, visit_id: str) -> Path:
    """Lock the protocol for this visit (VIGIL: DB cache; here: a file)."""
    VISITS_DIR.mkdir(exist_ok=True)
    path = VISITS_DIR / f"{visit_id}.json"
    path.write_text(json.dumps(protocol, indent=2))
    return path


def load_frozen(visit_id: str) -> Optional[dict]:
    path = VISITS_DIR / f"{visit_id}.json"
    return json.loads(path.read_text()) if path.exists() else None


# --------------------------------------------------------------------------- #
# MOMENT 2 — apply every turn.  EXTRACT (model, closed-set) -> DECIDE (pure code).
# --------------------------------------------------------------------------- #
EXTRACT_SYSTEM = """You are an information extractor for a waiting-room monitor. Below is a \
FROZEN list of clinical flags, each with an id and description. Read the patient's message and \
return the ids of the flags the message CLEARLY indicates. You may NOT invent flags or ids, \
and you do NOT decide any tier or urgency — you only report which of these exact flags are \
present. If none, return an empty list.

Return ONLY JSON: {"confirmed": ["R1","W2"]}"""


def _flag_index(protocol: dict) -> Dict[str, dict]:
    idx = {}
    for f in protocol.get("red", []):
        idx[f["id"]] = {**f, "kind": "red"}
    for f in protocol.get("watch", []):
        idx[f["id"]] = {**f, "kind": "watch"}
    return idx


def extract_flags(protocol: dict, answer: str) -> List[str]:
    """Model reads free text and reports which FROZEN flag ids are present (closed set).
    Falls back to substring matching on the authored phrases when no API key."""
    idx = _flag_index(protocol)
    catalog = "\n".join(f"{fid}: {f['label']}" for fid, f in idx.items())
    out = call_model_json(EXTRACT_SYSTEM, f"FROZEN FLAGS:\n{catalog}\n\nPATIENT: {answer}", 400)
    if out is not None:
        return [fid for fid in out.get("confirmed", []) if fid in idx]  # discard unknown ids
    text = (answer or "").lower()  # offline fallback
    return [fid for fid, f in idx.items()
            if any(s in text for s in f.get("patient_signals", []))]


def decide_tier(protocol: dict, confirmed_ids: List[str]) -> dict:
    """MOMENT 2 core: PURE, deterministic. Frozen flags -> tier. No model, no ambiguity."""
    idx = _flag_index(protocol)
    red = [idx[i] for i in confirmed_ids if idx.get(i, {}).get("kind") == "red"]
    watch = [idx[i] for i in confirmed_ids if idx.get(i, {}).get("kind") == "watch"]
    tier = "high" if red else "medium" if watch else "low"
    return {
        "tier": tier,
        "confirmed_red": [{"id": f["id"], "label": f["label"]} for f in red],
        "confirmed_watch": [{"id": f["id"], "label": f["label"]} for f in watch],
    }


def apply_protocol(protocol: dict, answer: str) -> dict:
    """Convenience: extract then decide."""
    confirmed = extract_flags(protocol, answer)
    result = decide_tier(protocol, confirmed)
    result["confirmed_ids"] = confirmed
    return result


# --------------------------------------------------------------------------- #
# Optional raise-only safety net
# --------------------------------------------------------------------------- #
REVIEW_SYSTEM = """You are a safety reviewer for a waiting-room monitor. A deterministic \
protocol already assigned a tier. You may only RAISE it if the patient's message describes \
something urgent that the protocol may not cover (e.g. airway, chest pain, fainting). \
You can never lower it.

Return ONLY JSON: {"proposed_tier":"low|medium|high","review_now":true|false,"reason":"<short>"}
If nothing urgent beyond the current tier, return the current tier and review_now false."""


def model_review(answer: str, rules_tier: str) -> dict:
    """Model may propose a HIGHER tier; caller takes max(rules, model)."""
    out = call_model_json(
        REVIEW_SYSTEM, f"Current tier: {rules_tier}\nPatient said: {answer}", max_tokens=400
    )
    if out is None:
        out = {"proposed_tier": rules_tier, "review_now": False, "reason": ""}
    out["final_tier"] = max_tier(rules_tier, out.get("proposed_tier", rules_tier))
    return out


# Fallback used only when no ANTHROPIC_API_KEY (keeps the demo runnable offline).
_SIMULATED_PROTOCOL: Dict = {
    "condition": "cellulitis",
    "red": [
        {"id": "R1", "label": "Pain out of proportion to exam",
         "patient_signals": ["worse than it looks", "hurts more than it looks",
                             "pain is a 9", "pain is a 10", "worst pain", "out of proportion"]},
        {"id": "R2", "label": "Dusky / bronze / black skin or bullae",
         "patient_signals": ["dark purple", "turning black", "going black", "dusky",
                             "bronze", "blister", "bulla"]},
        {"id": "R3", "label": "Red streaking up the limb",
         "patient_signals": ["red streak", "streak up", "streaking", "line going up"]},
        {"id": "R4", "label": "New fever / systemic toxicity",
         "patient_signals": ["fever", "high fever", "rigors", "confused", "about to pass out"]},
        {"id": "R5", "label": "Focal numbness over the area",
         "patient_signals": ["numb", "can't feel", "cant feel", "no feeling"]},
        {"id": "R6", "label": "Rapidly expanding erythema",
         "patient_signals": ["spreading fast", "much bigger fast", "in the last 20 minutes",
                             "spread quickly"]},
    ],
    "watch": [
        {"id": "W1", "label": "Redness spread past the marked landmark",
         "patient_signals": ["bigger than the line", "past the line", "past the mark",
                             "spread past", "bigger than the mark", "down to the ankle",
                             "up to my knee"]},
        {"id": "W2", "label": "Increased warmth",
         "patient_signals": ["warmer", "more warm", "hotter to touch"]},
        {"id": "W3", "label": "Mild pain increase",
         "patient_signals": ["pain is a 7", "pain is up", "more painful", "hurts more"]},
    ],
    "interval_question": "Is the redness bigger than the line we drew, and how bad is the pain now, 0 to 10?",
    "baseline_questions": [
        "How bad is the pain right now, 0 to 10?",
        "Where is the redness — can we mark a line around its edge?",
        "Do you have a fever, chills, blisters, or any numbness?",
    ],
}
