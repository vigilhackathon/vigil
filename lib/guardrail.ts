// lib/guardrail.ts — VIGIL deterministic guardrail (the floor the model can never override).
//
// PURE: no I/O, no supabase, no SDK, no Date/randomness. Every function here is a
// referentially-transparent transform so `scripts/test-guardrail.ts` can exercise it in
// milliseconds with no env. The (mock) CDS AUTHORS the flag→tier map per visit (lib/cds.ts,
// PR1); this module APPLIES it deterministically. See PLAN.md §6 (tier rules) and CLAUDE.md
// (safety invariants) — do not weaken any invariant without adding a test case.
//
// Safety invariants enforced here:
//   1. tier_final = max(rulesTier, validatedModelTier)         — model can never lower the floor.
//   2. Model "escalate" without a structurally-confirmed flag ⇒ watch + review_now.
//   3. Hard-phrase hits escalate regardless of model output (incl. when the model call failed).
//   4. Escalation-grade flags come ONLY from structured answers (chips/scale) or hard phrases —
//      never free-text interpretation alone.
//   5. All model-supplied ids are validated: unknown flag ids are discarded + logged;
//      next_question_id must exist in the bank else deterministic next-unanswered.
//   7. De-escalation (watch→routine) only after stable_cycles ≥ 2.
//   Escalate is STICKY in v1 (no auto-downgrade; exit is nurse re-triage).

import type {
  CdsProtocol,
  CheckinResult,
  Question,
  Tier,
} from "./types";

export type AnswerValue = string | string[] | number;
export type AnswerMap = Record<string, AnswerValue>;

const TIER_RANK: Record<Tier, number> = { routine: 0, watch: 1, escalate: 2 };

/** The higher (more urgent) of two tiers. Ties return `a`. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Flag derivation — ONLY structured chip/scale answers produce flags (invariant 4).
// ---------------------------------------------------------------------------

/** All questions authored in this protocol (baseline + bank), indexed helper. */
function allQuestions(protocol: CdsProtocol): Question[] {
  return [...protocol.baseline, ...protocol.bank];
}

function selectedValues(value: AnswerValue | undefined): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/**
 * Map confirmed structured answers to the flag ids the chosen options carry, split into
 * red (escalate-grade) and watch (watch-grade). Free text is intentionally NOT read here —
 * only enumerated chip/scale options can confirm a flag (invariant 4). Flag ids that the
 * option cites but the protocol never enumerated are discarded (invariant 5).
 */
export function confirmedFlagsFromAnswers(
  protocol: CdsProtocol,
  answers: AnswerMap,
): { red: string[]; watch: string[] } {
  const red = new Set<string>();
  const watch = new Set<string>();

  for (const q of allQuestions(protocol)) {
    if (q.kind !== "chips") continue; // only chip options carry flag ids
    const chosen = selectedValues(answers[q.id]);
    if (chosen.length === 0) continue;
    for (const opt of q.options) {
      if (!chosen.includes(opt.value)) continue;
      for (const id of opt.flags ?? []) {
        if (id in protocol.red) red.add(id);
      }
      for (const id of opt.watch ?? []) {
        if (id in protocol.watch) watch.add(id);
      }
    }
  }

  return { red: [...red], watch: [...watch] };
}

/**
 * Deterministic hard-phrase detection over free text / inbound SMS / voice transcript.
 * Case-insensitive substring match against the protocol's authored hardPhrases. A hit
 * escalates on its own (invariant 3) — this is the ONLY way free text touches the tier.
 */
export function hardPhraseHits(protocol: CdsProtocol, text?: string): string[] {
  if (!text) return [];
  const haystack = text.toLowerCase();
  return protocol.hardPhrases.filter((p) => haystack.includes(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Rules tier — the deterministic floor from PLAN §6.
// ---------------------------------------------------------------------------

export interface RulesInput {
  confirmedRed: string[];
  confirmedWatch: string[];
  hardPhraseHits: string[];
  severityBaseline: number | null;
  severityCurrent: number | null;
}

/** Δ severity anchored to THIS patient's baseline (0 when either value is unknown). */
export function severityDelta(baseline: number | null, current: number | null): number {
  if (baseline == null || current == null) return 0;
  return current - baseline;
}

/**
 * Rules-only tier from confirmed evidence. Escalate: any confirmed RED flag · any hard-phrase
 * hit · Δ≥3 from baseline · sustained ≥8 with Δ≥2. Watch: any confirmed WATCH flag · Δ≥2.
 * Otherwise routine. (Model contributions are handled in validateModel + evaluate.)
 */
export function rulesTier(input: RulesInput): Tier {
  const delta = severityDelta(input.severityBaseline, input.severityCurrent);
  const sev = input.severityCurrent;

  const escalate =
    input.confirmedRed.length > 0 ||
    input.hardPhraseHits.length > 0 ||
    delta >= 3 ||
    (sev != null && sev >= 8 && delta >= 2);
  if (escalate) return "escalate";

  const watch = input.confirmedWatch.length > 0 || delta >= 2;
  if (watch) return "watch";

  return "routine";
}

// ---------------------------------------------------------------------------
// Model validation — clamp the model's proposal against the deterministic evidence.
// ---------------------------------------------------------------------------

export interface ModelValidation {
  /** Model tier after clamping (escalate-without-confirmed-flag→watch; conf<0.6→≥watch). */
  validatedTier: Tier;
  /** True when the model proposed escalate with no confirmed red flag (invariant 2). */
  reviewNow: boolean;
  /** Cited flag ids discarded because unknown to the protocol or not structurally confirmed. */
  discardedFlags: string[];
}

/**
 * Validate the model's proposal. The model may RAISE the floor (routine→watch) but never lower
 * it (the actual max() happens in evaluate). It can never escalate on its own say-so: an
 * escalate proposal without a confirmed red flag becomes watch + review_now (invariant 2).
 * Low confidence (<0.6) pins the floor to at least watch. `null` model = degraded mode: the
 * model contributes nothing (routine) and rules/hard-phrases still stand (invariant 3).
 */
export function validateModel(
  model: CheckinResult | null,
  protocol: CdsProtocol,
  confirmedRed: string[],
): ModelValidation {
  if (model == null) {
    return { validatedTier: "routine", reviewNow: false, discardedFlags: [] };
  }

  // Invariant 5: discard cited ids the protocol never enumerated OR that were not
  // structurally confirmed this turn. The model can only cite; it cannot conjure a flag.
  const known = (id: string) => id in protocol.red || id in protocol.watch;
  const confirmed = new Set(confirmedRed);
  const discardedFlags = model.flag_ids_cited.filter(
    (id) => !known(id) || !confirmed.has(id),
  );

  let validatedTier: Tier = model.tier_proposed;
  let reviewNow = false;

  // Invariant 2: escalate is only legitimate when a red flag is structurally confirmed.
  if (validatedTier === "escalate" && confirmedRed.length === 0) {
    validatedTier = "watch";
    reviewNow = true;
  }

  // Uncertain model → at least watch so a human eyeballs it (PLAN §6 watch-min).
  if (model.confidence < 0.6) {
    validatedTier = maxTier(validatedTier, "watch");
  }

  return { validatedTier, reviewNow, discardedFlags };
}

// ---------------------------------------------------------------------------
// stable_cycles hysteresis — de-escalation is earned, not automatic (invariant 7).
// ---------------------------------------------------------------------------

/**
 * A cycle is "stable" when this event introduced zero new triggers (no confirmed flags, no
 * hard-phrase) AND severity has not risen ≥2 over baseline. Stable ⇒ +1; any trigger ⇒ reset 0.
 */
export function nextStableCycles(
  prev: number,
  triggered: boolean,
  delta: number,
): number {
  const stable = !triggered && delta < 2;
  return stable ? prev + 1 : 0;
}

// ---------------------------------------------------------------------------
// Next-question validation (invariant 5).
// ---------------------------------------------------------------------------

export interface NextQuestion {
  id: string | null;
  /** True when the model's proposed id was rejected and a deterministic one substituted. */
  substituted: boolean;
}

/**
 * The model's next_question_id must exist in the bank (or be the literal "CUSTOM", which pairs
 * with custom_question). Anything else is rejected and replaced with the first unanswered bank
 * question (deterministic next-unanswered), or null when every bank question is answered.
 */
export function validateNextQuestionId(
  protocol: CdsProtocol,
  proposedId: string | null | undefined,
  answeredIds: string[],
): NextQuestion {
  const bankIds = new Set(protocol.bank.map((q) => q.id));
  if (proposedId === "CUSTOM") return { id: "CUSTOM", substituted: false };
  if (proposedId && bankIds.has(proposedId)) {
    return { id: proposedId, substituted: false };
  }
  const answered = new Set(answeredIds);
  const nextUnanswered = protocol.bank.find((q) => !answered.has(q.id));
  return { id: nextUnanswered?.id ?? null, substituted: true };
}

// ---------------------------------------------------------------------------
// Deterministic yes/no parse — turns a free-text / voice confirmation into a structured
// answer so escalation stays deterministic (invariant 4: free text never escalates alone;
// it routes to a yes/no confirm that parses HERE, not in the model).
// ---------------------------------------------------------------------------

const AFFIRMATIVE = [
  "yes", "yeah", "yep", "yup", "ya", "correct", "affirmative",
  "i do", "i am", "i have", "definitely", "for sure", "true",
];
const NEGATIVE = [
  "no", "nope", "nah", "none", "negative", "not really",
  "i don't", "i dont", "i do not", "i haven't", "i havent", "false",
];

/** Normalize a short confirmation reply to yes/no, or null if ambiguous (ask again). */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/g, "");
  if (t === "y") return "yes";
  if (t === "n") return "no";
  const hasWord = (list: string[]) =>
    list.some((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(t));
  const yes = hasWord(AFFIRMATIVE);
  const no = hasWord(NEGATIVE);
  if (yes && !no) return "yes";
  if (no && !yes) return "no";
  return null; // empty, ambiguous, or contradictory → not a confirmation
}

// ---------------------------------------------------------------------------
// Alert dedup policy (pure) — consumed by lib/notifier.ts (PR7). One patient can never
// machine-gun the nurse: a repeat of the same flag category updates the existing alert;
// only a NEW distinct category breaks through.
// ---------------------------------------------------------------------------

/** Canonical dedup key for an escalation's reason (sorted red flags, + hardphrase marker). */
export function alertCategory(confirmedRed: string[], phraseHits: string[]): string {
  const parts = [...confirmedRed].sort();
  if (phraseHits.length > 0) parts.push("hardphrase");
  return parts.join("+");
}

/** True ⇒ fire a NEW page; false ⇒ update the existing alert ("2nd report"). */
export function shouldPushAlert(category: string, pushedCategories: string[]): boolean {
  return category.length > 0 && !pushedCategories.includes(category);
}

// ---------------------------------------------------------------------------
// evaluate — the orchestrator the checkin-service (PR4) calls each turn.
// ---------------------------------------------------------------------------

export interface GuardrailInput {
  protocol: CdsProtocol;
  /** This event's structured answers (baseline accumulates upstream; bank is per-turn). */
  answers?: AnswerMap;
  /** Inbound free text / SMS body / voice transcript — hard-phrase scan only. */
  freeText?: string;
  severityBaseline: number | null;
  severityCurrent: number | null;
  /** Model output, or null in degraded mode (parse failure / refusal / max_tokens). */
  model: CheckinResult | null;
  /** Prior persisted tier — powers escalate-stickiness + watch hysteresis. */
  priorTier: Tier;
  /** Prior stable_cycles count. */
  priorStableCycles: number;
}

export interface GuardrailDecision {
  confirmedRed: string[];
  confirmedWatch: string[];
  confirmedFlags: string[]; // red ∪ watch — for CheckinTrace.confirmedFlags
  hardPhraseHits: string[];
  discardedFlags: string[]; // logged, never actioned
  rulesTier: Tier;
  validatedModelTier: Tier;
  modelTierProposed: Tier | null;
  tierFinal: Tier;
  reviewNow: boolean;
  escalateToCall: boolean;
  stableCycles: number;
  cadenceMinutes: number;
}

/**
 * Fold all rules together into one decision. Order matters:
 *   rules ∨ model → sticky-escalate → hysteresis de-escalation → cadence.
 */
export function evaluate(input: GuardrailInput): GuardrailDecision {
  const { protocol, model } = input;
  const answers = input.answers ?? {};

  const { red: confirmedRed, watch: confirmedWatch } = confirmedFlagsFromAnswers(
    protocol,
    answers,
  );
  const phraseHits = hardPhraseHits(protocol, input.freeText);

  const rules = rulesTier({
    confirmedRed,
    confirmedWatch,
    hardPhraseHits: phraseHits,
    severityBaseline: input.severityBaseline,
    severityCurrent: input.severityCurrent,
  });

  const mv = validateModel(model, protocol, confirmedRed);

  // Invariant 1: the floor. Model can raise, never lower.
  const raw = maxTier(rules, mv.validatedTier);

  const delta = severityDelta(input.severityBaseline, input.severityCurrent);
  const triggered =
    confirmedRed.length > 0 || confirmedWatch.length > 0 || phraseHits.length > 0;
  const stableCycles = nextStableCycles(input.priorStableCycles, triggered, delta);

  // Escalate is sticky; watch de-escalates to routine only after ≥2 stable cycles.
  let tierFinal: Tier;
  if (input.priorTier === "escalate") {
    tierFinal = "escalate";
  } else if (input.priorTier === "watch") {
    if (raw === "escalate") tierFinal = "escalate";
    else if (raw === "watch") tierFinal = "watch";
    else tierFinal = stableCycles >= 2 ? "routine" : "watch"; // hysteresis hold
  } else {
    tierFinal = raw;
  }

  const confirmedFlags = [...new Set([...confirmedRed, ...confirmedWatch])];

  return {
    confirmedRed,
    confirmedWatch,
    confirmedFlags,
    hardPhraseHits: phraseHits,
    discardedFlags: mv.discardedFlags,
    rulesTier: rules,
    validatedModelTier: mv.validatedTier,
    modelTierProposed: model?.tier_proposed ?? null,
    tierFinal,
    reviewNow: mv.reviewNow,
    escalateToCall: model?.escalate_to_call ?? false,
    stableCycles,
    cadenceMinutes: protocol.cadenceMinutes[tierFinal],
  };
}
