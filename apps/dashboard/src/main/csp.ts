import type { ServicesConfig } from "./mapos-config";

/**
 * Renderer-side Content-Security-Policy. The `connect-src` and `img-src` lists
 * depend on the active services mode — local mode is fully offline and needs no
 * remote origins; cloud mode routes through a MapOS server (a custom `baseUrl` or
 * the canonical api.mapos.md), whose origin needs to be in the policy.
 *
 * The CSP is rebuilt per-request, so a mode change via a config write + client
 * invalidation takes effect on the next page load with no app restart.
 */

let activeServices: ServicesConfig = { mode: "local" };

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

const CLOUD_ORIGIN = "https://api.mapos.md";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCsp(): string {
  // Local offline schemes: `mapos-region:` (per-region tiles/style + pmtiles range
  // fetches) and `mapos-asset:` (bundled glyphs/sprites). Always allowed; they only
  // resolve when a pack is installed / assets are bundled.
  const connectSrc = new Set<string>([
    "'self'",
    "mapos-region:",
    "mapos-asset:",
    ...ALWAYS_ALLOWED_CDN_ORIGINS
  ]);
  const imgSrc = new Set<string>([
    "'self'",
    "data:",
    "blob:",
    "mapos-region:",
    "mapos-asset:",
    "mapos-vault:",
    ...ALWAYS_ALLOWED_CDN_ORIGINS,
    // Wikimedia place photos on search preview cards. Special:FilePath on the
    // commons host 302s to upload.wikimedia.org, so both origins are needed.
    "https://commons.wikimedia.org",
    "https://upload.wikimedia.org"
  ]);

  // Local mode is fully offline — only the always-allowed schemes/CDN above apply.
  // Cloud mode reaches a server: a custom baseUrl if set, else canonical MapOS Cloud.
  if (activeServices.mode === "cloud") {
    const origin = (activeServices.baseUrl && originOf(activeServices.baseUrl)) || CLOUD_ORIGIN;
    connectSrc.add(origin);
    imgSrc.add(origin);
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
