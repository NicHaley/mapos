-- MapOS offline geocode index.
--
-- Stock-SQLite only: FTS5 + R-tree, no SpatiaLite extension, so the same .sqlite
-- file loads in better-sqlite3 (desktop/Electron), on iOS/Android, and on the
-- pro server. Distance / reverse-geocode is computed at query time by the
-- client (haversine in SQL or JS), NOT baked in here, to keep the file portable.

-- Schema version (bump when the layout changes so clients can detect old packs).
PRAGMA user_version = 3;

CREATE TABLE IF NOT EXISTS features (
  id             INTEGER PRIMARY KEY,
  osm_type       TEXT    NOT NULL,           -- node | way | relation
  osm_id         INTEGER NOT NULL,
  name           TEXT    NOT NULL,
  alt_names      TEXT,                        -- newline-joined name:* values
  kind           TEXT    NOT NULL,            -- place | poi | street
  class          TEXT,                        -- raw: city | amenity:restaurant | ...
  category       TEXT,                        -- normalized category id, POIs only (geocode/categories.ts)
  category_terms TEXT,                        -- space-joined category synonyms for FTS ("cafe coffee espresso")
  importance     REAL    NOT NULL DEFAULT 0,  -- ranking signal, 0..~1+
  population     INTEGER,
  admin_context  TEXT,                        -- "Shibuya, Tokyo, Japan" (admin hierarchy)
  address        TEXT,                        -- "Skalitzer Str. 12" (self-tagged addr:*)
  wikidata       TEXT,                        -- Wikidata QID ("Q64"), returned not searched
  lat            REAL    NOT NULL,
  lng            REAL    NOT NULL,
  -- Geometry extent (degenerate = point feature). Lets the client zoom-to-fit
  -- parks / beaches / merged streets instead of centering on an averaged point.
  bbox_min_lng   REAL,
  bbox_min_lat   REAL,
  bbox_max_lng   REAL,
  bbox_max_lat   REAL
);

-- Full-text search over the human-typed fields, plus category synonyms so queries
-- like "restaurants" match POIs by metadata, and the self-tagged address line so
-- partial-address queries ("12 skalitzer") match. unicode61 + prefix indexes work
-- on every SQLite build; swap tokenize to 'trigram' (SQLite >= 3.34) later if you
-- want substring / typo tolerance.
CREATE VIRTUAL TABLE IF NOT EXISTS features_fts USING fts5(
  name, alt_names, admin_context, category_terms, address,
  content='features',
  content_rowid='id',
  prefix='2 3',
  tokenize='unicode61 remove_diacritics 2'
);

-- Structured category filtering ("all restaurants in bbox" with no text query).
CREATE INDEX IF NOT EXISTS idx_features_category ON features(category) WHERE category IS NOT NULL;

-- Spatial prefilter for distance bias (forward) and nearest-neighbour (reverse).
CREATE VIRTUAL TABLE IF NOT EXISTS features_rtree USING rtree(
  id, min_lng, max_lng, min_lat, max_lat
);
