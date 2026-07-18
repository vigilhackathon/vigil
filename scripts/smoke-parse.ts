// scripts/smoke-parse.ts — burns the zod/SDK compat question in minute one of the build.
// Run: node --env-file=.env.local --import tsx scripts/smoke-parse.ts
// (bare `npx tsx` does NOT load .env.local). Node-package imports only — no @/* alias here.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4"; // MUST be zod/v4 — @anthropic-ai/sdk/helpers/zod imports 'zod/v4'
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const Hello = z.object({ greeting: z.string(), ok: z.boolean() });

async function main(): Promise<void> {
  const client = new Anthropic();
  const resp = await client.messages.parse(
    {
      model: "claude-sonnet-5",
      max_tokens: 256,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "Say a short hello and set ok to true." }],
      output_config: { format: zodOutputFormat(Hello) },
    },
    { timeout: 8_000, maxRetries: 0 }, // ms; ONE attempt
  );
  console.log("parsed_output:", resp.parsed_output);
  if (!resp.parsed_output) throw new Error("parsed_output was null");
  console.log("smoke-parse OK ✓");
}

main().catch((e) => {
  console.error("smoke-parse FAILED:", e);
  process.exit(1);
});
