// lib/emr.ts — VIG-10: the mock FHIR EMR adapter.
//
// Stands in for the hospital EMR: a seeded fake FHIR patient list (Patient + Condition/triage
// note + observations, flattened into FhirPatient). Enroll looks a patient up here by
// identity (name + DOB) or by token (the FHIR id a QR would carry), pulls their intake, and
// hands the complaint to MockCds.author to build the monitoring protocol.
//
// Generalizable: any patient in the list can enroll — not just the demo hero. v1 seeds
// cellulitis presentations because MockCds.author only authors cellulitis today.
//
// Pure, in-memory, no I/O — safe to import from routes or scripts.

import type { FhirPatient } from "./types";

// Seeded fake FHIR patients. `id` is the token a QR would carry (FhirPatient.id).
const SEED: FhirPatient[] = [
  {
    id: "fhir-ray-ortiz",
    name: "Ray Ortiz",
    dob: "1975-03-12", // ~50y
    age: 50,
    sex: "male",
    phone: "+15551230001",
    complaint: "cellulitis",
    esi: 3,
    triageNote:
      "50M, PMH hypertension + poorly-controlled type 2 diabetes. Redness and warmth of the " +
      "right lower leg, started a few hours ago, pain 5/10. Ambulatory, afebrile at triage. " +
      "Marked the border of the erythema.",
  },
  {
    id: "fhir-donna-webb",
    name: "Donna Webb",
    dob: "1962-09-30", // ~63y
    age: 63,
    sex: "female",
    phone: "+15551230002",
    complaint: "cellulitis",
    esi: 4,
    triageNote:
      "63F, PMH venous stasis. Left shin redness and swelling x2 days, mild tenderness, pain " +
      "3/10. No fever. Query cellulitis vs stasis dermatitis. Border marked.",
  },
  {
    id: "fhir-marcus-lee",
    name: "Marcus Lee",
    dob: "1990-11-05", // ~35y
    age: 35,
    sex: "male",
    phone: "+15551230003",
    complaint: "skin infection", // aliases to cellulitis in MockCds
    esi: 3,
    triageNote:
      "35M, IV drug use history. Right forearm redness, warmth, and a small area of induration " +
      "around an injection site, pain 6/10. Afebrile. Border marked.",
  },
];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** All seeded patients (for demo seeding / an enroll picker). */
export function listPatients(): FhirPatient[] {
  return SEED.map((p) => ({ ...p }));
}

/** Identity-confirm lookup: exact name (case-insensitive) + DOB (ISO date). */
export function lookup(name: string, dob: string): FhirPatient | null {
  const n = norm(name);
  const d = norm(dob);
  const hit = SEED.find((p) => norm(p.name) === n && norm(p.dob) === d);
  return hit ? { ...hit } : null;
}

/** Token lookup: the FHIR id a QR code would carry. */
export function getById(id: string): FhirPatient | null {
  const hit = SEED.find((p) => p.id === id);
  return hit ? { ...hit } : null;
}
