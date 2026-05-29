# MapOS region build pipeline

Turns one OSM extract into the three downloadable artifacts a MapOS region needs,
versions them, and uploads to R2:

| Artifact | Tool | Purpose | Read on client by |
| --- | --- | --- | --- |
| `<region>.pmtiles` | Planetiler | basemap rendering | MapLibre (range reads) |
| `valhalla_tiles.tar` | Valhalla (Docker) | offline routing, all modes | Valhalla in-process |
| `geocode.sqlite` | `osmium export` → TS builder | offline forward/reverse geocode | better-sqlite3 / native SQLite |

The geocode index is **stock SQLite only** (FTS5 + R-tree, no SpatiaLite extension)
so the identical file loads in Electron, on iOS/Android, and on the pro server.
The engine and ranking are the same everywhere; only the data scope (region vs
planet) changes. That is the consistency guarantee the whole design rests on.

## Prerequisites (Mac mini M4 Pro)

```sh
brew install osmium-tool          # extract / clip / filter / export PBFs
brew install openjdk              # Planetiler runtime (java)
brew install rclone               # R2 upload (configure an s3/Cloudflare remote)
cd pipeline && pnpm install       # standalone install (see note below); builds better-sqlite3 for Node
# Docker Desktop for the Valhalla build. Raise its RAM in Settings before big regions.
```

The geocode builder is TypeScript run via `tsx`. `osmium export` (libosmium) does the
PBF parsing and geometry assembly and streams GeoJSON on a pipe; the TS builder
classifies and loads SQLite with the **same `better-sqlite3` version the client uses**.

> **Why a standalone pnpm root, not a workspace member?** The dashboard rebuilds
> `better-sqlite3` for Electron's ABI via `electron-rebuild`. A Node CLI can't load
> an Electron-compiled native binary, so the pipeline keeps its own `node_modules`
> (own `pnpm-workspace.yaml`) with `better-sqlite3` compiled for Node — same npm
> version, so identical SQLite/FTS5/R-tree behaviour. Install from inside `pipeline/`.

## Run it

```sh
make tools          # one-time: download planetiler.jar
make all            # builds Monaco (tiny test region) into dist/
make upload         # push dist/ to R2
```

Pick a real metro by overriding the region spec. Use a Geofabrik parent extract
plus a bbox to clip:

```sh
make all REGION=toronto \
  SRC_URL=https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf \
  BBOX=-79.64,43.58,-79.12,43.86
```

Individual stages run on their own: `make pmtiles`, `make valhalla`, `make geocode`.
They share only the extract step, so on the Mac mini you can run them in parallel
(`make -j3 pmtiles valhalla geocode`).

## Output layout

```
dist/
  manifest.json                       # what the client reads to discover regions
  toronto/2026-05-28/
    toronto.pmtiles
    valhalla_tiles.tar
    geocode.sqlite
```

`VERSION` defaults to today's date; pass `VERSION=<osm-data-date>` to match the
extract's actual date. Versioning makes updates atomic — the client keeps using
the old version until the new one is fully uploaded.

## Querying the geocode index (client side)

Forward geocode, biased toward the current viewport (haversine computed at query
time so the file stays portable):

```sql
SELECT f.*, bm25(features_fts) AS text_score
FROM features_fts
JOIN features f ON f.id = features_fts.rowid
WHERE features_fts MATCH :q
ORDER BY bm25(features_fts)
       - f.importance * 4.0
       + ( 6371 * acos(
             cos(radians(:lat)) * cos(radians(f.lat))
           * cos(radians(f.lng) - radians(:lng))
           + sin(radians(:lat)) * sin(radians(f.lat))
         ) ) * 0.02
LIMIT 10;
```

Reverse geocode (nearest feature to a click), R-tree prefilter then exact sort:

```sql
SELECT f.* FROM features_rtree r
JOIN features f ON f.id = r.id
WHERE r.min_lng BETWEEN :lng - 0.05 AND :lng + 0.05
  AND r.min_lat BETWEEN :lat - 0.05 AND :lat + 0.05
ORDER BY (f.lat - :lat)*(f.lat - :lat) + (f.lng - :lng)*(f.lng - :lng)
LIMIT 1;
```

`better-sqlite3` bundles FTS5, R-tree, and math functions, so both run unmodified.

## Scope and next steps

Phase 1 (this scaffold): named **places, POIs, and streets**. Good for "find this
town / restaurant / street." The builder reduces each street/area geometry to a
representative point (coordinate average) for the marker; full geometry stays in
PMTiles / Valhalla.

Not yet, by design:
- **House-number addresses** (the Phase-3 cliff). The online pro geocoder covers
  these; the offline tier stays lean.
- **Rich admin context.** `admin_context` is currently the coarse region label.
  Enrich it via point-in-polygon against the `admins.sqlite` that
  `build_admins=True` already produces in the Valhalla step — reuse, no new data.
- **Street-segment dedup** and **Nominatim importance** (Wikipedia/Wikidata
  pageview signal) for ranking parity with Photon.

## Pro / planet tier

Same artifacts, same code, different serving: the planet `.pmtiles` is range-served
straight from R2 (no download); planet Valhalla runs as a hosted service; the
planet `geocode.sqlite` sits behind the Hono API using these exact queries. Build
planet artifacts on the Mac mini **sequentially**, deleting `work/` intermediates
between branches, or attach an external SSD — a full planet build can exceed
comfortable usage on 1TB if all three run at once.
