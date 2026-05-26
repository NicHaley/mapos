import type { Endpoint, TileStyleRequest } from "@mapos/contracts";

/**
 * Build a Protomaps v5 basemap style URL. The API key (if any) comes from
 * `ep.auth` — Protomaps requires a key for production traffic, so callers
 * should always pass one. A missing key yields a URL Protomaps will reject,
 * which surfaces the misconfiguration at fetch time rather than silently.
 */
function styleUrl(req: TileStyleRequest, ep: Endpoint): string {
  const variant = req.isDark ? "black" : "light";
  const key = ep.auth?.type === "apikey" ? ep.auth.value : null;
  const keyParam = key ? `?key=${encodeURIComponent(key)}` : "";
  return `${ep.url}/styles/v5/${variant}/en.json${keyParam}`;
}

export const protomapsAdapter = {
  id: "protomaps" as const,
  tiles: { styleUrl }
};
