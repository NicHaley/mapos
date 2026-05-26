import { z } from "zod";

/**
 * Stable error codes the MapOS server returns in its JSON error envelope. Clients
 * (e.g. the `mapos_v1` adapter) switch on `code` to surface appropriate UI —
 * "upstream provider down" reads very differently from "you sent bad input".
 *
 * Additions are backwards-compatible; removals or renames are breaking and need a
 * server version bump.
 */
export const ErrorCodeSchema = z.enum([
  /** Request body or query string failed schema validation. */
  "validation_failed",
  /** Upstream provider returned a non-2xx response. */
  "upstream_error",
  /** Upstream provider returned 2xx but the body didn't match the adapter's schema. */
  "upstream_invalid_response",
  /** Server is missing required configuration (e.g. an API key env var). */
  "server_misconfigured",
  /** Caller exceeded a rate limit. Reserved for the auth era. */
  "rate_limited",
  /** No / invalid auth token. Reserved for the auth era. */
  "unauthorized",
  /** Token is valid but lacks the tier or entitlement for this route. Reserved for the auth era. */
  "forbidden",
  /** Caller's subscription is inactive (past-due, cancelled, etc). Reserved for the auth era. */
  "subscription_required",
  /** Catch-all for unhandled server faults. */
  "internal_error",
  /** Route doesn't exist. */
  "not_found"
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorDetailSchema = z.object({
  /** Dotted path into the request body, or `<root>` for top-level failures. */
  path: z.string(),
  /** Human-readable description of the issue. */
  issue: z.string()
});
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** Populated for `validation_failed`; up to N entries from the underlying ZodError. */
    details: z.array(ErrorDetailSchema).optional()
  })
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
