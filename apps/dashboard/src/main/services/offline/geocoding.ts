import type {
  Endpoint,
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest
} from "@mapos/contracts";
import type { AdapterContext, GeocodingCapability } from "@mapos/service-adapters";
import Database from "better-sqlite3";

/**
 * Offline geocoding against a downloaded `geocode.sqlite` region pack (FTS5 +
 * R-tree, built by the pipeline). The `Endpoint.url` carries the absolute path
 * to the SQLite file rather than an HTTP URL — `resolve()` puts it there.
 *
 * Same `GeocodeResult` shape as the Photon adapter, so the renderer can't tell
 * which backend answered. Distance is computed at query time (the index is pure
 * data, intentionally portable across desktop/mobile/server).
 */

const DEFAULT_LIMIT = 8;
const REVERSE_WINDOW_DEG = 0.05; // ~5km bbox prefilter for nearest-neighbour

type FeatureRow = {
  id: number;
  name: string;
  class: string | null;
  kind: string;
  admin_context: string | null;
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

function rowToResult(row: FeatureRow): GeocodeResult {
  const result: GeocodeResult = {
    id: `offline:${row.id}`,
    lat: row.lat,
    lng: row.lng,
    primaryLabel: row.name,
    secondaryLabel: row.admin_context ?? ""
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
  const db = getDb(ep.url);

  // Viewport bias: when a bbox is supplied, nudge ranking toward its centre with
  // a squared-degree distance term (cheap, monotonic locally, no math funcs).
  const params: Record<string, unknown> = { match, limit };
  let distanceTerm = "";
  if (req.bbox) {
    const { west, south, east, north } = req.bbox;
    params.clng = (west + east) / 2;
    params.clat = (south + north) / 2;
    distanceTerm =
      "+ ((f.lat - @clat)*(f.lat - @clat) + (f.lng - @clng)*(f.lng - @clng)) * 30.0";
  }

  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.class, f.kind, f.admin_context, f.lat, f.lng
       FROM features_fts
       JOIN features f ON f.id = features_fts.rowid
       WHERE features_fts MATCH @match
       ORDER BY bm25(features_fts) - f.importance * 4.0 ${distanceTerm}
       LIMIT @limit`
    )
    .all(params) as FeatureRow[];

  return rows.map(rowToResult);
}

async function reverse(
  req: GeocodeReverseRequest,
  ep: Endpoint,
  _ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  const limit = req.limit ?? 1;
  const db = getDb(ep.url);
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.class, f.kind, f.admin_context, f.lat, f.lng
       FROM features_rtree r
       JOIN features f ON f.id = r.id
       WHERE r.min_lng BETWEEN @lng - @win AND @lng + @win
         AND r.min_lat BETWEEN @lat - @win AND @lat + @win
       ORDER BY (f.lat - @lat)*(f.lat - @lat) + (f.lng - @lng)*(f.lng - @lng)
       LIMIT @limit`
    )
    .all({
      lat: req.point.lat,
      lng: req.point.lng,
      win: REVERSE_WINDOW_DEG,
      limit
    }) as FeatureRow[];

  return rows.map(rowToResult);
}

export const offlineGeocoding: GeocodingCapability = { forward, reverse };
