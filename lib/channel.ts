// lib/channel.ts — the outbound patient channel is a CONFIG VALUE, not an architecture.
// Demo ships "mock-web" (in-app thread; real carrier SMS is blocked on A2P verification).
// Flipping to real SMS/WhatsApp once A2P clears is a one-line env change, not a rebuild.

export type PatientChannel = "mock-web" | "sms" | "whatsapp";

const VALID: PatientChannel[] = ["mock-web", "sms", "whatsapp"];

export function patientChannel(): PatientChannel {
  const v = process.env.PATIENT_CHANNEL as PatientChannel | undefined;
  return v && VALID.includes(v) ? v : "mock-web";
}
