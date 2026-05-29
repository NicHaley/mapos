# MapOS region build pipeline
#
# One OSM extract -> three artifacts (PMTiles + Valhalla tiles + geocode SQLite)
# -> versioned dist/ layout + manifest -> R2. Designed to run on the Mac mini.
#
# Quick start (tiny test region):
#   make tools           # one-time: fetch planetiler.jar
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
# Optional bbox "minlng,minlat,maxlng,maxlat" to clip SRC down to a metro.
BBOX     ?=
# Version = OSM data date. The build machine's clock is fine here.
VERSION  ?= $(shell date +%F)

WORK     := work/$(REGION)
DIST     := dist/$(REGION)/$(VERSION)
PLANETILER_JAR ?= tools/planetiler.jar
PLANETILER_VERSION ?= 0.8.3
VALHALLA_IMAGE ?= ghcr.io/gis-ops/docker-valhalla/valhalla:latest
# rclone remote name pointing at your R2 bucket (rclone config -> type s3, provider Cloudflare).
R2_REMOTE ?= r2:mapos-regions

SRC_PBF  := $(WORK)/source.osm.pbf
REGION_PBF := $(WORK)/$(REGION).osm.pbf

.PHONY: all tools extract pmtiles valhalla geocode manifest upload clean distclean

all: pmtiles valhalla geocode manifest
	@echo "==> $(REGION)@$(VERSION) built into $(DIST)"

# ----------------------------------------------------------------- tooling ----

tools: $(PLANETILER_JAR)

$(PLANETILER_JAR):
	@mkdir -p tools
	curl -L -o $@ \
	  https://github.com/onthegomap/planetiler/releases/download/v$(PLANETILER_VERSION)/planetiler.jar

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

pmtiles: $(REGION_PBF) $(PLANETILER_JAR)
	@mkdir -p $(DIST)
	# --download fetches the OpenMapTiles base layers (water polygons, natural
	# earth, lake centerlines) into data/sources/ once, then reuses them.
	java -Xmx12g -jar $(PLANETILER_JAR) \
	  --osm-path=$(REGION_PBF) \
	  --output=$(DIST)/$(REGION).pmtiles \
	  --download --force

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
