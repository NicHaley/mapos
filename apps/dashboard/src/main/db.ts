import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bbox } from "@turf/bbox";
import Database from "better-sqlite3";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { PlaceRecord } from "../shared/types";
import { RESERVED_PROPERTY_KEYS } from "../shared/types";

/** Bump when the DDL below changes; local dev — no incremental upgrades. */
const CURRENT_SCHEMA_VERSION = 1;

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
    value: text("value").notNull()
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
  if (row.user_version >= CURRENT_SCHEMA_VERSION) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS features (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      geometry_type TEXT NOT NULL,
      geometry TEXT NOT NULL,
      color TEXT,
      indexed_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS features_rtree USING rtree(
      id, min_lat, max_lat, min_lng, max_lng
    );
    CREATE TABLE IF NOT EXISTS feature_properties (
      feature_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (feature_id, key, value)
    );
    CREATE INDEX IF NOT EXISTS idx_fp_key_value ON feature_properties(key, value);
    CREATE INDEX IF NOT EXISTS idx_fp_feature ON feature_properties(feature_id);
  `);

  sqlite.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
}

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function initDb(maposDir: string): void {
  const dotMapos = join(maposDir, ".mapos");
  if (!existsSync(dotMapos)) mkdirSync(dotMapos, { recursive: true });
  const dbPath = join(dotMapos, "index.db");
  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  applyMigrations(_sqlite);
  _db = drizzle(_sqlite, { schema });
}

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) throw new Error("DB not initialised — call initDb() first");
  return _db;
}

function getSqlite(): Database.Database {
  if (!_sqlite) throw new Error("DB not initialised — call initDb() first");
  return _sqlite;
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

/** Remove features whose file_path is not in the places Map (e.g. deleted while app was closed). Returns count removed. */
export function reconcileIndexWithPlaces(places: Map<string, PlaceRecord>): number {
  const db = getDb();
  const rows = db.select({ file_path: features.file_path }).from(features).all();
  const stale = rows.filter((r) => !places.has(r.file_path)).map((r) => r.file_path);
  removeFeatures(stale);
  return stale.length;
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

export function querySpatialIndex(
  bounds: Bounds,
  filters?: { properties?: Record<string, string[]>; folderPath?: string }
): FeatureRecord[] {
  const sqlite = getSqlite();

  let sqlStr = `
    SELECT f.file_path, f.geometry_type, f.geometry, f.color
    FROM features f
    JOIN features_rtree r ON r.id = f.rowid
    WHERE r.min_lat <= ? AND r.max_lat >= ?
      AND r.min_lng <= ? AND r.max_lng >= ?
  `;
  const params: unknown[] = [bounds.north, bounds.south, bounds.east, bounds.west];

  if (filters?.folderPath) {
    const prefix = filters.folderPath.endsWith("/") ? filters.folderPath : `${filters.folderPath}/`;
    sqlStr += " AND f.file_path LIKE ?";
    params.push(`${prefix}%`);
  }

  if (filters?.properties) {
    for (const [key, values] of Object.entries(filters.properties)) {
      if (!values.length) continue;
      const placeholders = values.map(() => "?").join(",");
      sqlStr += ` AND (SELECT COUNT(DISTINCT value) FROM feature_properties WHERE feature_id = f.file_path AND key = ? AND value IN (${placeholders})) = ?`;
      params.push(key, ...values, values.length);
    }
  }

  const rows = sqlite.prepare(sqlStr).all(...params) as Array<{
    file_path: string;
    geometry_type: string;
    geometry: string;
    color: string | null;
  }>;

  return rows.map((r) => ({ ...r }));
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
      let inserted = false;
      for (const item of Array.isArray(v) ? v : [v]) {
        const s = toStr(item);
        if (s) {
          tx.insert(featureProperties).values({ feature_id: featureId, key: k, value: s }).onConflictDoNothing().run();
          inserted = true;
        }
      }
      // Key exists but has no indexable values — sentinel row so the key remains discoverable
      if (!inserted) {
        tx.insert(featureProperties).values({ feature_id: featureId, key: k, value: "" }).onConflictDoNothing().run();
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
