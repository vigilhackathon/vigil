// POST /api/handoff {patientId} → {markdown} — the SBAR interval report for the EMR
// patient record tab. Deterministic template always; Claude upgrade when it lands in time.
import { z } from "zod";
import { PatientNotFoundError } from "@/lib/checkin-service";
import { generateHandoff } from "@/lib/handoff";
import type { ApiError } from "@/lib/types";

export const maxDuration = 30; // Claude upgrade path (30s timeout, one attempt)

const BodySchema = z.object({ patientId: z.string().uuid() });

export async function POST(req: Request): Promise<Response> {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid body" } satisfies ApiError, { status: 400 });
  }

  try {
    const { markdown, upgraded } = await generateHandoff(body.patientId);
    return Response.json({ markdown, upgraded });
  } catch (e) {
    if (e instanceof PatientNotFoundError) {
      return Response.json({ error: "patient not found" } satisfies ApiError, { status: 404 });
    }
    console.error("[/api/handoff]", e);
    return Response.json({ error: "handoff failed" } satisfies ApiError, { status: 500 });
  }
}
