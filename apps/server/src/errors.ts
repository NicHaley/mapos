import type { ErrorCode, ErrorResponse } from "@mapos/contracts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/**
 * Server-side helpers for producing the `ErrorResponse` envelope defined in
 * `@mapos/contracts`. Every error path through the API should go through one of
 * these so the wire format stays consistent.
 */

const STATUS_FOR_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  validation_failed: 400,
  upstream_error: 502,
  upstream_invalid_response: 502,
  server_misconfigured: 500,
  rate_limited: 429,
  unauthorized: 401,
  forbidden: 403,
  subscription_required: 402,
  internal_error: 500,
  not_found: 404
};

function envelope(
  code: ErrorCode,
  message: string,
  details?: ErrorResponse["error"]["details"]
): ErrorResponse {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export function errorResponse(
  c: Context,
  code: ErrorCode,
  message: string,
  details?: ErrorResponse["error"]["details"]
): Response {
  return c.json(envelope(code, message, details), STATUS_FOR_CODE[code]);
}

export function zodIssuesToDetails(err: z.ZodError): ErrorResponse["error"]["details"] {
  return err.issues.slice(0, 10).map((i) => ({
    path: i.path.join(".") || "<root>",
    issue: i.message
  }));
}

/**
 * Maps thrown errors from adapter calls onto the wire envelope. The adapters
 * raise `MapServiceError` (upstream non-2xx) and `MapServiceValidationError`
 * (upstream returned malformed JSON). Anything else becomes `internal_error`.
 */
export function handleAdapterError(c: Context, err: unknown): Response {
  if (err instanceof Error) {
    if (err.name === "MapServiceError") {
      return errorResponse(c, "upstream_error", err.message);
    }
    if (err.name === "MapServiceValidationError") {
      return errorResponse(c, "upstream_invalid_response", err.message);
    }
    if (err.name === "AbortError") {
      // Client disconnected; nothing useful to return.
      return errorResponse(c, "internal_error", "request aborted");
    }
  }
  console.error("[mapos-api] unhandled adapter error", err);
  return errorResponse(c, "internal_error", "unhandled server error");
}
