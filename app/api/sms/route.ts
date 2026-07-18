// POST /api/sms — Twilio inbound-SMS webhook.
// PR0 STUB: proves the endpoint is reachable so VIG-17 can point Twilio's webhook here.
// Real handler (VIG-11): validate X-Twilio-Signature, parse From/To/Body, call checkin-service,
// return an empty TwiML 200 and send the reply via the outbound API (Claude may take a few seconds).

export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  let body = "";
  try {
    const form = await req.formData();
    body = String(form.get("Body") ?? "");
  } catch {
    // Non-form POST (e.g. a plain curl) — fine for the stub.
  }

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Message>VIGIL is reachable${body ? ` — you said: ${body}` : ""}.</Message></Response>`;

  return new Response(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
