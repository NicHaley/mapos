import type { Context } from "hono";
import type { z } from "zod";
import { errorResponse, handleAdapterError, zodIssuesToDetails } from "./errors";

/**
 * Shared shape for every POST/JSON contract endpoint:
 *   1. Parse request body as JSON.
 *   2. `safeParse` against the inbound contract schema; 400 on failure.
 *   3. Invoke the adapter via `run`, plumbing the request signal so client
 *      disconnects propagate to upstream fetches.
 *   4. `safeParse` the adapter's output against the outbound contract — a
 *      mismatch is a server-side regression (adapter drift), surfaced as 500
 *      rather than letting bad data reach the client.
 *
 * The inbound + outbound parse pair mirrors what the dashboard's IPC layer does,
 * so the same contracts govern both transport boundaries identically.
 */
export async function handleContractPost<Req, Res>(
  c: Context,
  reqSchema: z.ZodType<Req>,
  resSchema: z.ZodType<Res>,
  run: (req: Req, signal?: AbortSignal) => Promise<Res>
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, "validation_failed", "request body is not valid JSON");
  }
  const parsed = reqSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      c,
      "validation_failed",
      "request failed schema validation",
      zodIssuesToDetails(parsed.error)
    );
  }
  try {
    const result = await run(parsed.data, c.req.raw.signal);
    const out = resSchema.safeParse(result);
    if (!out.success) {
      console.error("[mapos-api] outbound schema validation failed", out.error.issues);
      return errorResponse(
        c,
        "internal_error",
        "server produced a response that failed contract validation",
        zodIssuesToDetails(out.error)
      );
    }
    return c.json(out.data);
  } catch (err) {
    return handleAdapterError(c, err);
  }
}
