# Region build pipeline

Turns one OSM extract into a downloadable region pack — `<region>.pmtiles` (basemap),
`valhalla_tiles.tar` (routing), `geocode.sqlite` (forward/reverse geocode) — versioned
under `dist/<region>/<version>/`, plus a `dist/manifest.json` the app reads to discover
regions. Uploads to Cloudflare R2.

## Prerequisites

```sh
brew install osmium-tool pmtiles rclone     # extract/export, tile slicing, R2 upload
pnpm install                                # in pipeline/ (builds better-sqlite3 for this Node)
# Docker Desktop running — used for the Valhalla tile build.
```

If the geocode step fails with a `NODE_MODULE_VERSION` error, run `pnpm rebuild
better-sqlite3` (the native binary must match your current Node).

## Build

```sh
make all                                    # Monaco (tiny default), end to end
```

Other regions — point `SRC_URL` at a Geofabrik extract. `GROUP`/`GROUP_NAME` nest a
region under a country in the manifest (the download UI shows it as an expandable
group); `NAME` is the display name:

```sh
make all REGION=berlin GROUP=germany GROUP_NAME=Germany NAME=Berlin \
  SRC_URL=https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
```

Pass `BBOX=minlng,minlat,maxlng,maxlat` to clip; otherwise the region's extent is the
extract's data bounds. Individual stages: `make pmtiles | valhalla | geocode | manifest`.

The shared low-zoom world backdrop is built once (not per region) and bundled with the
app: `make world && make bundle-world`.

## Upload

`make upload` reads `BUCKET` and the `RCLONE_CONFIG_R2_*` credentials from the repo-root
`.env`, so source it first:

```sh
cd .. && set -a && source .env && set +a && cd pipeline
make upload                                 # rclone copy dist/ -> r2:$BUCKET
```

## Cleanup

`make clean` removes `work/` intermediates; `make distclean` also wipes `dist/`.
