import type { Endpoint } from "@mapos/contracts";

/**
 * Default community endpoints. These are the free, OSS-backed providers the app
 * ships with when no per-service override is configured. The Protomaps endpoint
 * deliberately omits `auth` — the dashboard injects an API key from its Vite
 * env at startup; without one, the protomaps adapter returns a URL that will
 * fail at fetch time, which is the correct behaviour for a misconfigured build.
 */
export const defaultEndpoints = {
  photon: { url: "https://photon.komoot.io" },
  valhalla: { url: "https://valhalla1.openstreetmap.de" },
  protomaps: { url: "https://api.protomaps.com" }
} as const satisfies Record<string, Endpoint>;
