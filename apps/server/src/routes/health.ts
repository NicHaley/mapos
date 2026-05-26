import type { Hono } from "hono";

export function registerHealth(app: Hono): void {
  app.get("/v1/healthz", (c) =>
    c.json({ ok: true, name: "mapos-api", version: 1, timestamp: Date.now() })
  );
}
