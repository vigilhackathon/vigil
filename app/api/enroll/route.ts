// POST /api/enroll — VIG-10: enroll a waiting-room patient from the mock FHIR EMR.
//
// Flow: identity confirm (name + DOB) or QR token (fhirId) → EMR lookup → author the per-visit
// monitoring protocol (MockCds, frozen at intake) → INSERT the patient row → return { patientId }.
// This is the FIRST patient-creation path; check-ins thereafter go through /api/checkin.
// Channel is "sms" (production is real SMS; the demo mocks delivery as an in-app web thread).

import { z } from "zod";
import { MockCds } from "../../../lib/cds";
import { getById, lookup } from "../../../lib/emr";
import { supabaseServer } from "../../../lib/supabase-server";
import type { ApiError, Baseline, CdsProtocol } from "../../../lib/types";

const Body = z.union([
  z.object({ fhirId: z.string().min(1) }),
  z.object({ name: z.string().min(1), dob: z.string().min(1) }),
]);

function err(error: string, status: number): Response {
  return Response.json({ error } satisfies ApiError, { status });
}

export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return err("invalid JSON body", 400);
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return err("body must be { fhirId } or { name, dob }", 400);
  }

  // Resolve the patient in the fake FHIR list.
  const fhir =
    "fhirId" in parsed.data
      ? getById(parsed.data.fhirId)
      : lookup(parsed.data.name, parsed.data.dob);
  if (!fhir) {
    return err("patient not found in EMR", 404);
  }

  // Author + freeze the monitoring protocol at intake (rejects unsupported complaints).
  let protocol: CdsProtocol;
  try {
    protocol = MockCds.author(fhir.complaint);
  } catch {
    return err(`no monitoring protocol for complaint "${fhir.complaint}"`, 422);
  }

  const baseline: Baseline = { complete: false, answers: {}, severityBaseline: 0 };

  const db = supabaseServer();
  const { data, error } = await db
    .from("patients")
    .insert({
      name: fhir.name,
      dob: fhir.dob,
      age: fhir.age,
      sex: fhir.sex,
      phone: fhir.phone ?? null,
      complaint: fhir.complaint,
      esi: fhir.esi,
      channel: "sms",
      protocol,
      baseline,
      is_demo_seed: true,
    })
    .select("id")
    .single();

  if (error || !data) {
    return err(`enroll failed: ${error?.message ?? "no row returned"}`, 500);
  }

  return Response.json({ patientId: data.id as string }, { status: 201 });
}
