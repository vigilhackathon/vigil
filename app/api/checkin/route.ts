// POST /api/checkin — the live patient event entrypoint. Thin: zod-validate, call the brain.
import { z } from "zod";
import { PatientNotFoundError, processCheckin } from "@/lib/checkin-service";
import type { ApiError, CheckinResponse } from "@/lib/types";

export const maxDuration = 30; // transitively calls Claude

const AnswerValue = z.union([z.string(), z.array(z.string()), z.number()]);

const EventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("answers"),
    answers: z.record(z.string(), AnswerValue),
    freeText: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal("sms_in"), body: z.string().min(1).max(1600) }),
  z.object({ type: z.literal("timer") }),
  z.object({
    type: z.literal("call_result"),
    transcript: z.string().optional(),
    structured: z.record(z.string(), z.string()).optional(),
  }),
]);

const BodySchema = z.object({
  patientId: z.string().uuid(),
  event: EventSchema,
});

export async function POST(req: Request): Promise<Response> {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return Response.json({ error: "invalid body" } satisfies ApiError, { status: 400 });
  }

  try {
    const result: CheckinResponse = await processCheckin(body.patientId, body.event);
    return Response.json(result);
  } catch (e) {
    if (e instanceof PatientNotFoundError) {
      return Response.json({ error: "patient not found" } satisfies ApiError, { status: 404 });
    }
    console.error("[/api/checkin]", e);
    return Response.json({ error: "check-in failed" } satisfies ApiError, { status: 500 });
  }
}
