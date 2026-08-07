import { z } from "zod";

/**
 * Server runtime configuration. Loaded from Cloudflare's `vars` + secrets on
 * Workers, or `process.env` on Node. Validated once per isolate; missing
 * required values fail every request with a `server_misconfigured` error rather
 * than silently doing the wrong thing.
 */
export const EnvSchema = z.object({
  // Upstream providers (defaults via wrangler vars).
  PHOTON_URL: z.string().url().default("https://photon.komoot.io"),
  VALHALLA_URL: z.string().url().default("https://valhalla1.openstreetmap.de"),
  PROTOMAPS_STYLE_URL_BASE: z.string().url().default("https://api.protomaps.com"),
  PROTOMAPS_TILE_URL_TEMPLATE: z
    .string()
    .default("https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt"),

  // Secrets. Optional at the type level so we can produce a clean error at request
  // time for routes that need them, rather than failing every route at boot.
  PROTOMAPS_API_KEY: z.string().min(1).optional(),

  // Comma-separated list of allowed CORS origins. Electron's main process
  // doesn't trigger CORS, so the dashboard works with an empty allowlist.
  ALLOWED_ORIGINS: z.string().default(""),

  NODE_ENV: z.enum(["development", "production"]).default("production")
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Parse env once per isolate. CF Workers pass the env object into the fetch
 * handler; Node reads from `process.env`. Both shapes are accepted as `unknown`
 * — the Zod schema is the source of truth for the expected shape.
 */
export function loadEnv(raw: unknown): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Server misconfigured — env failed validation: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only — reset between unit tests. Not used at runtime. */
export function resetEnvCache(): void {
  cached = null;
}
