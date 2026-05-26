import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { errorResponse } from "./errors";
import { registerGeocoding } from "./routes/geocoding";
import { registerHealth } from "./routes/health";
import { registerIsochrones } from "./routes/isochrones";
import { registerRouting } from "./routes/routing";
import { registerTiles } from "./routes/tiles";
import { registerWebSearch } from "./routes/web-search";

/**
 * Always-permitted origins. Localhost on any port covers Vite dev servers and
 * developers running the dashboard against a local server; `file://` and the
 * literal `"null"` cover Electron's renderer when it loads from a file URL in
 * production builds. Operators can extend this via the `ALLOWED_ORIGINS` env.
 *
 * Without auth, CORS doesn't actually gate anything meaningful — a malicious
 * client can just `curl` the API. The point of v1's CORS policy is to be
 * permissive enough for legitimate clients while still saying "no" to wild
 * cross-origin browser requests by default. Tightening lands with auth.
 */
function isAlwaysAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // some clients (Electron file://) send no Origin
  if (origin === "null") return true;
  if (origin.startsWith("file://")) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Build the Hono app. Constructed once per isolate (Workers) or process (Node);
 * env is read off `c.env` per-request, so the same app instance serves both.
 *
 * Order matters: request-id and logger run first so every log line is
 * correlated. CORS is dynamic — localhost / file:// are always allowed;
 * additional origins (e.g. apps/web in production) come from `ALLOWED_ORIGINS`.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.use("*", requestId());
  app.use("*", logger());

  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        if (isAlwaysAllowedOrigin(origin)) return origin ?? "*";
        const raw = (c.env as { ALLOWED_ORIGINS?: string } | undefined)?.ALLOWED_ORIGINS ?? "";
        const allowed = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allowed.includes(origin)) return origin;
        return null;
      },
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600
    })
  );

  registerHealth(app);
  registerGeocoding(app);
  registerRouting(app);
  registerIsochrones(app);
  registerTiles(app);
  registerWebSearch(app);

  app.notFound((c) =>
    errorResponse(c, "not_found", `route not found: ${c.req.method} ${c.req.path}`)
  );

  app.onError((err, c) => {
    if (err instanceof Error && err.message.startsWith("Server misconfigured")) {
      return errorResponse(c, "server_misconfigured", err.message);
    }
    console.error("[mapos-api] unhandled error", err);
    return errorResponse(c, "internal_error", err instanceof Error ? err.message : "unknown error");
  });

  return app;
}

export const app = createApp();
