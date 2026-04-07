import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bbox } from "@turf/bbox";
import Database from "better-sqlite3";
import { count, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { PlaceRecord } from "../shared/types";
import { RESERVED_PROPERTY_KEYS } from "../shared/types";

// Inline DDL — CURRENT_SCHEMA_VERSION must be bumped on any schema change
const CURRENT_SCHEMA_VERSION = 3;

export const features = sqliteTable("features", {
  rowid: integer("rowid").primaryKey({ autoIncrement: true }),
  file_path: text("file_path").notNull(),
  geometry_type: text("geometry_type").notNull(),
  geometry: text("geometry").notNull(),
  color: text("color"),
  indexed_at: text("indexed_at").notNull()
});

const schema = { features };

function applyMigrations(sqlite: Database.Database): void {
  const row = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version >= CURRENT_SCHEMA_VERSION) return;

  if (row.user_version === 0) {
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
    `);
  }

  if (row.user_version < 2) {
    // Upgrading from v1: add color column (status column left in place, no longer used)
    try { sqlite.exec("ALTER TABLE features ADD COLUMN color TEXT"); } catch { /* already exists */ }
  }

  if (row.user_version < 3) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS feature_properties (
        feature_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (feature_id, key, value)
      );
      CREATE INDEX IF NOT EXISTS idx_fp_key_value ON feature_properties(key, value);
      CREATE INDEX IF NOT EXISTS idx_fp_feature ON feature_properties(feature_id);
    `);
  }

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
  const withGeo = records.filter((r): r is PlaceRecord & { geometry: string } => Boolean(r.geometry));
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
    .prepare(`INSERT OR REPLACE INTO features_rtree (id,min_lat,max_lat,min_lng,max_lng) VALUES ${placeholders}`)
    .run(...params);
}

export function removeFeatures(filePaths: string[]): void {
  if (filePaths.length === 0) return;
  const db = getDb();
  const sqlite = getSqlite();
  const placeholders = filePaths.map(() => "?").join(",");
  sqlite
    .prepare(`DELETE FROM features_rtree WHERE id IN (SELECT rowid FROM features WHERE file_path IN (${placeholders}))`)
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
    const prefix = filters.folderPath.endsWith("/")
      ? filters.folderPath
      : `${filters.folderPath}/`;
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
  const sqlite = getSqlite();
  const del = sqlite.prepare("DELETE FROM feature_properties WHERE feature_id = ?");
  const ins = sqlite.prepare(
    "INSERT OR IGNORE INTO feature_properties (feature_id, key, value) VALUES (?, ?, ?)"
  );
  const run = sqlite.transaction(() => {
    del.run(featureId);
    for (const [k, v] of Object.entries(data)) {
      if (reservedFrontmatterKeys.has(k)) continue;
      if (typeof v === "string") {
        const t = v.trim();
        if (t) ins.run(featureId, k, t);
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === "string") {
            const t = item.trim();
            if (t) ins.run(featureId, k, t);
          }
        }
      }
    }
  });
  run();
}

export function removeFeaturePropertiesForFile(featureId: string): void {
  const sqlite = getSqlite();
  sqlite.prepare("DELETE FROM feature_properties WHERE feature_id = ?").run(featureId);
}

/** Distinct string facet values for a frontmatter key (multi-select suggestions). */
export function queryDistinctValuesForKey(propKey: string): string[] {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      "SELECT DISTINCT value FROM feature_properties WHERE key = ? ORDER BY value COLLATE NOCASE"
    )
    .all(propKey) as Array<{ value: string }>;
  return rows.map((r) => r.value);
}

/** Remove EAV rows whose file no longer exists on disk. Returns number of rows deleted. */
export function reconcileFeatureProperties(): number {
  const sqlite = getSqlite();
  const ids = sqlite
    .prepare("SELECT DISTINCT feature_id FROM feature_properties")
    .all() as Array<{ feature_id: string }>;
  const del = sqlite.prepare("DELETE FROM feature_properties WHERE feature_id = ?");
  let deleted = 0;
  for (const { feature_id } of ids) {
    if (!existsSync(feature_id)) {
      const r = del.run(feature_id);
      deleted += r.changes;
    }
  }
  return deleted;
}
