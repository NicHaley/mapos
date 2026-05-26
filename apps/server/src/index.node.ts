import { serve } from "@hono/node-server";
import { app } from "./app";

/**
 * Node entry for self-hosted deploys. Wraps the same Hono app with
 * `@hono/node-server` so it speaks Node's `http` instead of Workers' fetch.
 *
 * Binds to 127.0.0.1 by default — operators who want public exposure must
 * either set `HOST=0.0.0.0` explicitly (and almost certainly want a reverse
 * proxy in front for TLS) or run this behind a Docker network / VPN.
 *
 * The Hono app reads env off `c.env`. Node's `process.env` is injected into the
 * context via middleware so route handlers see the same shape they do on
 * Workers.
 */

// Minimal local declaration — avoids pulling @types/node into the workspace
// just for one entry point, and keeps the CF Workers entry clean.
declare const process: {
  env: Record<string, string | undefined>;
};

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");

app.use("*", async (c, next) => {
  (c as unknown as { env: Record<string, string | undefined> }).env = process.env;
  await next();
});

if (host === "0.0.0.0" && !process.env.ALLOWED_ORIGINS) {
  console.warn(
    "[mapos-api] WARNING: binding to 0.0.0.0 without ALLOWED_ORIGINS or auth. " +
      "Use a reverse proxy with rate limiting, or restrict the bind address."
  );
}

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`[mapos-api] listening on http://${info.address}:${info.port}`);
});
