import { type ErrorCode, type ErrorDetail, ErrorResponseSchema } from "@mapos/contracts";
import type { z } from "zod";

const USER_AGENT = "MapOS-Adapter/1.0";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Thrown when the MapOS API returns an error envelope (any non-2xx that
 * matches `ErrorResponseSchema`), or when the server's response fails the
 * client-side contract validation. Carries the stable `code` so the dashboard
 * can switch on the failure category — "upstream provider down" needs very
 * different UX than "bad request".
 */
export class MaposApiError extends Error {
  readonly code: ErrorCode;
  readonly url: string;
  readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(
    code: ErrorCode,
    message: string,
    opts: { url: string; httpStatus: number; details?: ErrorDetail[] }
  ) {
    super(message);
    this.name = "MaposApiError";
    this.code = code;
    this.url = opts.url;
    this.httpStatus = opts.httpStatus;
    this.details = opts.details;
  }
}

export type MaposFetchOptions = {
  signal?: AbortSignal;
  /** Bearer token, populated from `Endpoint.auth.value` for `type: "bearer"`. */
  authToken?: string;
  timeoutMs?: number;
};

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ctrl = new AbortController();
  const onAbort = (src: AbortSignal): void => {
    ctrl.abort(src.reason);
  };
  if (a.aborted) ctrl.abort(a.reason);
  else a.addEventListener("abort", () => onAbort(a), { once: true });
  if (b.aborted) ctrl.abort(b.reason);
  else b.addEventListener("abort", () => onAbort(b), { once: true });
  return ctrl.signal;
}

/**
 * Single-call helper for hitting the MapOS API. Wraps fetch with three guarantees:
 *
 *   1. Sends Accept/Content-Type/User-Agent/Authorization headers consistently.
 *   2. Enforces a timeout that cancels the fetch if the server stalls.
 *   3. Translates the server's `ErrorResponse` envelope into `MaposApiError`
 *      and validates the success body against the caller's schema, so callers
 *      always receive typed data or a typed error — never the raw response.
 */
export async function fetchMapos<T>(
  url: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  opts: MaposFetchOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(new Error("timeout")), timeoutMs);

  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (opts.authToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${opts.authToken}`);
  }

  try {
    const res = await fetch(url, {
      ...init,
      headers,
      signal: combineSignals(opts.signal, timeoutCtrl.signal)
    });

    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (!res.ok) {
          throw new MaposApiError("upstream_error", `HTTP ${res.status}: non-JSON response`, {
            url,
            httpStatus: res.status
          });
        }
        throw new MaposApiError("upstream_invalid_response", "server returned non-JSON body", {
          url,
          httpStatus: res.status
        });
      }
    }

    if (!res.ok) {
      const env = ErrorResponseSchema.safeParse(body);
      if (env.success) {
        throw new MaposApiError(env.data.error.code, env.data.error.message, {
          url,
          httpStatus: res.status,
          details: env.data.error.details
        });
      }
      throw new MaposApiError("upstream_error", `HTTP ${res.status} ${res.statusText}`, {
        url,
        httpStatus: res.status
      });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MaposApiError("upstream_invalid_response", "response failed schema validation", {
        url,
        httpStatus: res.status
      });
    }
    return parsed.data;
  } finally {
    clearTimeout(timeoutId);
  }
}
