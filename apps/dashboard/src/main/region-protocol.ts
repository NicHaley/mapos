import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { protocol } from "electron";
import { PMTiles } from "pmtiles";

/**
 * Two local schemes feed the offline map:
 *   mapos-region://<region>/style.json          → a generated Protomaps basemap style
 *   mapos-region://<region>/composite/{z}/{x}/{y}.pbf → ONE global vector source:
 *        world basemap tiles at z<=6, region pack tiles at z>=7
 *   mapos-region://<region>/<file>              → per-region pack bytes (userData/regions)
 *   mapos-asset://fonts|sprites/<...>           → global glyphs/sprites bundled with the app
 *
 * The map uses a SINGLE composite source rather than two overlaid sources: a
 * second vector source that is empty outside its bbox corrupts MapLibre's
 * symbol placement for the other source (labels clip at tile seams). Compositing
 * world + region into one source at the protocol layer avoids that entirely —
 * the world basemap (shared, bundled) provides global low-zoom coverage and the
 * region pack provides high-zoom detail where downloaded.
 *
 * Region packs live in userData; glyphs/sprites and the low-zoom world basemap
 * are identical for every region, so they ship with the app once. Both are
 * privileged standard schemes so MapLibre can fetch them like HTTP.
 */
// Above this zoom the composite source serves region-pack tiles; at/below it
// serves the global world basemap. Must match the world basemap's maxzoom AND
// the pipeline's TILES_MINZOOM (= WORLD_MAXZOOM + 1), which is where region
// packs start.
const WORLD_MAXZOOM = 6;
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

const COMPOSITE_RE = /^composite\/(\d+)\/(\d+)\/(\d+)\.pbf$/;

/**
 * Must run after app `ready`. `worldPmtilesPath` is the bundled global low-zoom
 * basemap; region packs are read from `regionsDir/<region>/<region>.pmtiles`.
 */
export function registerRegionProtocol(regionsDir: string, worldPmtilesPath: string): void {
  protocol.handle(REGION_SCHEME, (request) => {
    const url = new URL(request.url);
    const region = url.hostname;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel === "style.json") {
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return styleResponse(region, theme);
    }
    const tile = COMPOSITE_RE.exec(rel);
    if (tile) {
      const regionPmtiles = join(regionsDir, region, `${region}.pmtiles`);
      return compositeTile(worldPmtilesPath, regionPmtiles, +tile[1], +tile[2], +tile[3]);
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
const ATTRIBUTION = '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>';

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
      // One composite source: world basemap (z<=6) + region detail (z>=7),
      // stitched by the protocol handler. maxzoom 15 enables region detail.
      [source]: {
        type: "vector",
        tiles: [`${REGION_SCHEME}://${region}/composite/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 15,
        attribution: ATTRIBUTION
      }
    },
    layers: layers(source, namedFlavor(flavorName), { lang: "en" })
  };
  return new Response(JSON.stringify(style), {
    headers: { "content-type": "application/json", ...CORS }
  });
}

// --- composite tiles --------------------------------------------------------
// A minimal Node fs-backed pmtiles Source (the library's FileSource is for the
// browser File API). Archives are cached and their fd kept open for app life.
class NodeFileSource {
  private readonly fd: number;
  constructor(private readonly path: string) {
    this.fd = openSync(path, "r");
  }
  getKey(): string {
    return this.path;
  }
  async getBytes(offset: number, length: number): Promise<{ data: ArrayBuffer }> {
    const buf = Buffer.allocUnsafe(length);
    readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }
}

const archives = new Map<string, PMTiles>();
function archive(path: string): PMTiles {
  let a = archives.get(path);
  if (!a) {
    a = new PMTiles(new NodeFileSource(path) as unknown as ConstructorParameters<typeof PMTiles>[0]);
    archives.set(path, a);
  }
  return a;
}

async function compositeTile(
  worldPmtiles: string,
  regionPmtiles: string,
  z: number,
  x: number,
  y: number
): Promise<Response> {
  try {
    const src = archive(z <= WORLD_MAXZOOM ? worldPmtiles : regionPmtiles);
    const t = await src.getZxy(z, x, y);
    // 404 (not 204) for a missing high-zoom tile: MapLibre then retains the
    // overzoomed z6 world parent as a low-fi backdrop, instead of replacing it
    // with a blank "loaded-empty" tile. So zooming into an undownloaded area
    // shows coarse world geometry rather than nothing.
    if (!t?.data) return new Response("no tile", { status: 404, headers: CORS });
    let bytes = Buffer.from(t.data);
    // getZxy returns the stored bytes (gzip per the archive header); MapLibre's
    // worker wants raw MVT, so decompress here.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    return new Response(bytes, {
      status: 200,
      headers: { ...CORS, "content-type": "application/x-protobuf" }
    });
  } catch {
    return new Response("tile error", { status: 500, headers: CORS });
  }
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
