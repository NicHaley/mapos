-- MapOS offline geocode index.
--
-- Stock-SQLite only: FTS5 + R-tree, no SpatiaLite extension, so the same .sqlite
-- file loads in better-sqlite3 (desktop/Electron), on iOS/Android, and on the
-- pro server. Distance / reverse-geocode is computed at query time by the
-- client (haversine in SQL or JS), NOT baked in here, to keep the file portable.

CREATE TABLE IF NOT EXISTS features (
  id            INTEGER PRIMARY KEY,
  osm_type      TEXT    NOT NULL,           -- node | way | relation
  osm_id        INTEGER NOT NULL,
  name          TEXT    NOT NULL,
  alt_names     TEXT,                        -- newline-joined name:* values
  kind          TEXT    NOT NULL,            -- place | poi | street
  class         TEXT,                        -- city | town | restaurant | ...
  importance    REAL    NOT NULL DEFAULT 0,  -- ranking signal, 0..~1+
  population    INTEGER,
  admin_context TEXT,                        -- "Shibuya, Tokyo, Japan" (admin hierarchy)
  address       TEXT,                        -- "Skalitzer Str. 12" (self-tagged addr:*)
  lat           REAL    NOT NULL,
  lng           REAL    NOT NULL
);

-- Full-text search over the human-typed fields. unicode61 + prefix indexes work
-- on every SQLite build; swap tokenize to 'trigram' (SQLite >= 3.34) later if you
-- want substring / typo tolerance.
CREATE VIRTUAL TABLE IF NOT EXISTS features_fts USING fts5(
  name, alt_names, admin_context,
  content='features',
  content_rowid='id',
  prefix='2 3',
  tokenize='unicode61 remove_diacritics 2'
);

-- Spatial prefilter for distance bias (forward) and nearest-neighbour (reverse).
CREATE VIRTUAL TABLE IF NOT EXISTS features_rtree USING rtree(
  id, min_lng, max_lng, min_lat, max_lat
);
