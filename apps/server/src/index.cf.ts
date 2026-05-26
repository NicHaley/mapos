import { app } from "./app";

/**
 * Cloudflare Workers entry. Hono's `Hono#fetch` is already a Workers-compatible
 * fetch handler, so the export is just a single field. Wrangler picks this file
 * up via `main` in wrangler.jsonc.
 */
export default {
  fetch: app.fetch
} satisfies ExportedHandler<Record<string, unknown>>;
