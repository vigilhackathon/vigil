// POST /api/call-result — ElevenLabs post-call webhook (VIG-16 / PR11).
// Verifies the HMAC signature, extracts the agent's structured data-collection + transcript,
// maps confirmations deterministically (lib/voice-call), and feeds a `call_result` event back
// through the one brain so the guardrail re-tiers. The call GATHERS; the guardrail disposes.
import crypto from "node:crypto";
import { PatientNotFoundError, processCheckin } from "@/lib/checkin-service";
import { parseCallResult, type CallDataCollection } from "@/lib/voice-call";
import { supabaseServer } from "@/lib/supabase-server";
import { MockCds } from "@/lib/cds";
import type { ApiError, CdsProtocol } from "@/lib/types";

export const maxDuration = 30; // transitively calls the model via processCheckin

interface ELWebhook {
  type?: string;
  data?: {
    conversation_id?: string;
    transcript?: Array<{ role?: string; message?: string | null }>;
    analysis?: { data_collection_results?: Record<string, unknown> };
    conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
  };
}

function verifySignature(secret: string, header: string | null, rawBody: string): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = parts.t;
  const v0 = parts.v0;
  if (!t || !v0) return false;
  const mac = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(v0));
  } catch {
    return false;
  }
}

/** Unwrap a data-collection result cell ({value, rationale} or a bare value). */
function cellValue(cell: unknown): unknown {
  if (cell && typeof cell === "object" && "value" in cell) return (cell as { value?: unknown }).value;
  return cell;
}
const asStr = (v: unknown): string | null => (v == null ? null : String(v));

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();

  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (secret && !verifySignature(secret, req.headers.get("elevenlabs-signature"), raw)) {
    // Demo-lenient: log and continue (synthetic data). In production: `return 401`.
    console.warn("[/api/call-result] HMAC verification failed — processing anyway (demo)");
  }

  let payload: ELWebhook;
  try {
    payload = JSON.parse(raw) as ELWebhook;
  } catch {
    return Response.json({ error: "invalid json" } satisfies ApiError, { status: 400 });
  }

  if (payload.type && payload.type !== "post_call_transcription") {
    return Response.json({ ok: true, ignored: payload.type });
  }
  const data = payload.data;
  const patientId = asStr(data?.conversation_initiation_client_data?.dynamic_variables?.patient_id);
  if (!patientId) {
    console.warn("[/api/call-result] no patient_id in dynamic_variables — ignoring");
    return Response.json({ ok: true, ignored: "no patient_id" });
  }

  const transcript = (data?.transcript ?? [])
    .map((t) => `${t.role ?? "?"}: ${t.message ?? ""}`)
    .filter((l) => l.trim().length > 3)
    .join("\n");

  const dcr = data?.analysis?.data_collection_results ?? {};
  const dc: CallDataCollection = {
    confirmed_findings: asStr(cellValue(dcr.confirmed_findings)),
    denied_findings: asStr(cellValue(dcr.denied_findings)),
    patient_summary: asStr(cellValue(dcr.patient_summary)),
    severity_0_10: asStr(cellValue(dcr.severity_0_10)),
    sounds_worse: Boolean(cellValue(dcr.sounds_worse)),
  };

  try {
    const db = supabaseServer();
    const { data: p } = await db
      .from("patients")
      .select("protocol, complaint")
      .eq("id", patientId)
      .maybeSingle();
    if (!p) {
      console.warn(`[/api/call-result] patient ${patientId} not found — ignoring`);
      return Response.json({ ok: true, ignored: "patient not found" });
    }
    const row = p as { protocol: CdsProtocol | null; complaint: string | null };
    const protocol = row.protocol ?? MockCds.author(row.complaint ?? "cellulitis");
    const { structured } = parseCallResult(protocol, dc);

    await processCheckin(patientId, { type: "call_result", transcript, structured });
    return Response.json({ ok: true, mapped: Object.keys(structured) });
  } catch (e) {
    // Always 200 so ElevenLabs doesn't disable the webhook; the check-in is best-effort.
    if (!(e instanceof PatientNotFoundError)) console.error("[/api/call-result]", e);
    return Response.json({ ok: false });
  }
}
