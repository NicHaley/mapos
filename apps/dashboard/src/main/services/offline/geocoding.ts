import type {
  Endpoint,
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest
} from "@mapos/contracts";
import type { AdapterContext, GeocodingCapability } from "@mapos/service-adapters";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { listInstalledRegions, regionsContaining } from "./installed-regions";

/**
 * Offline geocoding against downloaded `geocode.sqlite` region packs (FTS5 +
 * R-tree, built by the pipeline). `Endpoint.url` carries the regions directory;
 * this adapter queries every installed pack's DB and merges the results — forward
 * search ranks across all packs, reverse search only hits packs whose bbox covers
 * the point.
 *
 * Same `GeocodeResult` shape as the Photon adapter, so the renderer can't tell
 * which backend answered. Distance is computed at query time (the index is pure
 * data, intentionally portable across desktop/mobile/server).
 */

const DEFAULT_LIMIT = 8;
const REVERSE_WINDOW_DEG = 0.05; // ~5km bbox prefilter for nearest-neighbour

// Synthetic region for the bundled coarse world index. Whole-planet bbox so it's a
// candidate everywhere; kept out of reverse (it answers forward search only).
const WORLD_REGION = "world";
const WORLD_BBOX: [number, number, number, number] = [-180, -90, 180, 90];

// Viewport-bias tuning (added to the rank score, where lower is better). The
// distance penalty is normalised by the viewport's squared half-span, so a feature
// at the viewport edge is penalised by ~WEIGHT regardless of zoom — a fixed
// multiplier on raw degrees would swamp bm25 when zoomed out and vanish when zoomed
// in. WEIGHT is sized against the importance term (`importance * 4`). The penalty
// saturates at CAP beyond the viewport so a far, strong text match can still win
// (e.g. searching a place name on the far side of the world).
const VIEWPORT_BIAS_WEIGHT = 4.0;
const VIEWPORT_BIAS_CAP = 8.0;

type FeatureRow = {
  id: number;
  name: string;
  class: string | null;
  category: string | null;
  kind: string;
  admin_context: string | null;
  address: string | null;
  lat: number;
  lng: number;
  bbox_min_lng: number | null;
  bbox_min_lat: number | null;
  bbox_max_lng: number | null;
  bbox_max_lat: number | null;
};

// Columns every query returns, shared by both search paths and reverse.
const FEATURE_COLS =
  "f.id, f.name, f.class, f.category, f.kind, f.admin_context, f.address, f.lat, f.lng, " +
  "f.bbox_min_lng, f.bbox_min_lat, f.bbox_max_lng, f.bbox_max_lat";

// One read-only connection per file path, reused across queries.
const connections = new Map<string, Database.Database>();

function getDb(path: string): Database.Database {
  let db = connections.get(path);
  if (!db || !db.open) {
    db = new Database(path, { readonly: true, fileMustExist: true });
    connections.set(path, db);
  }
  return db;
}

/** Close cached handles — call when the active region changes. */
export function closeOfflineGeocodeConnections(): void {
  for (const db of connections.values()) db.close();
  connections.clear();
}

/**
 * Turn free text into a safe FTS5 MATCH expression: each word becomes a quoted
 * token (quoting neutralises FTS operator characters), and the last token gets a
 * prefix `*` so search-as-you-type works.
 */
function buildMatch(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
}

/**
 * Append an `AND <column> IN (@p0, @p1, ...)` fragment for an optional list
 * filter (categories/kinds), binding values as named params. Returns "" when the
 * filter is absent so it can be spliced into the WHERE clause unconditionally.
 */
function inFilter(
  column: string,
  values: string[] | undefined,
  prefix: string,
  params: Record<string, unknown>
): string {
  if (!values?.length) return "";
  const names = values.map((v, i) => {
    params[`${prefix}${i}`] = v;
    return `@${prefix}${i}`;
  });
  return ` AND ${column} IN (${names.join(", ")})`;
}

/**
 * Dedup key for collapsing the same place returned by a pack and the world index.
 * Folds case + diacritics to match the FTS tokenizer (`remove_diacritics`), so the
 * pack's local name ("Montréal") and the world index's English name ("Montreal")
 * collapse to one row; the ~10 km grid keeps distinct same-named places apart.
 */
function dedupeKey(name: string, lat: number, lng: number): string {
  const folded = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  return `${folded}|${Math.round(lat * 10)}|${Math.round(lng * 10)}`;
}

function rowToResult(row: FeatureRow, region: string): GeocodeResult {
  // Street line (own addr:* tags) + admin hierarchy, e.g. "Skalitzer Str. 12, Kreuzberg,
  // Berlin, Germany". Falls back to the pack region when the pack carries neither — but
  // the world index's "region" is a sentinel, not a place, so it shows nothing instead.
  const fallback = region === WORLD_REGION ? "" : region;
  const secondary = [row.address, row.admin_context].filter(Boolean).join(", ") || fallback;
  const result: GeocodeResult = {
    // Region-qualified so rowids from different packs don't collide.
    id: `offline:${region}:${row.id}`,
    lat: row.lat,
    lng: row.lng,
    primaryLabel: row.name,
    // Drop a secondary that just repeats the name (e.g. the city-state "Monaco", whose
    // only context is the country "Monaco") — same as Photon's same-as-primary skip.
    secondaryLabel: secondary.toLowerCase() === row.name.toLowerCase() ? "" : secondary
  };
  // Prefer the normalized category (v2 packs) over the raw OSM class.
  const category = row.category ?? row.class;
  if (category) result.categories = [category];
  // Geometry extent for zoom-to-fit; skip degenerate (point-feature) boxes.
  if (
    row.bbox_min_lng != null &&
    row.bbox_min_lat != null &&
    row.bbox_max_lng != null &&
    row.bbox_max_lat != null &&
    (row.bbox_max_lng > row.bbox_min_lng || row.bbox_max_lat > row.bbox_min_lat)
  ) {
    result.bbox = {
      west: row.bbox_min_lng,
      south: row.bbox_min_lat,
      east: row.bbox_max_lng,
      north: row.bbox_max_lat
    };
  }
  return result;
}

async function forward(
  req: GeocodeForwardRequest,
  ep: Endpoint,
  _ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  const match = buildMatch(req.query ?? "");
  // Structured filters can stand alone ("all cafes in the viewport", no text).
  const hasFilters = Boolean(req.categories?.length || req.kinds?.length);
  if (!match && !hasFilters) return [];
  const limit = req.limit ?? DEFAULT_LIMIT;
  const regions = listInstalledRegions(ep.url).filter((r) => r.geocode);
  // Append the bundled coarse world index (countries + major cities) as an
  // always-available fallback, last so pack rows rank/dedup ahead of it. Skipped
  // when the file is absent (older build / dev before `make bundle-world`).
  if (ep.worldGeocode && existsSync(ep.worldGeocode)) {
    regions.push({ region: WORLD_REGION, dir: "", geocode: ep.worldGeocode, bbox: WORLD_BBOX });
  }
  if (regions.length === 0) return [];

  // Viewport bias: when a bbox is supplied, nudge ranking toward its centre with a
  // zoom-normalised, saturating squared-degree distance term (cheap, monotonic, only
  // min() — see the tuning constants above).
  const params: Record<string, unknown> = { limit };
  let distanceTerm = "";
  if (req.bbox) {
    const { west, south, east, north } = req.bbox;
    const halfLat = (north - south) / 2;
    const halfLng = (east - west) / 2;
    const span2 = halfLat * halfLat + halfLng * halfLng;
    params.clng = (west + east) / 2;
    params.clat = (south + north) / 2;
    params.bias = span2 > 0 ? VIEWPORT_BIAS_WEIGHT / span2 : 0;
    params.biasCap = VIEWPORT_BIAS_CAP;
    distanceTerm =
      "+ min(((f.lat - @clat)*(f.lat - @clat) + (f.lng - @clng)*(f.lng - @clng)) * @bias, @biasCap)";
  }

  // Structured filters (normalized category ids / feature kinds) gate the row set
  // on both paths; ranking is unchanged. Old (v1) packs lack `category` — their
  // per-pack try/catch below just skips them when a category filter is present.
  const filterSql =
    inFilter("f.category", req.categories, "cat", params) +
    inFilter("f.kind", req.kinds, "kind", params);

  // `score` is selected (not just ordered by) so we can merge-rank across packs —
  // lower is better. Each DB returns its own top `limit`, which is enough to
  // contain the global top `limit`.
  let sql: string;
  if (match) {
    params.match = match;
    // Exact-name boost: the normalised whole query (same tokenisation as buildMatch,
    // joined by spaces). When it equals a feature's name, that feature gets a large score
    // bonus so the canonical place ("Berlin") beats partial-token matches ("Berliner
    // Straße") — including across packs, where raw bm25 scores aren't comparable.
    params.exact = ((req.query ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
    sql = `SELECT ${FEATURE_COLS},
       (bm25(features_fts) - f.importance * 4.0
         - (CASE WHEN lower(f.name) = @exact THEN 8.0 ELSE 0 END)
         ${distanceTerm}) AS score
     FROM features_fts
     JOIN features f ON f.id = features_fts.rowid
     WHERE features_fts MATCH @match${filterSql}
     ORDER BY score
     LIMIT @limit`;
  } else {
    // Pure structured search (no text): FTS5 MATCH needs a query, so rank the
    // filtered set by importance + viewport proximity instead. The saturating
    // distance term (cap 8) dominates POI importance (~1.2), so with a bbox this
    // is effectively "nearest matching POIs"; without one it's "most important".
    sql = `SELECT ${FEATURE_COLS},
       (- f.importance * 4.0 ${distanceTerm}) AS score
     FROM features f
     WHERE 1=1${filterSql}
     ORDER BY score
     LIMIT @limit`;
  }

  const merged: Array<{ row: FeatureRow & { score: number }; region: string }> = [];
  for (const r of regions) {
    try {
      const rows = getDb(r.geocode as string).prepare(sql).all(params) as Array<
        FeatureRow & { score: number }
      >;
      for (const row of rows) merged.push({ row, region: r.region });
    } catch {
      /* skip a corrupt/locked pack rather than failing the whole search */
    }
  }
  merged.sort((a, b) => a.row.score - b.row.score);
  // A place a pack covers in detail also exists in the coarse world index (the same
  // city). Collapse such duplicates on a ~10 km grid, preferring the pack row so a
  // downloaded region's "Berlin" wins over the world fallback's. Same-named places
  // far apart (London UK vs London ON) fall in different cells and both survive.
  const deduped: typeof merged = [];
  const slot = new Map<string, number>();
  for (const m of merged) {
    const key = dedupeKey(m.row.name, m.row.lat, m.row.lng);
    const at = slot.get(key);
    if (at === undefined) {
      slot.set(key, deduped.length);
      deduped.push(m);
    } else if (deduped[at].region === WORLD_REGION && m.region !== WORLD_REGION) {
      deduped[at] = m; // swap the world fallback out for the detailed pack feature
    }
  }
  return deduped.slice(0, limit).map(({ row, region }) => rowToResult(row, region));
}

async function reverse(
  req: GeocodeReverseRequest,
  ep: Endpoint,
  _ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  const limit = req.limit ?? 1;
  const withGeocode = listInstalledRegions(ep.url).filter((r) => r.geocode);
  // Only packs whose bbox covers the point can answer "what's here".
  const candidates = regionsContaining(withGeocode, req.point.lng, req.point.lat).filter(
    (r) => r.geocode
  );
  if (candidates.length === 0) return [];

  // Optional category/kind filters turn "what's here" into "what restaurants are here".
  const params: Record<string, unknown> = {
    lat: req.point.lat,
    lng: req.point.lng,
    win: REVERSE_WINDOW_DEG,
    limit
  };
  const filterSql =
    inFilter("f.category", req.categories, "cat", params) +
    inFilter("f.kind", req.kinds, "kind", params);

  const sql = `SELECT ${FEATURE_COLS},
       ((f.lat - @lat)*(f.lat - @lat) + (f.lng - @lng)*(f.lng - @lng)) AS dist
     FROM features_rtree r
     JOIN features f ON f.id = r.id
     WHERE r.min_lng BETWEEN @lng - @win AND @lng + @win
       AND r.min_lat BETWEEN @lat - @win AND @lat + @win${filterSql}
     ORDER BY dist
     LIMIT @limit`;

  const merged: Array<{ row: FeatureRow & { dist: number }; region: string }> = [];
  for (const r of candidates) {
    try {
      const rows = getDb(r.geocode as string).prepare(sql).all(params) as Array<
        FeatureRow & { dist: number }
      >;
      for (const row of rows) merged.push({ row, region: r.region });
    } catch {
      /* skip a corrupt/locked pack */
    }
  }
  merged.sort((a, b) => a.row.dist - b.row.dist);
  return merged.slice(0, limit).map(({ row, region }) => rowToResult(row, region));
}

export const offlineGeocoding: GeocodingCapability = { forward, reverse };
