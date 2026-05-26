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

/**
 * Build the Hono app. Constructed once per isolate (Workers) or process (Node);
 * env is read off `c.env` per-request, so the same app instance serves both.
 *
 * Order matters: request-id and logger run first so every log line is
 * correlated. CORS is policy-only and dynamic — Electron's main process
 * doesn't trigger preflight, so the default allowlist is empty.
 */
export function createApp(): Hono {
  const app = new Hono();

  app.use("*", requestId());
  app.use("*", logger());

  app.use(
    "*",
    cors({
      origin: (origin, c) => {
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
