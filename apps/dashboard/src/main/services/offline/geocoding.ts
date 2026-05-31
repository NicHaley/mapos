import type {
  Endpoint,
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest
} from "@mapos/contracts";
import type { AdapterContext, GeocodingCapability } from "@mapos/service-adapters";
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
  kind: string;
  admin_context: string | null;
  address: string | null;
  lat: number;
  lng: number;
};

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

function rowToResult(row: FeatureRow, region: string): GeocodeResult {
  const result: GeocodeResult = {
    // Region-qualified so rowids from different packs don't collide.
    id: `offline:${region}:${row.id}`,
    lat: row.lat,
    lng: row.lng,
    primaryLabel: row.name,
    // Street line (own addr:* tags) + admin hierarchy, e.g. "Skalitzer Str. 12,
    // Kreuzberg, Berlin". Falls back to the pack region when the pack carries neither.
    secondaryLabel: [row.address, row.admin_context].filter(Boolean).join(", ") || region
  };
  if (row.class) result.categories = [row.class];
  return result;
}

async function forward(
  req: GeocodeForwardRequest,
  ep: Endpoint,
  _ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  const match = buildMatch(req.query);
  if (!match) return [];
  const limit = req.limit ?? DEFAULT_LIMIT;
  const regions = listInstalledRegions(ep.url).filter((r) => r.geocode);
  if (regions.length === 0) return [];

  // Exact-name boost: the normalised whole query (same tokenisation as buildMatch,
  // joined by spaces). When it equals a feature's name, that feature gets a large score
  // bonus so the canonical place ("Berlin") beats partial-token matches ("Berliner
  // Straße") — including across packs, where raw bm25 scores aren't comparable.
  const exact = (req.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

  // Viewport bias: when a bbox is supplied, nudge ranking toward its centre with a
  // zoom-normalised, saturating squared-degree distance term (cheap, monotonic, only
  // min() — see the tuning constants above).
  const params: Record<string, unknown> = { match, limit, exact };
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

  // `score` is selected (not just ordered by) so we can merge-rank across packs —
  // lower is better. Each DB returns its own top `limit`, which is enough to
  // contain the global top `limit`.
  const sql = `SELECT f.id, f.name, f.class, f.kind, f.admin_context, f.address, f.lat, f.lng,
       (bm25(features_fts) - f.importance * 4.0
         - (CASE WHEN lower(f.name) = @exact THEN 8.0 ELSE 0 END)
         ${distanceTerm}) AS score
     FROM features_fts
     JOIN features f ON f.id = features_fts.rowid
     WHERE features_fts MATCH @match
     ORDER BY score
     LIMIT @limit`;

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
  return merged.slice(0, limit).map(({ row, region }) => rowToResult(row, region));
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

  const sql = `SELECT f.id, f.name, f.class, f.kind, f.admin_context, f.address, f.lat, f.lng,
       ((f.lat - @lat)*(f.lat - @lat) + (f.lng - @lng)*(f.lng - @lng)) AS dist
     FROM features_rtree r
     JOIN features f ON f.id = r.id
     WHERE r.min_lng BETWEEN @lng - @win AND @lng + @win
       AND r.min_lat BETWEEN @lat - @win AND @lat + @win
     ORDER BY dist
     LIMIT @limit`;
  const params = { lat: req.point.lat, lng: req.point.lng, win: REVERSE_WINDOW_DEG, limit };

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
