import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bbox } from "@turf/bbox";
import { booleanIntersects } from "@turf/boolean-intersects";
import { centroid } from "@turf/centroid";
import { distance } from "@turf/distance";
import { point, polygon } from "@turf/helpers";
import Database from "better-sqlite3";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { inferPropertyType } from "../shared/property-inference";
import type { PlaceRecord, PropertyType } from "../shared/types";
import { RESERVED_PROPERTY_KEYS } from "../shared/types";

/**
 * Canonical DDL for the spatial index cache. This string is the single source
 * of truth for migrations: a hash of it drives `applyMigrations`, so any edit
 * here triggers a full DROP+CREATE on next launch and the watcher's initial
 * scan repopulates everything from the vault.
 *
 * INVARIANT: nothing in this DB may be non-derivable from vault files. Adding a
 * table that stores user-generated state (chat history, undo stack, etc.) will
 * cause that state to be silently nuked on the next schema change. If we need
 * to store non-derivable state, switch this to a real migration tool
 * (drizzle-kit) first.
 *
 * If re-indexing becomes too slow, we can switch to a real migration tool
 * (drizzle-kit).
 */
const SCHEMA_DDL = `
  CREATE TABLE features (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    geometry_type TEXT NOT NULL,
    geometry TEXT NOT NULL,
    color TEXT,
    indexed_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE features_rtree USING rtree(
    id, min_lat, max_lat, min_lng, max_lng
  );
  CREATE TABLE feature_properties (
    feature_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    type TEXT NOT NULL,
    PRIMARY KEY (feature_id, key, value)
  );
  CREATE INDEX idx_fp_key_value ON feature_properties(key, value);
  CREATE INDEX idx_fp_feature ON feature_properties(feature_id);
`;

const SCHEMA_FINGERPRINT = createHash("sha256").update(SCHEMA_DDL).digest().readInt32BE(0);

export const features = sqliteTable("features", {
  rowid: integer("rowid").primaryKey({ autoIncrement: true }),
  file_path: text("file_path").notNull().unique(),
  geometry_type: text("geometry_type").notNull(),
  geometry: text("geometry").notNull(),
  color: text("color"),
  indexed_at: text("indexed_at").notNull()
});

export const featureProperties = sqliteTable(
  "feature_properties",
  {
    feature_id: text("feature_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    type: text("type").$type<PropertyType>().notNull()
  },
  (t) => [
    primaryKey({ columns: [t.feature_id, t.key, t.value] }),
    index("idx_fp_key_value").on(t.key, t.value),
    index("idx_fp_feature").on(t.feature_id)
  ]
);

const schema = { features, featureProperties };

function applyMigrations(sqlite: Database.Database): void {
  const row = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version === SCHEMA_FINGERPRINT) return;

  sqlite.exec(`
    DROP TABLE IF EXISTS features;
    DROP TABLE IF EXISTS features_rtree;
    DROP TABLE IF EXISTS feature_properties;
  `);
  sqlite.exec(SCHEMA_DDL);
  sqlite.exec(`PRAGMA user_version = ${SCHEMA_FINGERPRINT}`);
}

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
// Separate read-only connection used by `runReadonlyQuery` (the agent's spatial_sql
// tool). Lazily opened, and torn down on every init/close so it can never stay pinned
// to a previous vault's index.db (initDb runs on vault switch WITHOUT a preceding closeDb).
let _sqliteRO: Database.Database | null = null;

/** @param appStateDir Electron `app.getPath("userData")` (MapOS app data), not the vault root. */
export function initDb(appStateDir: string): void {
  // Drop any RO connection from a prior vault before swapping the write connection.
  _sqliteRO?.close();
  _sqliteRO = null;
  if (!existsSync(appStateDir)) mkdirSync(appStateDir, { recursive: true });
  const dbPath = join(appStateDir, "index.db");
  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  applyMigrations(_sqlite);
  _db = drizzle(_sqlite, { schema });
}

export function closeDb(): void {
  _sqlite?.close();
  _sqliteRO?.close();
  _sqlite = null;
  _sqliteRO = null;
  _db = null;
}

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) throw new Error("DB not initialised — call initDb() first");
  return _db;
}

function getSqlite(): Database.Database {
  if (!_sqlite) throw new Error("DB not initialised — call initDb() first");
  return _sqlite;
}

/**
 * Dedicated read-only connection to the same index.db as the write connection.
 * The `readonly` flag is the real guarantee — any write/DDL fails with SQLITE_READONLY
 * regardless of how the SQL parses. `query_only` + `trusted_schema = OFF` are defence in
 * depth. The path comes from the live write connection so it always matches the active vault.
 */
function getSqliteRO(): Database.Database {
  if (_sqliteRO) return _sqliteRO;
  const ro = new Database(getSqlite().name, { readonly: true, timeout: 3000 });
  ro.pragma("query_only = ON");
  ro.pragma("trusted_schema = OFF");
  _sqliteRO = ro;
  return ro;
}

export interface ReadonlyQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

const CELL_CHAR_CAP = 2000;

/** Keep cell values JSON-safe and bounded. Table columns are already string|number|null;
 *  this guards against expressions producing a BigInt/BLOB and against a large `geometry`
 *  GeoJSON string blowing up the agent's context. */
function sanitizeCell(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  if (typeof v === "string" && v.length > CELL_CHAR_CAP) {
    return `${v.slice(0, CELL_CHAR_CAP)}…[truncated, ${v.length} chars]`;
  }
  return v;
}

/**
 * Run a single read-only SELECT against the spatial index on a dedicated read-only
 * connection (see `getSqliteRO`). `prepare` throws on multi-statement input, and a
 * non-read-only statement (ATTACH/PRAGMA-write) is rejected early. Output rows and
 * per-cell size are capped to keep the payload bounded.
 */
export function runReadonlyQuery(query: string, rowCap = 1000): ReadonlyQueryResult {
  const stmt = getSqliteRO().prepare(query);
  if (!stmt.readonly) throw new Error("Only read-only SELECT queries are allowed.");

  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
    if (rows.length >= rowCap) {
      truncated = true;
      break;
    }
    const clean: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(row)) clean[k] = sanitizeCell(val);
    rows.push(clean);
  }
  return { rows, rowCount: rows.length, truncated };
}

export type Bounds = { north: number; south: number; east: number; west: number };

export interface FeatureRecord {
  file_path: string;
  geometry_type: string;
  geometry: string;
  color: string | null;
}

export type { PlaceRecord };

export function indexFeature(record: PlaceRecord): void {
  if (!record.geometry) return;
  const db = getDb();
  const sqlite = getSqlite();
  const geoObj = JSON.parse(record.geometry);
  const geometryType = (geoObj.type as string).toLowerCase();
  const now = new Date().toISOString();
  const [minLng, minLat, maxLng, maxLat] = bbox(geoObj);

  const [row] = db
    .insert(features)
    .values({
      file_path: record.filePath,
      geometry_type: geometryType,
      geometry: record.geometry,
      color: record.color ?? null,
      indexed_at: now
    })
    .onConflictDoUpdate({
      target: features.file_path,
      set: {
        geometry_type: sql`excluded.geometry_type`,
        geometry: sql`excluded.geometry`,
        color: sql`excluded.color`,
        indexed_at: sql`excluded.indexed_at`
      }
    })
    .returning({ rowid: features.rowid })
    .all();

  sqlite
    .prepare(
      "INSERT OR REPLACE INTO features_rtree (id, min_lat, max_lat, min_lng, max_lng) VALUES (?,?,?,?,?)"
    )
    .run(row.rowid, minLat, maxLat, minLng, maxLng);
}

/**
 * Remove features rows that no longer reflect their file's current state:
 * file is gone from the places Map, or the place exists but has no geometry.
 * Returns count removed.
 */
export function reconcileIndexWithPlaces(places: Map<string, PlaceRecord>): number {
  const db = getDb();
  const rows = db.select({ file_path: features.file_path }).from(features).all();
  const stale = rows
    .filter((r) => {
      const place = places.get(r.file_path);
      return !place || !place.geometry;
    })
    .map((r) => r.file_path);
  removeFeatures(stale);
  return stale.length;
}

/**
 * Canonical way to keep the features table in sync with a file's current state.
 * Upserts if the record has geometry; deletes any existing row otherwise.
 * Use this at every non-watcher write site — calling `indexFeatures([record])` alone
 * silently leaves a stale row behind when geometry has been cleared.
 */
export function syncFeatureForFile(filePath: string, record: PlaceRecord | null): void {
  if (record?.geometry) {
    indexFeatures([record]);
  } else {
    removeFeatures([filePath]);
  }
}

export function indexFeatures(records: PlaceRecord[]): void {
  const withGeo = records.filter((r): r is PlaceRecord & { geometry: string } =>
    Boolean(r.geometry)
  );
  if (withGeo.length === 0) return;
  const db = getDb();
  const sqlite = getSqlite();
  const now = new Date().toISOString();

  const rows = db
    .insert(features)
    .values(
      withGeo.map((r) => {
        const geoObj = JSON.parse(r.geometry);
        return {
          file_path: r.filePath,
          geometry_type: (geoObj.type as string).toLowerCase(),
          geometry: r.geometry,
          color: r.color ?? null,
          indexed_at: now
        };
      })
    )
    .onConflictDoUpdate({
      target: features.file_path,
      set: {
        geometry_type: sql`excluded.geometry_type`,
        geometry: sql`excluded.geometry`,
        color: sql`excluded.color`,
        indexed_at: sql`excluded.indexed_at`
      }
    })
    .returning({ rowid: features.rowid, file_path: features.file_path })
    .all();

  const byFilePath = new Map(withGeo.map((r) => [r.filePath, r]));
  const placeholders = rows.map(() => "(?,?,?,?,?)").join(",");
  const params = rows.flatMap((row) => {
    const r = byFilePath.get(row.file_path);
    if (!r) return [];
    const [minLng, minLat, maxLng, maxLat] = bbox(JSON.parse(r.geometry));
    return [row.rowid, minLat, maxLat, minLng, maxLng];
  });
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO features_rtree (id,min_lat,max_lat,min_lng,max_lng) VALUES ${placeholders}`
    )
    .run(...params);
}

export function removeFeatures(filePaths: string[]): void {
  if (filePaths.length === 0) return;
  const db = getDb();
  const sqlite = getSqlite();
  const placeholders = filePaths.map(() => "?").join(",");
  sqlite
    .prepare(
      `DELETE FROM features_rtree WHERE id IN (SELECT rowid FROM features WHERE file_path IN (${placeholders}))`
    )
    .run(...filePaths);
  db.delete(features).where(inArray(features.file_path, filePaths)).run();
}

export type SpatialFilters = { properties?: Record<string, string[]>; folderPath?: string };

/**
 * Shared candidate selection for all spatial queries: an optional rtree bbox prefilter plus
 * the folder/property attribute filters. `queryNear`/`queryWithinPolygon` pass a bbox derived
 * from their radius/polygon and then refine the result in JS with Turf. With `bounds === null`
 * there is no spatial prefilter (the filtered set is scanned).
 */
function selectCandidates(bounds: Bounds | null, filters?: SpatialFilters): FeatureRecord[] {
  const sqlite = getSqlite();
  const where: string[] = [];
  const params: unknown[] = [];
  let from = "FROM features f";

  if (bounds) {
    from += " JOIN features_rtree r ON r.id = f.rowid";
    where.push("r.min_lat <= ? AND r.max_lat >= ? AND r.min_lng <= ? AND r.max_lng >= ?");
    params.push(bounds.north, bounds.south, bounds.east, bounds.west);
  }

  if (filters?.folderPath) {
    const prefix = filters.folderPath.endsWith("/") ? filters.folderPath : `${filters.folderPath}/`;
    where.push("f.file_path LIKE ?");
    params.push(`${prefix}%`);
  }

  if (filters?.properties) {
    for (const [key, values] of Object.entries(filters.properties)) {
      if (!values.length) continue;
      const placeholders = values.map(() => "?").join(",");
      where.push(
        `(SELECT COUNT(DISTINCT value) FROM feature_properties WHERE feature_id = f.file_path AND key = ? AND value IN (${placeholders})) = ?`
      );
      params.push(key, ...values, values.length);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sqlStr = `SELECT f.file_path, f.geometry_type, f.geometry, f.color ${from} ${whereSql}`;
  const rows = sqlite.prepare(sqlStr).all(...params) as Array<{
    file_path: string;
    geometry_type: string;
    geometry: string;
    color: string | null;
  }>;
  return rows.map((r) => ({ ...r }));
}

export function querySpatialIndex(
  bounds: Bounds | null,
  filters?: SpatialFilters
): FeatureRecord[] {
  return selectCandidates(bounds, filters);
}

export interface NearResult extends FeatureRecord {
  distance_m: number;
}

/**
 * Features nearest to a point, sorted ascending by geodesic distance (meters). When `radiusM`
 * is given it is used both as an rtree bbox prefilter (a conservative degree box) and as a hard
 * cutoff after the exact Turf distance refine; without it the whole filtered set is ranked.
 * Distance is measured to each feature's centroid — exact for points, a representative-point
 * approximation for the rare line/polygon place.
 */
export function queryNear(
  origin: { lat: number; lng: number; radiusM?: number; limit?: number },
  filters?: SpatialFilters
): NearResult[] {
  const { lat, lng, radiusM, limit = 20 } = origin;

  let bounds: Bounds | null = null;
  if (radiusM != null) {
    const dLat = radiusM / 111320;
    const dLng = radiusM / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));
    bounds = { north: lat + dLat, south: lat - dLat, east: lng + dLng, west: lng - dLng };
  }

  const from = point([lng, lat]);
  const scored: NearResult[] = [];
  for (const c of selectCandidates(bounds, filters)) {
    try {
      const d = distance(from, centroid(JSON.parse(c.geometry)), { units: "meters" });
      if (radiusM != null && d > radiusM) continue;
      scored.push({ ...c, distance_m: Math.round(d) });
    } catch {
      // skip unparseable geometry
    }
  }
  scored.sort((a, b) => a.distance_m - b.distance_m);
  return scored.slice(0, limit);
}

/**
 * Features that intersect a polygon region. The polygon's bbox is the rtree prefilter; each
 * candidate is then refined with `booleanIntersects`, which is correct for point/line/polygon
 * features alike. Open rings are closed automatically.
 */
export function queryWithinPolygon(
  coordinates: number[][][],
  filters?: SpatialFilters
): FeatureRecord[] {
  const rings = coordinates.map((ring) => {
    if (ring.length < 2) return ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) return ring;
    const closed = first[0] === last[0] && first[1] === last[1];
    return closed ? ring : [...ring, first];
  });
  const poly = polygon(rings);
  const [minLng, minLat, maxLng, maxLat] = bbox(poly);
  const bounds: Bounds = { north: maxLat, south: minLat, east: maxLng, west: minLng };

  return selectCandidates(bounds, filters).filter((c) => {
    try {
      return booleanIntersects(JSON.parse(c.geometry), poly);
    } catch {
      return false;
    }
  });
}

/** Stored GeoJSON-string geometry for the given vault file paths (for by-reference geometry ops). */
export function getFeatureGeometries(
  filePaths: string[]
): Array<{ file_path: string; geometry: string }> {
  if (filePaths.length === 0) return [];
  const sqlite = getSqlite();
  const placeholders = filePaths.map(() => "?").join(",");
  return sqlite
    .prepare(`SELECT file_path, geometry FROM features WHERE file_path IN (${placeholders})`)
    .all(...filePaths) as Array<{ file_path: string; geometry: string }>;
}

export function queryFolderAll(folderPath: string): FeatureRecord[] {
  const sqlite = getSqlite();
  const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  const rows = sqlite
    .prepare(
      "SELECT file_path, geometry_type, geometry, color FROM features WHERE file_path LIKE ?"
    )
    .all(`${prefix}%`) as Array<{
    file_path: string;
    geometry_type: string;
    geometry: string;
    color: string | null;
  }>;
  return rows.map((r) => ({ ...r }));
}

export function getFeatureCount(): number {
  const db = getDb();
  const [{ value }] = db.select({ value: count() }).from(features).all();
  return value;
}

export function clearAllFeatures(): void {
  const db = getDb();
  const sqlite = getSqlite();
  sqlite.exec("DELETE FROM features_rtree");
  db.delete(features).run();
}

export function rebuildIndexFromPlaces(places: Map<string, PlaceRecord>): number {
  clearAllFeatures();
  const records = [...places.values()].filter((r) => r.geometry);
  indexFeatures(records);
  return records.length;
}

const reservedFrontmatterKeys = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);

/** Replace all EAV rows for one vault file from parsed frontmatter `data`. */
export function replaceFeaturePropertiesForFile(
  featureId: string,
  data: Record<string, unknown>
): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(featureProperties).where(eq(featureProperties.feature_id, featureId)).run();
    for (const [k, v] of Object.entries(data)) {
      if (reservedFrontmatterKeys.has(k)) continue;
      const toStr = (raw: unknown): string | null => {
        if (typeof raw === "string") return raw.trim() || null;
        if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
        if (typeof raw === "boolean") return String(raw);
        return null;
      };
      // Type comes from the original (pre-stringify) value so arrays stay
      // multi_select, dates stay date, etc. — the value column loses that info.
      const type = inferPropertyType(v);
      let inserted = false;
      for (const item of Array.isArray(v) ? v : [v]) {
        const s = toStr(item);
        if (s) {
          tx.insert(featureProperties)
            .values({ feature_id: featureId, key: k, value: s, type })
            .onConflictDoNothing()
            .run();
          inserted = true;
        }
      }
      // Key exists but has no indexable values — sentinel row so the key remains discoverable
      if (!inserted) {
        tx.insert(featureProperties)
          .values({ feature_id: featureId, key: k, value: "", type })
          .onConflictDoNothing()
          .run();
      }
    }
  });
}

export function removeFeaturePropertiesForFile(featureId: string): void {
  const db = getDb();
  db.delete(featureProperties).where(eq(featureProperties.feature_id, featureId)).run();
}

/** All distinct frontmatter keys present anywhere in the vault. */
export function getAllPropertyKeys(): string[] {
  const db = getDb();
  return db
    .selectDistinct({ key: featureProperties.key })
    .from(featureProperties)
    .orderBy(asc(featureProperties.key))
    .all()
    .map((r) => r.key);
}

/**
 * Distinct property keys with their inferred type. Type is captured at index
 * time and stored on each row, so this is one indexed query — no disk reads.
 * If the same key appears with multiple types across files we just take one
 * (alphabetically first); types are consistent in practice.
 */
export function getAllPropertyKeysWithTypes(): Array<{ key: string; type: PropertyType }> {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare("SELECT key, MIN(type) AS type FROM feature_properties GROUP BY key ORDER BY key")
    .all() as Array<{ key: string; type: PropertyType }>;
  return rows;
}

/** Which of the candidate keys have zero rows in feature_properties (vault-wide). */
export function getOrphanedPropertyKeys(candidates: string[]): string[] {
  if (candidates.length === 0) return [];
  const sqlite = getSqlite();
  const placeholders = candidates.map(() => "?").join(",");
  const present = sqlite
    .prepare(`SELECT DISTINCT key FROM feature_properties WHERE key IN (${placeholders})`)
    .all(...candidates) as Array<{ key: string }>;
  const presentSet = new Set(present.map((r) => r.key));
  return candidates.filter((k) => !presentSet.has(k));
}

/** Distinct string facet values for a frontmatter key (multi-select suggestions). */
export function queryDistinctValuesForKey(propKey: string): string[] {
  const db = getDb();
  const rows = db
    .selectDistinct({ value: featureProperties.value })
    .from(featureProperties)
    .where(and(eq(featureProperties.key, propKey), ne(featureProperties.value, "")))
    .orderBy(asc(sql`${featureProperties.value} COLLATE NOCASE`))
    .all();
  return rows.map((r) => r.value);
}

/** Remove EAV rows whose file no longer exists on disk. Returns number of rows deleted. */
export function reconcileFeatureProperties(): number {
  const db = getDb();
  const ids = db
    .selectDistinct({ feature_id: featureProperties.feature_id })
    .from(featureProperties)
    .all();
  let deleted = 0;
  for (const { feature_id } of ids) {
    if (!existsSync(feature_id)) {
      const r = db
        .delete(featureProperties)
        .where(eq(featureProperties.feature_id, feature_id))
        .run();
      deleted += r.changes;
    }
  }
  return deleted;
}
