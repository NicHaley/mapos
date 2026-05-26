import type { ServicesConfig } from "./mapos-config";

/**
 * Renderer-side Content-Security-Policy. The `connect-src` and `img-src` lists
 * depend on the active services mode — community talks to upstream OSS
 * providers directly; self-hosted and (future) mapos_cloud route through a
 * MapOS server, and the configured origin needs to be in the policy.
 *
 * The CSP is rebuilt per-request, so a mode change via a config write + client
 * invalidation takes effect on the next page load with no app restart.
 */

let activeServices: ServicesConfig = { mode: "community" };

export function setActiveServicesForCsp(services: ServicesConfig): void {
  activeServices = services;
}

/**
 * Public asset CDNs that are always allowed regardless of services mode.
 * Protomaps hosts sprite (icon) and glyph (font) files on GitHub Pages with no
 * API key — they're referenced from inside the style.json that the tile
 * service returns, and the renderer fetches them directly. Proxying them
 * through the server would add cost and complexity without hiding anything.
 */
const ALWAYS_ALLOWED_CDN_ORIGINS = ["https://protomaps.github.io"];

const COMMUNITY_CONNECT_ORIGINS = [
  "https://api.protomaps.com",
  "https://photon.komoot.io",
  "https://valhalla1.openstreetmap.de"
];

const COMMUNITY_IMG_ORIGINS = ["https://api.protomaps.com"];

const CLOUD_ORIGIN = "https://api.mapos.md";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCsp(): string {
  const connectSrc = new Set<string>(["'self'", ...ALWAYS_ALLOWED_CDN_ORIGINS]);
  const imgSrc = new Set<string>(["'self'", "data:", "blob:", ...ALWAYS_ALLOWED_CDN_ORIGINS]);

  if (activeServices.mode === "community") {
    for (const o of COMMUNITY_CONNECT_ORIGINS) connectSrc.add(o);
    for (const o of COMMUNITY_IMG_ORIGINS) imgSrc.add(o);
  } else if (activeServices.mode === "self_hosted") {
    const origin = originOf(activeServices.baseUrl);
    if (origin) {
      connectSrc.add(origin);
      imgSrc.add(origin);
    }
  } else if (activeServices.mode === "mapos_cloud") {
    connectSrc.add(CLOUD_ORIGIN);
    imgSrc.add(CLOUD_ORIGIN);
  }

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' blob:",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${[...imgSrc].join(" ")}`,
    `connect-src ${[...connectSrc].join(" ")}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:"
  ].join("; ");
}
