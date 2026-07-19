import type { Endpoint, TileStyleRequest } from "@mapos/contracts";

/**
 * Synchronous URL construction — no network call needed. The server hosts the
 * proxied style at a stable path (`/v1/tiles/style.json`), so the adapter just
 * builds the URL. The actual style fetch happens later when MapLibre loads it.
 *
 * The Protomaps API key is *not* attached here — it lives on the server. The
 * resulting style.json reference per-tile URLs that point back at the server,
 * which re-attaches the key when forwarding to Protomaps.
 */
export function styleUrl(req: TileStyleRequest, ep: Endpoint): string {
  const variant = req.isDark ? "dark" : "light";
  const mono = req.monochrome ? "1" : "0";
  return `${ep.url}/v1/tiles/style.json?variant=${variant}&mono=${mono}`;
}
