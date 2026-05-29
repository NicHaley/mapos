import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { protocol } from "electron";

/**
 * Two local schemes feed the offline map:
 *   mapos-region://<region>/<file>      → per-region pack bytes (userData/regions)
 *   mapos-region://<region>/style.json  → a generated Protomaps basemap style
 *   mapos-asset://fonts|sprites/<...>   → global glyphs/sprites bundled with the app
 *
 * Region packs are per-region and live in userData; glyphs/sprites are identical
 * for every region, so they ship with the app once. Both are privileged standard
 * schemes so MapLibre + the pmtiles library can range-fetch them like HTTP.
 */
export const REGION_SCHEME = "mapos-region";
export const ASSET_SCHEME = "mapos-asset";

const PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true
} as const;

/** Must run before app `ready`. */
export function registerLocalSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: REGION_SCHEME, privileges: PRIVILEGES },
    { scheme: ASSET_SCHEME, privileges: PRIVILEGES }
  ]);
}

/** Must run after app `ready`. */
export function registerRegionProtocol(regionsDir: string): void {
  protocol.handle(REGION_SCHEME, (request) => {
    const url = new URL(request.url);
    const region = url.hostname;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel === "style.json") {
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return styleResponse(region, theme);
    }
    return serveFile(join(regionsDir, region), rel, request.headers.get("range"));
  });
}

/** Must run after app `ready`. Serves bundled glyphs/sprites from `assetsDir`. */
export function registerAssetProtocol(assetsDir: string): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);
    // host is the top folder (fonts | sprites); pathname is the rest.
    const rel = decodeURIComponent(`${url.hostname}${url.pathname}`);
    return serveFile(assetsDir, rel, request.headers.get("range"));
  });
}

const CORS = { "access-control-allow-origin": "*" } as const;

function styleResponse(region: string, theme: "light" | "dark"): Response {
  // Match the app's online variants: light, and "black" for dark.
  const flavorName = theme === "dark" ? "black" : "light";
  const source = "protomaps";
  const style = {
    version: 8,
    // Glyphs + sprites are served locally (bundled with the app) for true offline.
    glyphs: `${ASSET_SCHEME}://fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSET_SCHEME}://sprites/${flavorName}`,
    sources: {
      [source]: {
        type: "vector",
        url: `pmtiles://${REGION_SCHEME}://${region}/${region}.pmtiles`,
        attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
      }
    },
    layers: layers(source, namedFlavor(flavorName), { lang: "en" })
  };
  return new Response(JSON.stringify(style), {
    headers: { "content-type": "application/json", ...CORS }
  });
}

function contentType(file: string): string {
  if (file.endsWith(".pmtiles")) return "application/octet-stream";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".pbf")) return "application/x-protobuf";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

/** Serve a file under `root`, honouring a Range header. Guards path traversal. */
function serveFile(root: string, rel: string, range: string | null): Response {
  const full = normalize(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) {
    return new Response("forbidden", { status: 403, headers: CORS });
  }
  let size: number;
  try {
    size = statSync(full).size;
  } catch {
    return new Response("not found", { status: 404, headers: CORS });
  }
  const headers: Record<string, string> = {
    ...CORS,
    "accept-ranges": "bytes",
    "content-type": contentType(rel)
  };
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    const start = m[1] ? Number.parseInt(m[1], 10) : 0;
    const end = m[2] ? Number.parseInt(m[2], 10) : size - 1;
    const body = readRange(full, start, end);
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
    headers["content-length"] = String(body.length);
    return new Response(body, { status: 206, headers });
  }
  const body = readRange(full, 0, size - 1);
  headers["content-length"] = String(body.length);
  return new Response(body, { status: 200, headers });
}

function readRange(path: string, start: number, end: number): Buffer {
  const len = Math.max(0, end - start + 1);
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return buf;
}
