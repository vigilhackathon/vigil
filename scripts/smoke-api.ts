// scripts/smoke-api.ts — VIG-10 gate. Chains the real routes vs a running server:
//   enroll → baseline → watch beat → escalate beat → state → ack → state, asserting shapes
//   and tiers at each step, plus negative cases. Non-zero exit on any failure.
//
// Run (server in another terminal via `npm run dev`):
//   node --env-file=.env.local --import tsx scripts/smoke-api.ts
//   BASE_URL=https://<deployed> node --import tsx scripts/smoke-api.ts   # at checkpoints
// Needs Supabase env (writes real rows) + ANTHROPIC_API_KEY (checkin phase runs the model;
// escalation is guardrail-deterministic, so tier assertions hold even if the model degrades).

import { createClient } from "@supabase/supabase-js";
import type { CheckinResponse } from "../lib/types";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const BOGUS_ID = "00000000-0000-0000-0000-000000000000";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  } else {
    console.log(`  ok:   ${name}`);
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  console.log(`smoke-api vs ${BASE}\n`);

  // 1. Enroll the hero from the mock EMR (identity confirm).
  const enroll = await post("/api/enroll", { name: "Ray Ortiz", dob: "1975-03-12" });
  check("enroll → 201", enroll.status === 201);
  const patientId = (enroll.json as { patientId?: string } | null)?.patientId;
  check("enroll returns patientId", typeof patientId === "string" && patientId.length > 0);
  if (!patientId) throw new Error("cannot continue without patientId");

  // 2. Baseline: answer all three baseline questions (routine, no flags).
  const baseline = await post("/api/checkin", {
    patientId,
    event: { type: "answers", answers: { b_pain: 5, b_landmark: "below_knee", b_screen: ["none"] } },
  });
  check("baseline → 200", baseline.status === 200);
  check("baseline tier routine", (baseline.json as CheckinResponse | null)?.tier === "routine");

  // 3. Watch beat: redness a little past the marked line (W_SPREAD) → watch.
  const watch = await post("/api/checkin", {
    patientId,
    event: { type: "answers", answers: { q_pain: 6, q_spread: "past" } },
  });
  check("watch beat → 200", watch.status === 200);
  check("watch beat tier watch", (watch.json as CheckinResponse | null)?.tier === "watch");

  // 4. Escalate beat: rapid spread + new fever (R_RAPID, R_FEVER) → escalate.
  const escalate = await post("/api/checkin", {
    patientId,
    event: { type: "answers", answers: { q_spread: "fast", q_fever: "yes" } },
  });
  check("escalate beat → 200", escalate.status === 200);
  const escBody = escalate.json as CheckinResponse | null;
  check("escalate beat tier escalate", escBody?.tier === "escalate");
  check("escalate trace has confirmed red flags", (escBody?.trace.confirmedFlags.length ?? 0) > 0);

  // 5. State before ack.
  const state1 = await get(`/api/state?patientId=${patientId}`);
  check("state → 200", state1.status === 200);
  const s1 = state1.json as { patient?: { tier?: string }; ackAt?: string | null } | null;
  check("state tier escalate", s1?.patient?.tier === "escalate");
  check("state not yet acked", s1?.ackAt == null);

  // 6. Acknowledge.
  const ack = await post("/api/ack", { patientId });
  check("ack → 200", ack.status === 200);
  check("ack ok", (ack.json as { ok?: boolean } | null)?.ok === true);

  // 7. State after ack.
  const state2 = await get(`/api/state?patientId=${patientId}`);
  check("state after ack has ackAt", (state2.json as { ackAt?: string | null } | null)?.ackAt != null);

  // 8. Negative cases.
  const noPatient = await post("/api/checkin", { patientId: BOGUS_ID, event: { type: "timer" } });
  check("checkin unknown patient → 404", noPatient.status === 404);
  const noEmr = await post("/api/enroll", { name: "Nobody Here", dob: "1900-01-01" });
  check("enroll unknown identity → 404", noEmr.status === 404);
  const badBody = await post("/api/enroll", { foo: "bar" });
  check("enroll bad body → 400", badBody.status === 400);

  // 9. Cleanup the seeded demo row (keeps the DB tidy across runs). Uses a direct service
  //    client rather than lib/supabase-server (whose `server-only` guard throws under tsx).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/rest\/v1\/?$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      await createClient(url, key, { auth: { persistSession: false } })
        .from("patients")
        .delete()
        .eq("id", patientId);
      console.log("  (cleaned up demo patient row)");
    } catch (e) {
      console.warn("  (cleanup skipped:", e instanceof Error ? e.message : e, ")");
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall smoke-api checks passed ✅");
}

main().catch((e) => {
  console.error("smoke-api FAILED:", e);
  process.exit(1);
});
