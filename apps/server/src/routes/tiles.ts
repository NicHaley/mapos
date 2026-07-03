import { TileStyleRequestSchema } from "@mapos/contracts";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { Hono } from "hono";
import { z } from "zod";
import { loadEnv } from "../env";
import { errorResponse } from "../errors";
import { handleContractPost } from "../route-helpers";

/**
 * Tiles are unique among the contract endpoints: instead of returning provider
 * data directly, we proxy two separate things:
 *
 *  1. The MapLibre style JSON, rewritten so its tile-source URLs point back at
 *     this server. This hides the Protomaps API key from the client.
 *  2. Individual vector tiles, edge-cached aggressively (Cache-Control + the
 *     Workers cache API) so per-tile Protomaps subrequests collapse across the
 *     whole user base.
 *
 * The `style-url` contract endpoint just hands the client a URL pointing at the
 * proxied style.json. The two pieces sit behind one contract from the client's
 * perspective.
 */

const StyleUrlResponseSchema = z.object({ url: z.string().url() });

function variantFromQuery(raw: string | undefined): "light" | "dark" {
  return raw === "dark" || raw === "black" ? "dark" : "light";
}

function publicBaseUrl(reqUrl: string): string {
  const u = new URL(reqUrl);
  return `${u.origin}`;
}

export function registerTiles(app: Hono): void {
  // Contract endpoint: returns a URL the client can hand to MapLibre.
  app.post("/v1/tiles/style-url", (c) =>
    handleContractPost(c, TileStyleRequestSchema, StyleUrlResponseSchema, (req) => {
      const variant = req.isDark ? "dark" : "light";
      const base = publicBaseUrl(c.req.url);
      return Promise.resolve({ url: `${base}/v1/tiles/style.json?variant=${variant}` });
    })
  );

  // Proxied style JSON. Light fetches the upstream Protomaps style with the API
  // key and rewrites its tile-source URLs to point back at this server so the
  // key never reaches the client. Dark can't be proxied: the hosted "black"
  // flavor defines no POI colors or icons, so its style has no pois layer at
  // all. Instead the dark style is generated here with @protomaps/basemaps —
  // black flavor plus the dark flavor's POI palette and sprite sheet — matching
  // the offline path (see the dashboard's region-protocol.ts).
  app.get("/v1/tiles/style.json", async (c) => {
    const env = loadEnv(c.env);
    if (!env.PROTOMAPS_API_KEY) {
      return errorResponse(c, "server_misconfigured", "PROTOMAPS_API_KEY is required for tiles");
    }
    const variant = variantFromQuery(c.req.query("variant"));
    const proxyBase = `${publicBaseUrl(c.req.url)}/v1/tiles`;
    if (variant === "dark") {
      return c.json(darkStyle(proxyBase));
    }
    const upstream = `${env.PROTOMAPS_STYLE_URL_BASE}/styles/v5/${variant}/en.json?key=${encodeURIComponent(env.PROTOMAPS_API_KEY)}`;
    const res = await fetch(upstream, { signal: c.req.raw.signal });
    if (!res.ok) {
      return errorResponse(
        c,
        "upstream_error",
        `Protomaps style fetch failed: ${res.status} ${res.statusText}`
      );
    }
    const style = (await res.json()) as Record<string, unknown>;
    rewriteStyleSources(style, proxyBase);
    return c.json(style);
  });

  // Per-tile proxy. Edge-cached for 24h, immutable. The Protomaps API key is
  // re-attached server-side; the inbound URL doesn't carry it.
  app.get("/v1/tiles/:z/:x/:y{.+\\.(pbf|mvt)}", async (c) => {
    const env = loadEnv(c.env);
    if (!env.PROTOMAPS_API_KEY) {
      return errorResponse(c, "server_misconfigured", "PROTOMAPS_API_KEY is required for tiles");
    }
    const { z: zParam, x: xParam, y: yWithExt } = c.req.param();
    const z = String(zParam);
    const x = String(xParam);
    const y = String(yWithExt).replace(/\.(pbf|mvt)$/, "");

    const template = env.PROTOMAPS_TILE_URL_TEMPLATE;
    const upstream = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    const upstreamWithKey = upstream.includes("?")
      ? `${upstream}&key=${encodeURIComponent(env.PROTOMAPS_API_KEY)}`
      : `${upstream}?key=${encodeURIComponent(env.PROTOMAPS_API_KEY)}`;

    // Use the Cloudflare edge cache. cacheKey is constructed from the inbound
    // URL (no key in it), so the same tile served to different users coalesces.
    // `caches.default` is a Workers extension; on Node this branch is skipped.
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(c.req.url, { method: "GET" });
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    const res = await fetch(upstreamWithKey, { signal: c.req.raw.signal });
    if (!res.ok) {
      return errorResponse(
        c,
        "upstream_error",
        `Protomaps tile fetch failed: ${res.status} ${res.statusText}`
      );
    }

    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "public, max-age=86400, immutable");
    headers.delete("Set-Cookie");
    const out = new Response(res.body, { status: res.status, headers });
    if (cache) {
      // waitUntil keeps the cache write alive past the response. On Node (no
      // ctx.executionCtx), fall back to fire-and-forget.
      const ctx = (c as { executionCtx?: { waitUntil: (p: Promise<unknown>) => void } })
        .executionCtx;
      const cloned = out.clone();
      if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, cloned));
      else void cache.put(cacheKey, cloned);
    }
    return out;
  });
}

const ASSETS_BASE = "https://protomaps.github.io/basemaps-assets";
const ATTRIBUTION =
  '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors · © <a href="https://protomaps.com">Protomaps</a>';

/**
 * Dark style, generated rather than proxied. Black flavor with the dark
 * flavor's POI palette grafted on; the dark sprite sheet is a superset of
 * black's icons and is drawn for dark backdrops. Glyphs/sprites come from the
 * public Protomaps assets CDN (no API key), tiles from this server's proxy.
 */
function darkStyle(proxyBase: string): Record<string, unknown> {
  const flavor = { ...namedFlavor("black"), pois: namedFlavor("dark").pois };
  return {
    version: 8,
    glyphs: `${ASSETS_BASE}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS_BASE}/sprites/v4/dark`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: [`${proxyBase}/{z}/{x}/{y}.mvt`],
        maxzoom: 15,
        attribution: ATTRIBUTION
      }
    },
    layers: layers("protomaps", flavor, { lang: "en" })
  };
}

/**
 * Rewrite the MapLibre style's `sources` block so any `tiles: [...]` arrays
 * point at our proxy URL instead of the upstream Protomaps URL. This is what
 * keeps the API key off the wire to the client.
 */
function rewriteStyleSources(style: Record<string, unknown>, proxyBase: string): void {
  const sources = style.sources;
  if (!sources || typeof sources !== "object") return;
  for (const key of Object.keys(sources)) {
    const src = (sources as Record<string, unknown>)[key];
    if (!src || typeof src !== "object") continue;
    const s = src as Record<string, unknown>;
    if (Array.isArray(s.tiles)) {
      s.tiles = [`${proxyBase}/{z}/{x}/{y}.mvt`];
    }
    // PMTiles sources use { url: "...pmtiles" } — not supported in v1.
  }
}
