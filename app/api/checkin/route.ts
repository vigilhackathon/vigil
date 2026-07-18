// POST /api/checkin — VIG-10: the canonical check-in entry point.
//
// Thin HTTP wrapper over lib/checkin-service.processCheckin (THE one brain). Every channel
// funnels here: the mock web thread (VIG-11), the demo driver, and the smoke test. No route
// ever fetches another route — they all import the service.
// maxDuration=30 because processCheckin transitively calls Claude (the §2 model funnel).

import { z } from "zod";
import { PatientNotFoundError, processCheckin } from "../../../lib/checkin-service";
import type { ApiError, CheckinEvent } from "../../../lib/types";

export const maxDuration = 30;

const AnswerValue = z.union([z.string(), z.array(z.string()), z.number()]);

const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answers"), answers: z.record(z.string(), AnswerValue), freeText: z.string().optional() }),
  z.object({ type: z.literal("sms_in"), body: z.string() }),
  z.object({ type: z.literal("timer") }),
  z.object({ type: z.literal("call_result"), transcript: z.string().optional(), structured: z.record(z.string(), z.string()).optional() }),
]);

const Body = z.object({ patientId: z.string().min(1), event: Event });

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
    return err("body must be { patientId, event: CheckinEvent }", 400);
  }

  try {
    const response = await processCheckin(parsed.data.patientId, parsed.data.event as CheckinEvent);
    return Response.json(response, { status: 200 });
  } catch (e) {
    if (e instanceof PatientNotFoundError) return err("patient not found", 404);
    return err(`check-in failed: ${e instanceof Error ? e.message : "unknown"}`, 500);
  }
}
