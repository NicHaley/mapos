import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bbox } from "@turf/bbox";
import Database from "better-sqlite3";
import { count, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { PlaceRecord } from "../shared/types";

// Inline DDL — CURRENT_SCHEMA_VERSION must be bumped on any schema change
const CURRENT_SCHEMA_VERSION = 2;

export const features = sqliteTable("features", {
  rowid: integer("rowid").primaryKey({ autoIncrement: true }),
  file_path: text("file_path").notNull(),
  geometry_type: text("geometry_type").notNull(),
  geometry: text("geometry").notNull(),
  color: text("color"),
  tags: text("tags"),
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
        tags TEXT,
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
  tags: string[] | null;
}

export type { PlaceRecord };

export function indexFeature(record: PlaceRecord): void {
  if (!record.geometry) return;
  const db = getDb();
  const sqlite = getSqlite();
  const geoObj = JSON.parse(record.geometry);
  const geometryType = (geoObj.type as string).toLowerCase();
  const tagsJson = record.tags ? JSON.stringify(record.tags) : null;
  const now = new Date().toISOString();
  const [minLng, minLat, maxLng, maxLat] = bbox(geoObj);

  const [row] = db
    .insert(features)
    .values({
      file_path: record.filePath,
      geometry_type: geometryType,
      geometry: record.geometry,
      color: record.color ?? null,
      tags: tagsJson,
      indexed_at: now
    })
    .onConflictDoUpdate({
      target: features.file_path,
      set: {
        geometry_type: sql`excluded.geometry_type`,
        geometry: sql`excluded.geometry`,
        color: sql`excluded.color`,
        tags: sql`excluded.tags`,
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
          tags: r.tags ? JSON.stringify(r.tags) : null,
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
        tags: sql`excluded.tags`,
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
  filters?: { tags?: string[]; folderPath?: string }
): FeatureRecord[] {
  const sqlite = getSqlite();

  let sql = `
    SELECT f.file_path, f.geometry_type, f.geometry, f.color, f.tags
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
    sql += " AND f.file_path LIKE ?";
    params.push(`${prefix}%`);
  }

  const rows = sqlite.prepare(sql).all(...params) as Array<{
    file_path: string;
    geometry_type: string;
    geometry: string;
    color: string | null;
    tags: string | null;
  }>;

  return rows
    .filter((r) => {
      if (!filters?.tags?.length) return true;
      const rowTags: string[] = r.tags ? JSON.parse(r.tags) : [];
      return filters.tags?.every((t) => rowTags.includes(t));
    })
    .map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : null }));
}

export function queryFolderAll(folderPath: string): FeatureRecord[] {
  const sqlite = getSqlite();
  const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  const rows = sqlite
    .prepare(
      "SELECT file_path, geometry_type, geometry, color, tags FROM features WHERE file_path LIKE ?"
    )
    .all(`${prefix}%`) as Array<{
    file_path: string;
    geometry_type: string;
    geometry: string;
    color: string | null;
    tags: string | null;
  }>;
  return rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : null }));
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
