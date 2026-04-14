# Database schema changes

The DB layer lives in `db.ts`. It uses **drizzle-orm** for typed queries against `better-sqlite3`, with inline DDL migrations guarded by SQLite's `user_version` pragma.

---

## How migrations work

`applyMigrations()` is called once on app start inside `initDb()`. It reads `PRAGMA user_version` and skips if the DB is already at `CURRENT_SCHEMA_VERSION`. There are no migration files — DDL is written directly in the function body.

This is intentional: MapOS is a local-first app with one DB per user machine. A version-guarded `exec` block is simpler and more reliable than a migrations folder for a single-process embedded database.

---

## Making a schema change

**1. Add your DDL to `applyMigrations()`**

The function currently handles version 0 → 1. To add a new migration:

```ts
// db.ts
const CURRENT_SCHEMA_VERSION = 3; // bump this

function applyMigrations(sqlite: Database.Database): void {
  const row = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };

  if (row.user_version < 1) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS features ( ... );
      CREATE VIRTUAL TABLE IF NOT EXISTS features_rtree USING rtree( ... );
    `);
  }

  if (row.user_version < 2) {
    sqlite.exec(`ALTER TABLE features ADD COLUMN my_new_column TEXT;`);
  }

  sqlite.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
}
```

Each `if` block is a migration step. They run in order and are skipped if the DB is already past that version.

**2. Update the drizzle schema**

Add or change columns in the `features` table definition at the top of `db.ts`:

```ts
export const features = sqliteTable("features", {
  // ... existing columns ...
  my_new_column: text("my_new_column"),
});
```

**3. Update any affected query functions**

If the new column needs to be written or read, update `indexFeature`, `querySpatialIndex`, etc. accordingly.

**4. Typecheck**

```bash
cd apps/dashboard
pnpm typecheck
```

---

## Local development

### Inspecting the live DB

```bash
cd apps/dashboard
pnpm drizzle-kit studio
```

Opens a browser-based table browser at `localhost:4983`. The DB must exist first — launch the app once so main creates it under Electron [`app.getPath('userData')`](https://www.electronjs.org/docs/latest/api/app#appgetpathname) (main calls `app.setName('MapOS')`; on macOS that is `~/Library/Application Support/MapOS/index.db`). Vault roots are listed in `mapos.json` beside it. `drizzle-kit` does not load Electron; `drizzle.config.ts` defaults to the same path, or set `MAPOS_APP_STATE_DIR` if yours differs.

### Resetting the DB during development

Delete the file and relaunch — `initDb()` recreates it from scratch:

```bash
rm ~/Library/Application\ Support/MapOS/index.db
```

### Applying your migration without launching the full app

```bash
pnpm drizzle-kit push
```

This pushes the current drizzle schema definition directly to the DB, bypassing the `user_version` guard. Useful for rapid iteration during development, but do not rely on it in production — it does not run `applyMigrations()`.

---

## Production

There is no deploy step. The app ships with `db.ts` compiled in. When a user opens a new version of the app, `applyMigrations()` runs automatically and applies any pending steps based on the stored `user_version`.

**Rules:**

- Never drop a column or table in a migration — old data may matter to the user.
- `ALTER TABLE ADD COLUMN` is always safe. For anything more complex (rename, type change), create a new table and copy data.
- Always bump `CURRENT_SCHEMA_VERSION` — even for additive changes. If you forget, the migration block runs but `user_version` is never written, and the migration re-runs on every launch.
- The R-tree virtual table (`features_rtree`) cannot be altered with `ALTER TABLE`. To change its structure, drop and recreate it, then repopulate from `features`. Call `rebuildIndexFromPlaces()` after.

---

## `feature_properties` (EAV, schema v3+)

Normal SQLite table for **vault-wide frontmatter facets** (not the spatial `features` row). One row per atomic string value; YAML lists become multiple rows with the same `key`.


| Column       | Meaning                                               |
| ------------ | ----------------------------------------------------- |
| `feature_id` | Absolute path to the vault `.md` file                 |
| `key`        | Frontmatter property name                             |
| `value`      | Trimmed non-empty string (scalar or one list element) |


**Primary key:** `(feature_id, key, value)`.

**Indexes:** `idx_fp_key_value` on `(key, value)` for `SELECT DISTINCT value WHERE key = ?`; `idx_fp_feature` on `(feature_id)` for per-file deletes.

**Maintenance:** `replaceFeaturePropertiesForFile` / `removeFeaturePropertiesForFile` run from the markdown watcher and `parsePlaceFile` (same read as spatial place parsing). `reconcileFeatureProperties()` removes rows whose `feature_id` no longer exists on disk (called on watcher `ready`).

