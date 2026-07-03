import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { protocol } from "electron";
import { PMTiles } from "pmtiles";
import { CORS, PRIVILEGES, serveFile } from "./protocol-serve";
import { listInstalledRegions } from "./services/offline/installed-regions";
import { VAULT_SCHEME } from "./vault-protocol";

/**
 * Local schemes for the offline map:
 *   mapos-region://<region>/style.json             → generated Protomaps style
 *   mapos-region://<region>/{world|region}/{z}/{x}/{y}.pbf → vector tiles
 *   mapos-region://<region>/<file>                 → region pack bytes (userData/regions)
 *   mapos-asset://fonts|sprites/<...>             → bundled glyphs/sprites
 *
 * Two vector sources: `world` (z0–6) is overzoomed by MapLibre to cover every
 * zoom everywhere; `region` (z7+) adds detail where a pack is downloaded. Symbol
 * layers run on one source at a time (world ≤z7, region ≥z7) to avoid cross-source
 * label collisions.
 */
// Must match the pipeline's TILES_MINZOOM (= WORLD_MAXZOOM + 1).
const WORLD_MAXZOOM = 6;
const REGION_MINZOOM = WORLD_MAXZOOM + 1;
const REGION_MAXZOOM = 15;
export const REGION_SCHEME = "mapos-region";
export const ASSET_SCHEME = "mapos-asset";

/** Run before app `ready`. */
export function registerLocalSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: REGION_SCHEME, privileges: PRIVILEGES },
    { scheme: ASSET_SCHEME, privileges: PRIVILEGES },
    { scheme: VAULT_SCHEME, privileges: PRIVILEGES }
  ]);
}

const TILE_RE = /^(world|region)\/(\d+)\/(\d+)\/(\d+)\.pbf$/;

// The region slug becomes a path segment under `regionsDir`, so it must be a bare
// slug — never `..`, a separator, or anything that could escape the dir. `_all` is
// the style/world sentinel and is allowed. `new URL()` happily parses `..` as a
// hostname and `path.join` collapses it *before* serveFile's prefix guard runs, so
// the slug has to be validated here, before it ever reaches the filesystem.
const REGION_SLUG_RE = /^[a-z0-9_-]+$/i;

/** Run after app `ready`. */
export function registerRegionProtocol(regionsDir: string, worldPmtilesPath: string): void {
  protocol.handle(REGION_SCHEME, (request) => {
    const url = new URL(request.url);
    const region = url.hostname;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!REGION_SLUG_RE.test(region)) {
      return new Response("forbidden", { status: 403, headers: CORS });
    }
    if (rel === "style.json") {
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      // Host is a sentinel (`_all`) — the style spans every downloaded pack.
      return styleResponse(regionsDir, theme);
    }
    const tile = TILE_RE.exec(rel);
    if (tile) {
      const path =
        tile[1] === "world" ? worldPmtilesPath : join(regionsDir, region, `${region}.pmtiles`);
      return pmtilesTile(path, +tile[2], +tile[3], +tile[4]);
    }
    return serveFile(join(regionsDir, region), rel, request.headers.get("range"));
  });
}

/** Run after app `ready`. Serves bundled glyphs/sprites from `assetsDir`. */
export function registerAssetProtocol(assetsDir: string): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);
    // host is the top folder (fonts | sprites); pathname is the rest.
    const rel = decodeURIComponent(`${url.hostname}${url.pathname}`);
    const res = serveFile(assetsDir, rel, request.headers.get("range"));
    // Only Western glyph blocks are bundled (see fetch-basemap-assets.mjs); other
    // scripts render locally, so silence the 404 for their missing ranges.
    if (res.status === 404 && GLYPH_RANGE_RE.test(rel)) return emptyPbf();
    return res;
  });
}

const ATTRIBUTION =
  '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors · © <a href="https://protomaps.com">Protomaps</a>';

// Zero bytes is a valid empty protobuf (no layers / no glyphs). Serving it for a
// missing tile or glyph range keeps MapLibre quiet (no 404 log) while it falls
// back to the overzoomed world / local glyph rendering.
const EMPTY_PBF = new Uint8Array(0);
const GLYPH_RANGE_RE = /^fonts\/.+\/\d+-\d+\.pbf$/;
function emptyPbf(): Response {
  return new Response(EMPTY_PBF, {
    status: 200,
    headers: { ...CORS, "content-type": "application/x-protobuf" }
  });
}

type StyleLayer = {
  id: string;
  type: string;
  source?: string;
  minzoom?: number;
  maxzoom?: number;
  [key: string]: unknown;
};

function styleResponse(regionsDir: string, theme: "light" | "dark"): Response {
  // Dark mode is the "black" flavor, but black defines no POI colors (so
  // `layers()` would emit no pois layer) and its sprite sheet ships no POI
  // icons. Graft the dark flavor's POI palette onto black and use the dark
  // sprite sheet — a superset of black's icons, drawn for dark backdrops.
  const flavor =
    theme === "dark"
      ? { ...namedFlavor("black"), pois: namedFlavor("dark").pois }
      : namedFlavor("light");
  const spriteName = theme === "dark" ? "dark" : "light";

  // World backdrop (z0–6, overzoomed by MapLibre to cover all higher zooms). Its
  // symbols stop at z7 so region labels take over without colliding. Host is the
  // `_all` sentinel; world tiles ignore it (always the bundled world.pmtiles).
  const worldBase = layers("world", flavor, { lang: "en" }) as unknown as StyleLayer[];
  const worldLayers = worldBase.map((l) => {
    const c: StyleLayer = { ...l, id: `world_${l.id}` };
    if (c.type === "symbol") c.maxzoom = Math.min(c.maxzoom ?? REGION_MINZOOM, REGION_MINZOOM);
    return c;
  });

  const sources: Record<string, unknown> = {
    world: {
      type: "vector",
      tiles: [`${REGION_SCHEME}://_all/world/{z}/{x}/{y}.pbf`],
      minzoom: 0,
      maxzoom: WORLD_MAXZOOM,
      attribution: ATTRIBUTION
    }
  };

  // One detail source + layer set per downloaded pack. `layers(srcId, …)` stamps
  // `source: srcId` on each layer; ids are prefixed with the region slug so packs
  // don't collide (regions are geographically disjoint, so labels don't fight).
  const regionLayers: StyleLayer[] = [];
  for (const r of listInstalledRegions(regionsDir)) {
    if (!r.pmtiles) continue;
    const srcId = `region_${r.region}`;
    sources[srcId] = {
      type: "vector",
      tiles: [`${REGION_SCHEME}://${r.region}/region/{z}/{x}/{y}.pbf`],
      minzoom: REGION_MINZOOM,
      maxzoom: REGION_MAXZOOM,
      attribution: ATTRIBUTION
    };
    const base = layers(srcId, flavor, { lang: "en" }) as unknown as StyleLayer[];
    for (const l of base) {
      if (l.type === "background") continue; // one shared world background is enough
      const c: StyleLayer = { ...l, id: `${r.region}_${l.id}` };
      c.minzoom = Math.max(c.minzoom ?? 0, REGION_MINZOOM);
      regionLayers.push(c);
    }
  }

  const style = {
    version: 8,
    glyphs: `${ASSET_SCHEME}://fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSET_SCHEME}://sprites/${spriteName}`,
    sources,
    layers: [...worldLayers, ...regionLayers]
  };
  return new Response(JSON.stringify(style), {
    headers: { "content-type": "application/json", ...CORS }
  });
}

// Node fs-backed pmtiles Source (the library's FileSource is browser-only).
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
    // readSync may return fewer bytes than requested; loop until satisfied or EOF
    // so a short read can't feed garbage (uninitialised tail) into the decoder.
    let read = 0;
    while (read < length) {
      const n = readSync(this.fd, buf, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + read) };
  }
  close(): void {
    closeSync(this.fd);
  }
}

const archives = new Map<string, { pmtiles: PMTiles; source: NodeFileSource }>();
function archive(path: string): PMTiles {
  let a = archives.get(path);
  if (!a) {
    const source = new NodeFileSource(path);
    const pmtiles = new PMTiles(source as unknown as ConstructorParameters<typeof PMTiles>[0]);
    a = { pmtiles, source };
    archives.set(path, a);
  }
  return a.pmtiles;
}

/**
 * Close every cached pmtiles file descriptor and drop the archive cache. Call
 * after a pack is deleted or re-downloaded — otherwise the cached archive keeps
 * serving the old inode through a stale fd (so new tiles never appear), and the
 * open handle leaks (and blocks deletion on Windows).
 */
export function closeRegionArchives(): void {
  for (const { source } of archives.values()) source.close();
  archives.clear();
}

async function pmtilesTile(path: string, z: number, x: number, y: number): Promise<Response> {
  try {
    const t = await archive(path).getZxy(z, x, y);
    // Missing region tile (outside the pack's bbox) → empty 200; the overzoomed
    // world source renders underneath.
    if (!t?.data) return emptyPbf();
    let bytes = Buffer.from(t.data);
    // Stored bytes are gzipped per the archive header; MapLibre wants raw MVT.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    return new Response(bytes, {
      status: 200,
      headers: { ...CORS, "content-type": "application/x-protobuf" }
    });
  } catch {
    return new Response("tile error", { status: 500, headers: CORS });
  }
}
