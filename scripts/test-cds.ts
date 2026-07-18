// scripts/test-cds.ts — VIG-6 protocol integrity gate (pure; no env, no network).
// Run: node --import tsx scripts/test-cds.ts   (relative import — @/* alias is bundler-only)
//
// Asserts the authored CdsProtocol is internally consistent so the guardrail can apply it:
// every chip option's flag id resolves to a red/watch label, cadence covers all tiers, etc.

import { MockCds } from "../lib/cds";
import type { CdsProtocol, Question } from "../lib/types";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  } else {
    console.log(`  ok:   ${name}`);
  }
}

function optionFlagIds(questions: Question[]): { red: Set<string>; watch: Set<string> } {
  const red = new Set<string>();
  const watch = new Set<string>();
  for (const q of questions) {
    if (q.kind === "chips") {
      for (const o of q.options) {
        (o.flags ?? []).forEach((f) => red.add(f));
        (o.watch ?? []).forEach((w) => watch.add(w));
      }
    }
  }
  return { red, watch };
}

const p: CdsProtocol = MockCds.author("cellulitis");

check("complaint is cellulitis", p.complaint === "cellulitis");
check("cadence has all three tiers", [p.cadenceMinutes.routine, p.cadenceMinutes.watch, p.cadenceMinutes.escalate].every((n) => typeof n === "number" && n >= 0));
check("baseline non-empty", p.baseline.length > 0);
check("bank non-empty", p.bank.length > 0);
check("red map non-empty", Object.keys(p.red).length > 0);
check("watch map non-empty", Object.keys(p.watch).length > 0);
check("hardPhrases non-empty", p.hardPhrases.length > 0);

// Every flag id referenced by a chip option must resolve to a label (no dangling ids).
const used = optionFlagIds([...p.baseline, ...p.bank]);
for (const f of used.red) check(`chip red flag '${f}' has a label`, f in p.red);
for (const w of used.watch) check(`chip watch flag '${w}' has a label`, w in p.watch);

// Aliases + unknown-complaint behavior.
check("alias 'leg redness' authors cellulitis", MockCds.author("leg redness").complaint === "cellulitis");
let threw = false;
try {
  MockCds.author("headache");
} catch {
  threw = true;
}
check("unknown complaint throws (no silent wrong protocol)", threw);

// author() returns a copy, not the frozen original (mutation safety).
const a = MockCds.author("cellulitis");
a.red.R_TEST = "x";
check("author returns a fresh copy", !("R_TEST" in MockCds.author("cellulitis").red));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall CDS integrity checks passed");
