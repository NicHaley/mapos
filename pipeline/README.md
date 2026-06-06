# Region build pipeline

Turns one OSM extract into a downloadable region pack — `<region>.pmtiles` (basemap),
`valhalla_tiles.tar` (routing), `geocode.sqlite` (forward/reverse geocode) — versioned
under `dist/<region>/<version>/`, plus a `dist/manifest.json` the app reads to discover
regions. Uploads to Cloudflare R2.

World coverage comes from `regions.json` — a checked-in catalog of all ~512 Geofabrik
leaf extracts — and a batch driver that builds them through the same make stages.

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

Any cataloged region builds by slug — URL, display name, group, and geocode country
all resolve from `regions.json`:

```sh
make build-slug SLUG=us-georgia
```

Or point `SRC_URL` at any extract by hand. `GROUP`/`GROUP_NAME` nest a region under a
country in the manifest (the download UI shows it as an expandable group); `NAME` is
the display name:

```sh
make all REGION=berlin GROUP=germany GROUP_NAME=Germany NAME=Berlin \
  SRC_URL=https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
```

Pass `BBOX=minlng,minlat,maxlng,maxlat` to clip; otherwise the region's extent is the
extract's data bounds. Individual stages: `make pmtiles | valhalla | geocode | manifest`.

## The catalog (all Geofabrik regions)

`regions.json` lists every Geofabrik **leaf** extract (~512): subregions where a
country is split (US states, German states/regbez, English counties...), the country
itself otherwise. Leaves don't overlap, so the set tiles the world exactly once.
Continents and redundant combo extracts (dach, alps, us-west...) are excluded; combos
that are the *only* coverage of their countries (gcc-states, israel-and-palestine...)
are kept. Subregions group under their country in the manifest; standalone countries
group under their continent.

Regenerate when Geofabrik reshuffles (deterministic — an unchanged index reproduces
the file byte for byte; `--check` verifies without writing):

```sh
pnpm exec tsx scripts/gen-catalog.ts
```

The generator warns about any new shallow extract it can't classify — review it, add
it to `EXCLUDE` or `REVIEWED_KEEP` in `scripts/gen-catalog.ts`, and re-run.

## Batch builds

The batch driver runs the make stages per catalog region — sequentially, uploading
each region as it finishes and cleaning `work/` behind itself:

```sh
pnpm exec tsx scripts/batch-build.ts --dry-run            # show the work list
pnpm exec tsx scripts/batch-build.ts --continent europe   # one continent
pnpm exec tsx scripts/batch-build.ts --group germany --no-upload
pnpm exec tsx scripts/batch-build.ts                      # the whole world
```

One batch-wide `VERSION` (default: the day the batch starts) stamps every region. A
region is **skipped** when `dist/<slug>/<version>/` already holds all three artifacts,
so an interrupted run resumes by re-running with the same version — the driver prints
the exact flag to use:

```sh
pnpm exec tsx scripts/batch-build.ts --version 2026-06-06   # resume day 2+
```

Failures append to `failures.log` and the batch moves on; `--retry-failed` re-runs
just the regions whose latest logged outcome is a failure. `--limit N` bounds a run,
`--sleep N` pauses between regions, `--retain N` overrides version retention.

Uploads happen per region (`--no-upload` to skip), so coverage goes live
progressively and a mid-batch crash publishes nothing half-done — the manifest flip
stays atomic per region. Sourcing the R2 env (see Upload) is required unless
`--no-upload` is set.

Notes for a full-world run: builds are sequential by design (the Valhalla docker
build dominates wall-clock, and one download at a time is polite to Geofabrik — never
run two drivers at once). Disk: ~500 regions at `RETAIN=2` is plausibly several
hundred GB of `dist/`; consider `--retain 1` for the first world pass. Large regions
may need more Docker Desktop RAM for the Valhalla stage.

The shared low-zoom world backdrop is built once (not per region) and bundled with the
app: `make world && make bundle-world`.

## Upload

`make upload` reads `BUCKET` and the `RCLONE_CONFIG_R2_*` credentials from the repo-root
`.env`, so source it first:

```sh
cd .. && set -a && source .env && set +a && cd pipeline
make upload                                 # artifacts -> prune -> manifest (atomic)
```

It uploads artifacts, prunes superseded versions, then flips `manifest.json` last so a
client never sees a manifest pointing at a half-uploaded version.

## Versions & retention

Each build writes `dist/<region>/<VERSION>/` (`VERSION` defaults to today's date), and
the manifest tracks them per region with a `latest` pointer — so client updates are
atomic. Only the newest `RETAIN` versions (default **2**: live + previous) are kept;
older ones are pruned from disk **and** R2 on every `make upload`. Bump retention per
build with `RETAIN=3`, or prune manually with `make prune`.

R2 storage is ~$0.015/GB-month with **no egress fees**, so cost scales with retained
bytes only — keeping 2 versions, not full history, is what keeps world-scale builds
cheap.

## Cleanup

`make clean` removes `work/` intermediates; `make distclean` also wipes `dist/`.
