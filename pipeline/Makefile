# MapOS region build pipeline
#
# One region -> three artifacts (PMTiles + Valhalla tiles + geocode SQLite)
# -> versioned dist/ layout + manifest -> R2.
#
#   make all             # builds Monaco end to end into dist/
#   make upload          # push dist/ to R2
#
# ------------------------------------------------------------------ config ----

# Repo-root .env (BUCKET, RCLONE_CONFIG_R2_*, DIST_DIR) loads as make syntax —
# keep values unquoted and $-free. Command-line overrides still win.
-include ../.env
# rclone reads credentials from the environment. Guarded: an empty list would
# turn `export` bare, exporting everything.
RCLONE_VARS := $(filter RCLONE_CONFIG_%,$(.VARIABLES))
ifneq ($(RCLONE_VARS),)
export $(RCLONE_VARS)
endif

REGION   ?= monaco
SRC_URL  ?= https://download.geofabrik.de/europe/monaco-latest.osm.pbf
# Optional "minlng,minlat,maxlng,maxlat" — clips the OSM extract and bounds the tiles.
BBOX     ?=
# Version = OSM data date.
VERSION  ?= $(shell date +%F)
# Manifest display metadata, e.g. GROUP=germany GROUP_NAME=Germany NAME=Berlin.
NAME       ?=
GROUP      ?=
GROUP_NAME ?=
# Continent grouping, e.g. CONTINENT=north-america CONTINENT_NAME="North America".
CONTINENT      ?=
CONTINENT_NAME ?=
# Country baked into geocode results' admin context. A pack is one country, so
# GROUP_NAME is the right default.
COUNTRY    ?= $(GROUP_NAME)
# Municipality admin_level cutoff in geocode results. Empty = OSM default (8);
# set for countries that deviate (e.g. 7 for Japan, where wards sit at 7).
CITY_LEVEL_MAX ?=
# Versions kept per region; older ones pruned from disk and R2 on upload.
# 2 = live + previous, so a client mid-download survives a rollout.
RETAIN     ?= 2
# Built-artifact root. Point at an external drive for world-scale builds
# (e.g. DIST_DIR=/Volumes/T7/mapos-dist). work/ stays local: it's the hot
# I/O path (Valhalla's docker bind mount).
DIST_DIR ?= dist

WORK     := work/$(REGION)
DIST     := $(DIST_DIR)/$(REGION)/$(VERSION)
VALHALLA_IMAGE ?= ghcr.io/gis-ops/docker-valhalla/valhalla:latest
# Protomaps daily planet builds — same schema as the app's style, extracted via
# HTTP range requests.
PROTOMAPS_BUILD_BASE ?= https://build.protomaps.com
TILES_MAXZOOM ?= 15
# Region packs start where the bundled world basemap ends. Must equal the app's
# WORLD_MAXZOOM + 1 (region-protocol.ts).
TILES_MINZOOM ?= 7
WORLD_MAXZOOM ?= 6
# Natural Earth admin-0 countries: point-in-polygon source for the world index's
# admin context (the bundled world.pmtiles has only point labels, not polygons).
# Build-time input only — not shipped in the app.
NE_ADMIN0_URL ?= https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
# 10m (not 50m) admin-1: NE only carries provinces for ~9 large federal countries at
# 50m; 10m covers all ~4,600 worldwide. It's a build input (not bundled), so the
# larger file costs nothing at runtime.
NE_ADMIN1_URL ?= https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
WORLD_WORK := work/_world
DASHBOARD_ASSETS ?= ../apps/dashboard/resources/basemap-assets
BUCKET    ?= mapos-regions
R2_REMOTE ?= r2:$(BUCKET)

SRC_PBF  := $(WORK)/source.osm.pbf
REGION_PBF := $(WORK)/$(REGION).osm.pbf

.PHONY: all extract pmtiles valhalla geocode manifest upload prune clean distclean world world-geocode bundle-world build-slug dist-guard

all: pmtiles valhalla geocode manifest
	@echo "==> $(REGION)@$(VERSION) built into $(DIST)"

# An overridden DIST_DIR must already exist: mkdir -p on an unmounted /Volumes
# path would silently build onto the internal disk.
dist-guard:
ifneq ($(DIST_DIR),dist)
	@test -d "$(DIST_DIR)" || \
	  { echo "error: DIST_DIR=$(DIST_DIR) does not exist — external drive not mounted?" >&2; exit 1; }
endif

# Build one region by catalog slug (regions.json). For the whole catalog use
# scripts/batch-build.ts.
#   make build-slug SLUG=us-georgia [VERSION=...]
build-slug:
	@test -n "$(SLUG)" || { echo "usage: make build-slug SLUG=<slug>"; exit 1; }
	@eval $$(pnpm exec tsx scripts/resolve-region.ts --slug $(SLUG)) && \
	$(MAKE) all REGION="$$REGION" SRC_URL="$$SRC_URL" VERSION="$(VERSION)" \
	  NAME="$$NAME" GROUP="$$GROUP" GROUP_NAME="$$GROUP_NAME" COUNTRY="$$COUNTRY" \
	  CONTINENT="$$CONTINENT" CONTINENT_NAME="$$CONTINENT_NAME" \
	  $${CITY_LEVEL_MAX:+CITY_LEVEL_MAX="$$CITY_LEVEL_MAX"} \
	  $${TILES_MAXZOOM:+TILES_MAXZOOM="$$TILES_MAXZOOM"}

# --------------------------------------------------------------- 0. extract ----

# Geofabrik serves "no such extract" as a 200 HTML page, so validate the payload
# is a real PBF and remove it on failure.
$(SRC_PBF):
	@mkdir -p $(WORK)
	curl -fL -o $@ "$(SRC_URL)"
	@osmium fileinfo $@ >/dev/null || \
	  { echo "error: $(SRC_URL) failed PBF validation (osmium error above)" >&2; rm -f $@; exit 1; }

$(REGION_PBF): $(SRC_PBF)
ifeq ($(BBOX),)
	cp $(SRC_PBF) $(REGION_PBF)
else
	osmium extract -b $(BBOX) $(SRC_PBF) -o $(REGION_PBF) --overwrite
endif

extract: $(REGION_PBF)

# ------------------------------------------------------------- 1. PMTiles ----
# Area of interest, in order: explicit BBOX, Geofabrik boundary polygon (clips
# coastal regions to their real shape, not an ocean-sized rectangle), OSM data
# bbox. The pbf is only fetched on that last fallback — the polygon path needs
# none, so pmtiles-only rebuilds skip the big download.

POLY_URL ?= $(if $(findstring -latest.osm.pbf,$(SRC_URL)),$(subst -latest.osm.pbf,.poly,$(SRC_URL)))

pmtiles: dist-guard
	@mkdir -p $(DIST) $(WORK)
	@set -e; \
	area=""; \
	if [ -n "$(BBOX)" ]; then \
	  echo "==> using explicit bbox $(BBOX)"; \
	  area="--bbox=$(BBOX)"; \
	elif [ -n "$(POLY_URL)" ] \
	  && curl -fsL -o $(WORK)/boundary.poly "$(POLY_URL)" \
	  && pnpm exec tsx scripts/poly-to-geojson.ts $(WORK)/boundary.poly $(WORK)/boundary.geojson; then \
	  echo "==> clipping to Geofabrik boundary polygon ($(POLY_URL))"; \
	  area="--region=$(WORK)/boundary.geojson"; \
	else \
	  $(MAKE) extract; \
	  bbox=$$(osmium fileinfo -e -g data.bbox $(REGION_PBF) | tr -d '()'); \
	  if [ -z "$$bbox" ]; then echo "error: empty bbox for $(REGION) — refusing a whole-planet extract" >&2; exit 1; fi; \
	  echo "==> no usable boundary polygon; using data bbox $$bbox"; \
	  area="--bbox=$$bbox"; \
	fi; \
	build=""; \
	for i in $$(seq 0 14); do d=$$(date -v-$${i}d +%Y%m%d); \
	  if curl -fsI "$(PROTOMAPS_BUILD_BASE)/$$d.pmtiles" >/dev/null 2>&1; then build=$$d; break; fi; done; \
	if [ -z "$$build" ]; then echo "no Protomaps build found in last 14 days" >&2; exit 1; fi; \
	echo "==> extracting from Protomaps build $$build (z$(TILES_MINZOOM)-z$(TILES_MAXZOOM))"; \
	pmtiles extract "$(PROTOMAPS_BUILD_BASE)/$$build.pmtiles" $(DIST)/$(REGION).pmtiles \
	  $$area --minzoom=$(TILES_MINZOOM) --maxzoom=$(TILES_MAXZOOM)

# ------------------------------------------------------------ 2. Valhalla ----

# valhalla_build_tiles has a multithreading race that hits near-certainly when an
# extract yields fewer tiles than threads; below this cutoff, build single-threaded.
VALHALLA_SINGLE_THREAD_BYTES ?= 10485760

# Staging dir is recreated each run — leftovers from a failed build poison retries.
# Extracts with zero routable ways (uninhabited islands) crash valhalla_build_tiles,
# so skip the stage and mark the pack .no-routing instead.
valhalla: dist-guard $(REGION_PBF)
	rm -rf $(WORK)/valhalla
	@mkdir -p $(WORK)/valhalla $(DIST)
	cp $(REGION_PBF) $(WORK)/valhalla/
	@set -e; \
	threads=""; \
	if [ "$$(wc -c < $(REGION_PBF))" -lt $(VALHALLA_SINGLE_THREAD_BYTES) ]; then \
	  if ! osmium tags-filter $(REGION_PBF) w/highway -f opl -o - | grep -q '^w'; then \
	    echo "==> $(REGION) has no routable ways — skipping valhalla; pack ships without routing"; \
	    touch $(DIST)/.no-routing; \
	    exit 0; \
	  fi; \
	  echo "==> small extract: building valhalla tiles single-threaded"; \
	  threads="-e server_threads=1"; \
	fi; \
	docker run --rm \
	  -v "$(PWD)/$(WORK)/valhalla:/custom_files" \
	  -e serve_tiles=False -e build_elevation=False \
	  -e build_admins=True -e build_time_zones=True \
	  $$threads \
	  $(VALHALLA_IMAGE); \
	cp $(WORK)/valhalla/valhalla_tiles.tar $(DIST)/valhalla_tiles.tar

# ------------------------------------------------------------- 3. geocode ----

geocode: dist-guard $(REGION_PBF)
	@mkdir -p $(DIST)
	osmium tags-filter $(REGION_PBF) \
	  n/place w/highway nwr/amenity nwr/shop nwr/tourism nwr/leisure nwr/office nwr/historic \
	  -o $(WORK)/geocode-src.osm.pbf --overwrite
	osmium tags-filter $(REGION_PBF) r/boundary=administrative \
	  -o $(WORK)/admins.osm.pbf --overwrite
	osmium export $(WORK)/admins.osm.pbf -f geojsonseq \
	  -c geocode/export-config.json -o $(WORK)/admins.geojsonseq --overwrite
	osmium export $(WORK)/geocode-src.osm.pbf -f geojsonseq \
	  -c geocode/export-config.json --overwrite \
	  | pnpm exec tsx geocode/build-geocode.ts $(DIST)/geocode.sqlite --region "$(REGION)" \
	      --admins $(WORK)/admins.geojsonseq $(if $(COUNTRY),--country "$(COUNTRY)") \
	      $(if $(CITY_LEVEL_MAX),--max-city-level $(CITY_LEVEL_MAX))

# --------------------------------------------------------------- 4. world ----
# Low-zoom whole-world basemap, built once (not per region) and bundled with the
# app as the backdrop outside downloaded regions.

world: dist-guard
	@mkdir -p $(DIST_DIR)/_world
	@set -e; \
	build=""; \
	for i in $$(seq 0 14); do d=$$(date -v-$${i}d +%Y%m%d); \
	  if curl -fsI "$(PROTOMAPS_BUILD_BASE)/$$d.pmtiles" >/dev/null 2>&1; then build=$$d; break; fi; done; \
	if [ -z "$$build" ]; then echo "no Protomaps build found in last 14 days" >&2; exit 1; fi; \
	echo "==> extracting whole-world z0-$(WORLD_MAXZOOM) from Protomaps build $$build"; \
	pmtiles extract "$(PROTOMAPS_BUILD_BASE)/$$build.pmtiles" $(DIST_DIR)/_world/world.pmtiles \
	  --bbox=-180,-85.0511,180,85.0511 --maxzoom=$(WORLD_MAXZOOM)
	@ls -lh $(DIST_DIR)/_world/world.pmtiles

# Coarse global geocode index (countries + major cities) extracted from the world
# basemap, so search/reverse work with zero region packs. Decoupled from the heavy
# per-region pipeline: rebuild whenever world.pmtiles is refreshed. Admin context
# ("Montreal -> Quebec, Canada") comes from Natural Earth admin-0 (countries) +
# admin-1 (states/provinces) via the same point-in-polygon path packs use.
world-geocode: dist-guard $(DIST_DIR)/_world/world.pmtiles
	@mkdir -p $(WORLD_WORK)
	@test -f $(WORLD_WORK)/ne_admin0.geojson || \
	  { echo "==> fetching Natural Earth admin-0"; curl -fsSL -o $(WORLD_WORK)/ne_admin0.geojson "$(NE_ADMIN0_URL)"; }
	@test -f $(WORLD_WORK)/ne_admin1.geojson || \
	  { echo "==> fetching Natural Earth admin-1"; curl -fsSL -o $(WORLD_WORK)/ne_admin1.geojson "$(NE_ADMIN1_URL)"; }
	pnpm exec tsx geocode/ne-admins-to-seq.ts $(WORLD_WORK)/ne_admin0.geojson > $(WORLD_WORK)/world-admins.geojsonseq
	pnpm exec tsx geocode/ne-admins-to-seq.ts --level 4 $(WORLD_WORK)/ne_admin1.geojson >> $(WORLD_WORK)/world-admins.geojsonseq
	pnpm exec tsx geocode/extract-world-places.ts $(DIST_DIR)/_world/world.pmtiles \
	  | pnpm exec tsx geocode/build-geocode.ts $(DIST_DIR)/_world/world.sqlite --region "World" \
	      --admins $(WORLD_WORK)/world-admins.geojsonseq
	@ls -lh $(DIST_DIR)/_world/world.sqlite

bundle-world: $(DIST_DIR)/_world/world.pmtiles $(DIST_DIR)/_world/world.sqlite
	@mkdir -p $(DASHBOARD_ASSETS)/basemap
	cp $(DIST_DIR)/_world/world.pmtiles $(DASHBOARD_ASSETS)/basemap/world.pmtiles
	cp $(DIST_DIR)/_world/world.sqlite $(DASHBOARD_ASSETS)/basemap/world.sqlite
	@echo "==> bundled world basemap + geocode index into $(DASHBOARD_ASSETS)/basemap"

$(DIST_DIR)/_world/world.pmtiles:
	$(MAKE) world

$(DIST_DIR)/_world/world.sqlite:
	$(MAKE) world-geocode

# ------------------------------------------------------------ manifest/up ----

manifest: dist-guard
	pnpm exec tsx scripts/make-manifest.ts --dist $(DIST_DIR) --region $(REGION) --retain $(RETAIN) \
	  $(if $(NAME),--name "$(NAME)") \
	  $(if $(GROUP),--group "$(GROUP)") \
	  $(if $(GROUP_NAME),--group-name "$(GROUP_NAME)") \
	  $(if $(CONTINENT),--continent "$(CONTINENT)") \
	  $(if $(CONTINENT_NAME),--continent-name "$(CONTINENT_NAME)")

# Order matters: upload artifacts, prune superseded versions, flip manifest.json
# last — a client must never see a manifest pointing at a version that isn't
# fully uploaded (or was just pruned).
upload: manifest
	rclone copy $(DIST_DIR)/ $(R2_REMOTE)/ --progress --s3-no-check-bucket \
	  --exclude "**/.DS_Store" --exclude ".DS_Store" --exclude "manifest.json" \
	  --exclude ".sha-cache.json" --exclude "**/.no-routing"
	$(MAKE) prune
	rclone copyto $(DIST_DIR)/manifest.json $(R2_REMOTE)/manifest.json --s3-no-check-bucket

# Delete versions beyond RETAIN, locally and on R2. The manifest (rebuilt above)
# already excludes them.
prune: dist-guard
	@set -e; \
	stale=$$(pnpm exec tsx scripts/list-stale-versions.ts --dist $(DIST_DIR) --retain $(RETAIN)); \
	if [ -z "$$stale" ]; then echo "==> nothing to prune (retain=$(RETAIN))"; else \
	  for x in $$stale; do \
	    echo "==> pruning $$x (local + R2)"; \
	    rm -rf "$(DIST_DIR)/$$x"; \
	    rclone delete "$(R2_REMOTE)/$$x" 2>/dev/null || true; \
	    rclone rmdir "$(R2_REMOTE)/$$x" 2>/dev/null || true; \
	  done; \
	fi

# ---------------------------------------------------------------- cleanup ----

clean:
	rm -rf $(WORK)

distclean: clean
	rm -rf $(DIST_DIR)
