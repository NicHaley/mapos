import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { protocol } from "electron";
import geojsonvt from "geojson-vt";
import Pbf from "pbf";
import { PMTiles } from "pmtiles";
import { fromGeojsonVt } from "vt-pbf";

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
    if (z <= WORLD_MAXZOOM) {
      // Low zooms always come from the bundled global world basemap.
      return tileResponse(await archive(worldPmtiles).getZxy(z, x, y));
    }
    // High zooms: region pack detail where the user has downloaded it.
    const region = await archive(regionPmtiles).getZxy(z, x, y);
    if (region?.data) return tileResponse(region);
    // Outside the downloaded region (the z7+ "donut"), neither archive has this
    // tile: the world stops at z6 and the region pack only covers its bbox.
    // Synthesise a coarse tile by overzooming the z6 world ancestor so the donut
    // shows continuous world geometry instead of a blank tile / 404 (the parent
    // tile is only retained by MapLibre if it was already loaded — panning or
    // zooming out into fresh area would otherwise leave gaps).
    const over = await overzoomWorldTile(worldPmtiles, z, x, y);
    if (over) {
      return new Response(over, {
        status: 200,
        headers: { ...CORS, "content-type": "application/x-protobuf" }
      });
    }
    return new Response("no tile", { status: 404, headers: CORS });
  } catch {
    return new Response("tile error", { status: 500, headers: CORS });
  }
}

/** 200 with the (decompressed) MVT bytes, or 404 when the archive has no tile. */
function tileResponse(t: { data: ArrayBuffer } | undefined): Response {
  if (!t?.data) return new Response("no tile", { status: 404, headers: CORS });
  let bytes = Buffer.from(t.data);
  // getZxy returns the stored bytes (gzip per the archive header); MapLibre's
  // worker wants raw MVT, so decompress here.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return new Response(bytes, {
    status: 200,
    headers: { ...CORS, "content-type": "application/x-protobuf" }
  });
}

// --- world overzoom (donut fill) --------------------------------------------
// For a z>6 tile with no region coverage, re-tile the z6 world ancestor down to
// the requested cell: decode its MVT, re-project each layer's features to a
// geojson-vt index (in WGS84), then emit the requested z/x/y sub-tile. The
// output keeps the world basemap's layer names + attributes, so the Protomaps
// style renders it exactly like a native tile, just coarser.

// One geojson-vt index per layer, keyed by the z6 ancestor tile. Many donut
// children share a parent, so indexing it once and slicing many children is
// cheap. The set of touched ancestors is tiny (z6 has 4096 tiles worldwide), so
// the cache is left unbounded (mirrors the app-life pmtiles archive cache). The
// promise is cached so concurrent children of one ancestor share a single decode.
type LayerIndexes = Map<string, ReturnType<typeof geojsonvt>>;
const worldIndexes = new Map<string, Promise<LayerIndexes | null>>();

const GEOJSONVT_OPTS = {
  maxZoom: 16, // must cover the source's maxzoom (15) so getTile can drill down
  indexMaxZoom: WORLD_MAXZOOM,
  tolerance: 3,
  extent: 4096,
  buffer: 64
} as const;

function worldLayerIndexes(worldPmtiles: string, ax: number, ay: number): Promise<LayerIndexes | null> {
  const key = `${worldPmtiles}|${ax}|${ay}`;
  let built = worldIndexes.get(key);
  if (!built) {
    built = buildWorldLayerIndexes(worldPmtiles, ax, ay).catch((err) => {
      worldIndexes.delete(key); // let a transient read failure retry next time
      throw err;
    });
    worldIndexes.set(key, built);
  }
  return built;
}

async function buildWorldLayerIndexes(
  worldPmtiles: string,
  ax: number,
  ay: number
): Promise<LayerIndexes | null> {
  const t = await archive(worldPmtiles).getZxy(WORLD_MAXZOOM, ax, ay);
  if (!t?.data) return null;
  let bytes = Buffer.from(t.data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const vt = new VectorTile(new Pbf(bytes));
  const indexes: LayerIndexes = new Map();
  for (const name of Object.keys(vt.layers)) {
    const layer = vt.layers[name];
    const features = [];
    for (let i = 0; i < layer.length; i++) {
      // toGeoJSON re-projects tile-local coords back to WGS84 for re-tiling.
      features.push(layer.feature(i).toGeoJSON(ax, ay, WORLD_MAXZOOM));
    }
    indexes.set(name, geojsonvt({ type: "FeatureCollection", features }, GEOJSONVT_OPTS));
  }
  return indexes;
}

/** Re-tile the z6 world ancestor into the requested z/x/y, or null if empty. */
async function overzoomWorldTile(
  worldPmtiles: string,
  z: number,
  x: number,
  y: number
): Promise<Buffer | null> {
  const dz = z - WORLD_MAXZOOM;
  const indexes = await worldLayerIndexes(worldPmtiles, x >> dz, y >> dz);
  if (!indexes) return null;
  const out: Record<string, ReturnType<ReturnType<typeof geojsonvt>["getTile"]>> = {};
  for (const [name, index] of indexes) {
    const tile = index.getTile(z, x, y);
    if (tile && tile.features.length > 0) out[name] = tile;
  }
  if (Object.keys(out).length === 0) return null;
  return Buffer.from(fromGeojsonVt(out, { version: 2 }));
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
