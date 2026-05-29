# MapOS region build pipeline
#
# One region -> three artifacts (PMTiles + Valhalla tiles + geocode SQLite)
# -> versioned dist/ layout + manifest -> R2. Designed to run on the Mac mini.
#
# Quick start (tiny test region):
#   make all             # builds Monaco end to end into dist/
#   make upload          # push dist/ to R2 (needs rclone remote configured)
#
# Build a different region:
#   make all REGION=toronto SRC_URL=https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf \
#            BBOX=-79.64,43.58,-79.12,43.86
#
# ------------------------------------------------------------------ config ----

REGION   ?= monaco
SRC_URL  ?= https://download.geofabrik.de/europe/monaco-latest.osm.pbf
# Optional bbox "minlng,minlat,maxlng,maxlat". Clips the OSM extract (valhalla,
# geocode) AND bounds the tile extract. If empty, tiles derive their bbox from
# the OSM extract's data bounds.
BBOX     ?=
# Version = OSM data date. The build machine's clock is fine here.
VERSION  ?= $(shell date +%F)

WORK     := work/$(REGION)
DIST     := dist/$(REGION)/$(VERSION)
VALHALLA_IMAGE ?= ghcr.io/gis-ops/docker-valhalla/valhalla:latest
# Protomaps daily planet basemap builds. We `pmtiles extract` a region from these
# via HTTP range requests — the schema matches the app's Protomaps style exactly.
PROTOMAPS_BUILD_BASE ?= https://build.protomaps.com
TILES_MAXZOOM ?= 15
# Whole-world low-zoom basemap maxzoom. This is the always-on "low-fi" backdrop
# the app renders outside downloaded regions, so keep it small — z6 is country /
# major-road level. Built once (region-independent) and bundled with the app.
WORLD_MAXZOOM ?= 6
# Where the bundled world basemap lands in the dashboard's extraResources.
DASHBOARD_ASSETS ?= ../apps/dashboard/resources/basemap-assets
# rclone remote name pointing at your R2 bucket (rclone config -> type s3, provider Cloudflare).
R2_REMOTE ?= r2:mapos-regions

SRC_PBF  := $(WORK)/source.osm.pbf
REGION_PBF := $(WORK)/$(REGION).osm.pbf

.PHONY: all extract pmtiles valhalla geocode manifest upload clean distclean world bundle-world

all: pmtiles valhalla geocode manifest
	@echo "==> $(REGION)@$(VERSION) built into $(DIST)"

# --------------------------------------------------------------- 0. extract ----

$(SRC_PBF):
	@mkdir -p $(WORK)
	curl -L -o $@ "$(SRC_URL)"

# Clip to BBOX if given, else use the source as-is.
$(REGION_PBF): $(SRC_PBF)
ifeq ($(BBOX),)
	cp $(SRC_PBF) $(REGION_PBF)
else
	osmium extract -b $(BBOX) $(SRC_PBF) -o $(REGION_PBF) --overwrite
endif

extract: $(REGION_PBF)

# ------------------------------------------------------------- 1. PMTiles ----
# Extract the region from the freshest Protomaps planet build (range requests, so
# only the bbox tiles transfer). Protomaps basemap schema = the app's style works
# unchanged. The OSM extract is used only to derive a bbox when BBOX is unset.

pmtiles: $(REGION_PBF)
	@mkdir -p $(DIST)
	@set -e; \
	bbox="$(BBOX)"; \
	if [ -z "$$bbox" ]; then bbox=$$(osmium fileinfo -e -g data.bbox $(REGION_PBF) | tr -d '()'); fi; \
	build=""; \
	for i in $$(seq 0 14); do d=$$(date -v-$${i}d +%Y%m%d); \
	  if curl -fsI "$(PROTOMAPS_BUILD_BASE)/$$d.pmtiles" >/dev/null 2>&1; then build=$$d; break; fi; done; \
	if [ -z "$$build" ]; then echo "no Protomaps build found in last 14 days" >&2; exit 1; fi; \
	echo "==> extracting bbox $$bbox from Protomaps build $$build"; \
	pmtiles extract "$(PROTOMAPS_BUILD_BASE)/$$build.pmtiles" $(DIST)/$(REGION).pmtiles \
	  --bbox=$$bbox --maxzoom=$(TILES_MAXZOOM)

# ------------------------------------------------------------ 2. Valhalla ----
# The gis-ops turnkey image builds tiles from any .pbf dropped in /custom_files
# and emits valhalla_tiles.tar there. Bump Docker Desktop's RAM for big regions.

valhalla: $(REGION_PBF)
	@mkdir -p $(WORK)/valhalla $(DIST)
	cp $(REGION_PBF) $(WORK)/valhalla/
	docker run --rm \
	  -v "$(PWD)/$(WORK)/valhalla:/custom_files" \
	  -e serve_tiles=False -e build_elevation=False \
	  -e build_admins=True -e build_time_zones=True \
	  $(VALHALLA_IMAGE)
	cp $(WORK)/valhalla/valhalla_tiles.tar $(DIST)/valhalla_tiles.tar

# ------------------------------------------------------------- 3. geocode ----

geocode: $(REGION_PBF)
	@mkdir -p $(DIST)
	osmium tags-filter $(REGION_PBF) \
	  n/place w/highway nwr/amenity nwr/shop nwr/tourism nwr/leisure \
	  -o $(WORK)/geocode-src.osm.pbf --overwrite
	osmium export $(WORK)/geocode-src.osm.pbf -f geojsonseq \
	  -c geocode/export-config.json --overwrite \
	  | pnpm exec tsx geocode/build-geocode.ts $(DIST)/geocode.sqlite --region "$(REGION)"

# --------------------------------------------------------------- 4. world ----
# Whole-world low-zoom basemap, built ONCE (not per region). The app renders this
# as an always-on low-fi backdrop so the map is never blank outside a downloaded
# region; the region pmtiles overlays crisp detail on top. Same Protomaps schema
# as the regions, so the app's generated style covers both with one layer set.

world:
	@mkdir -p dist/_world
	@set -e; \
	build=""; \
	for i in $$(seq 0 14); do d=$$(date -v-$${i}d +%Y%m%d); \
	  if curl -fsI "$(PROTOMAPS_BUILD_BASE)/$$d.pmtiles" >/dev/null 2>&1; then build=$$d; break; fi; done; \
	if [ -z "$$build" ]; then echo "no Protomaps build found in last 14 days" >&2; exit 1; fi; \
	echo "==> extracting whole-world z0-$(WORLD_MAXZOOM) from Protomaps build $$build"; \
	pmtiles extract "$(PROTOMAPS_BUILD_BASE)/$$build.pmtiles" dist/_world/world.pmtiles \
	  --bbox=-180,-85.0511,180,85.0511 --maxzoom=$(WORLD_MAXZOOM)
	@ls -lh dist/_world/world.pmtiles

# Copy the built world basemap into the dashboard's bundled assets (shipped via
# electron-builder extraResources, served over mapos-asset://basemap/world.pmtiles).
bundle-world: dist/_world/world.pmtiles
	@mkdir -p $(DASHBOARD_ASSETS)/basemap
	cp dist/_world/world.pmtiles $(DASHBOARD_ASSETS)/basemap/world.pmtiles
	@echo "==> bundled world basemap into $(DASHBOARD_ASSETS)/basemap"

dist/_world/world.pmtiles:
	$(MAKE) world

# ------------------------------------------------------------ manifest/up ----

manifest:
	pnpm exec tsx scripts/make-manifest.ts --dist dist --region $(REGION) --version $(VERSION)

upload:
	rclone copy dist/ $(R2_REMOTE)/ --progress

# ---------------------------------------------------------------- cleanup ----

clean:
	rm -rf $(WORK)

distclean: clean
	rm -rf dist
