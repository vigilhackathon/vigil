"""VIGIL CDS — shared plumbing: reference loading, triage-note routing, model client.

The clinical reasoning lives in cds.py. This module only:
  - loads the verbatim clinical references (resources/*.txt),
  - routes an ER triage note to the right reference file (non-clinical keyword match),
  - provides a dependency-free Anthropic client (stdlib urllib).

Pure stdlib; ports directly to a TS lib/ module.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

RESOURCE_DIR = Path(__file__).parent / "resources"

MODEL = "claude-opus-4-8"

# Operational cadence per tier (minutes; 0 = escalate now). The clinician's buckets.
TIER_CADENCE = {"low": 30, "medium": 15, "high": 0}
TIER_ORDER = {"low": 0, "medium": 1, "high": 2}


def action_for(tier: str) -> str:
    mins = TIER_CADENCE.get(tier)
    if mins == 0:
        return "escalate to a clinician now"
    return f"recheck in {mins} minutes"


def max_tier(a: str, b: str) -> str:
    return a if TIER_ORDER.get(a, 0) >= TIER_ORDER.get(b, 0) else b


# --------------------------------------------------------------------------- #
# References + routing
# --------------------------------------------------------------------------- #
# Routing ONLY (non-clinical): which reference file matches a triage note.
ROUTING_ALIASES: Dict[str, List[str]] = {
    "cellulitis": [
        "cellulitis", "erysipelas", "redness", "red leg", "red skin",
        "skin infection", "warm swollen", "red streak", "wound infection",
    ],
    "abdominal_pain": [
        "abdominal pain", "abdominal", "belly pain", "stomach pain", "abd pain",
        "epigastric", "rlq", "luq", "peritonitis",
    ],
    "fever": [
        "fever", "febrile", "high temperature", "chills", "rigors", "pyrexia",
    ],
    "back_pain": [
        "back pain", "low back", "lumbar", "sciatica", "cauda equina",
        "thoracic pain", "flank pain",
    ],
}


def load_references() -> Dict[str, str]:
    refs: Dict[str, str] = {}
    for path in sorted(RESOURCE_DIR.glob("*.txt")):
        refs[path.stem] = path.read_text()
    return refs


def match_condition(query: str, refs: Dict[str, str]) -> Optional[str]:
    q = (query or "").lower()
    for cid in refs:
        if cid in q:
            return cid
    for cid, aliases in ROUTING_ALIASES.items():
        if cid in refs and any(a in q for a in aliases):
            return cid
    return None


ROUTE_SYSTEM = """Pick the single best-matching condition id for an ED patient's CHIEF \
complaint. Base it on the PRIMARY presenting complaint, not associated symptoms — e.g. a \
patient with abdominal pain who also has a fever is 'abdominal_pain', not 'fever'; route to \
'fever' only when a febrile illness IS the chief complaint. Return ONLY JSON: \
{"condition":"<id>"} or {"condition":null} if none fit."""


def route_condition(query: str, refs: Optional[Dict[str, str]] = None) -> Optional[str]:
    """Route a triage note to a condition id. Model-based (chief-complaint aware) with a
    keyword fallback for offline use."""
    refs = refs or load_references()
    ids = list(refs)
    out = call_model_json(ROUTE_SYSTEM, f"Condition ids: {ids}\n\nTriage note: {query}", 120)
    if out and out.get("condition") in refs:
        return out["condition"]
    return match_condition(query, refs)  # offline keyword fallback (best-effort)


def get_condition_reference(query: str) -> Optional[tuple]:
    """Route a triage note to (condition_id, full_reference_text), or None."""
    refs = load_references()
    cid = route_condition(query, refs)
    return (cid, refs[cid]) if cid else None


# --------------------------------------------------------------------------- #
# Model client (stdlib)
# --------------------------------------------------------------------------- #
def call_model(system: str, user: str, max_tokens: int = 1800) -> Optional[str]:
    """Single-turn Messages API call. Returns raw text, or None on any failure."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    body = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            payload = json.loads(resp.read())
        return "".join(b.get("text", "") for b in payload.get("content", []))
    except Exception as exc:
        print(f"   (model call failed: {exc})")
        return None


def call_model_json(system: str, user: str, max_tokens: int = 1800) -> Optional[dict]:
    text = call_model(system, user, max_tokens)
    if text is None:
        return None
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
