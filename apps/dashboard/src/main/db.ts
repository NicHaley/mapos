import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Inline DDL — CURRENT_SCHEMA_VERSION must be bumped on any schema change
const CURRENT_SCHEMA_VERSION = 1;

export const features = sqliteTable("features", {
  rowid: integer("rowid").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  file_path: text("file_path").notNull(),
  geometry_type: text("geometry_type").notNull(),
  geometry: text("geometry").notNull(),
  title: text("title"),
  status: text("status"),
  tags: text("tags"),
  indexed_at: text("indexed_at").notNull()
});

const schema = { features };

function applyMigrations(sqlite: Database.Database): void {
  const row = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version >= CURRENT_SCHEMA_VERSION) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS features (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL UNIQUE,
      geometry_type TEXT NOT NULL,
      geometry TEXT NOT NULL,
      title TEXT,
      status TEXT,
      tags TEXT,
      indexed_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS features_rtree USING rtree(
      id, min_lat, max_lat, min_lng, max_lng
    );
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
  id: string;
  file_path: string;
  geometry_type: string;
  geometry: string;
  title: string | null;
  status: string | null;
  tags: string[] | null;
}

export interface PlaceRecord {
  id: string;
  lat: number;
  lng: number;
  title: string;
  status: string;
  type: string;
  category?: string;
  tags?: string[];
  filePath: string;
}

export function indexFeature(record: PlaceRecord): void {
  const db = getDb();
  const sqlite = getSqlite();
  const geometry = JSON.stringify({ type: "Point", coordinates: [record.lng, record.lat] });
  const tagsJson = record.tags ? JSON.stringify(record.tags) : null;
  const now = new Date().toISOString();

  const [row] = db
    .insert(features)
    .values({
      id: record.id,
      file_path: record.filePath,
      geometry_type: "point",
      geometry,
      title: record.title,
      status: record.status,
      tags: tagsJson,
      indexed_at: now
    })
    .onConflictDoUpdate({
      target: features.file_path,
      set: {
        id: sql`excluded.id`,
        geometry_type: sql`excluded.geometry_type`,
        geometry: sql`excluded.geometry`,
        title: sql`excluded.title`,
        status: sql`excluded.status`,
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
    .run(row.rowid, record.lat, record.lat, record.lng, record.lng);
}

/** Remove features whose file_path is not in the places Map (e.g. deleted while app was closed). Returns count removed. */
export function reconcileIndexWithPlaces(places: Map<string, PlaceRecord>): number {
  const db = getDb();
  const rows = db.select({ file_path: features.file_path }).from(features).all();
  let count = 0;
  for (const r of rows) {
    if (!places.has(r.file_path)) {
      removeFeature(r.file_path);
      count++;
    }
  }
  return count;
}

export function removeFeature(filePath: string): void {
  const db = getDb();
  const sqlite = getSqlite();

  const [row] = db
    .select({ rowid: features.rowid })
    .from(features)
    .where(eq(features.file_path, filePath))
    .all();

  if (!row) return;
  sqlite.prepare("DELETE FROM features_rtree WHERE id = ?").run(row.rowid);
  db.delete(features).where(eq(features.file_path, filePath)).run();
}

export function querySpatialIndex(
  bounds: Bounds,
  filters?: { status?: string; tags?: string[] }
): FeatureRecord[] {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(`
    SELECT f.id, f.file_path, f.geometry_type, f.geometry, f.title, f.status, f.tags
    FROM features f
    JOIN features_rtree r ON r.id = f.rowid
    WHERE r.min_lat >= ? AND r.max_lat <= ?
      AND r.min_lng >= ? AND r.max_lng <= ?
  `)
    .all(bounds.south, bounds.north, bounds.west, bounds.east) as Array<{
    id: string;
    file_path: string;
    geometry_type: string;
    geometry: string;
    title: string | null;
    status: string | null;
    tags: string | null;
  }>;

  return rows
    .filter((r) => !filters?.status || r.status === filters.status)
    .filter((r) => {
      if (!filters?.tags?.length) return true;
      const rowTags: string[] = r.tags ? JSON.parse(r.tags) : [];
      return filters.tags?.every((t) => rowTags.includes(t));
    })
    .map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : null }));
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
  let count = 0;
  for (const record of places.values()) {
    indexFeature(record);
    count++;
  }
  return count;
}
