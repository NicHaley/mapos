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
const CURRENT_SCHEMA_VERSION = 2; // bump this

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

Opens a browser-based table browser at `localhost:4983`. The DB must exist first — launch the app once to create it at `~/Documents/MapOS/.mapos/index.db`.

### Resetting the DB during development

Delete the file and relaunch — `initDb()` recreates it from scratch:

```bash
rm ~/Documents/MapOS/.mapos/index.db
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
