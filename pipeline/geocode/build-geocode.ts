#!/usr/bin/env tsx
/**
 * Build a MapOS offline geocode index (SQLite + FTS5 + R-tree) from a stream of
 * GeoJSON features produced by `osmium export`.
 *
 * libosmium (via the `osmium` CLI) does the heavy lifting — node-location caching
 * and geometry assembly — and streams GeoJSONSeq on stdin. This script only
 * classifies, reduces geometry to a representative point, and loads SQLite.
 *
 * The writer is Node's built-in `node:sqlite` (DatabaseSync) rather than
 * better-sqlite3: the pipeline runs under plain Node, while the desktop app rebuilds
 * better-sqlite3 for Electron's ABI — sharing one native build in the pnpm workspace
 * made them clobber each other. The output is a plain SQLite file (FTS5 + R-tree), so
 * the desktop/mobile client still reads it with better-sqlite3 unchanged.
 *
 * Scope: named places, POIs, and streets, each enriched with (a) an admin hierarchy
 * resolved by point-in-polygon against boundary=administrative areas ("Kreuzberg,
 * Berlin") and (b) a street line from the feature's own addr:* tags. Arbitrary
 * house-number geocoding (address interpolation) is the Phase-3 cliff and out of scope.
 *
 * Usage:
 *   osmium export filtered.osm.pbf -f geojsonseq -c export-config.json \
 *     | tsx build-geocode.ts OUTPUT.sqlite --region "Monaco" --admins admins.geojsonseq
 */

import { readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Feature, Geometry, Position } from "geojson";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- what counts as geocodable -------------------------------------------------

const PLACE_WEIGHTS: Record<string, number> = {
  city: 1.0,
  town: 0.7,
  borough: 0.6,
  suburb: 0.55,
  village: 0.45,
  neighbourhood: 0.45,
  quarter: 0.4,
  hamlet: 0.3,
  locality: 0.2,
  isolated_dwelling: 0.15,
};

const ROAD_TYPES = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "unclassified", "residential", "living_street", "pedestrian", "road",
]);

const POI_KEYS = ["amenity", "shop", "tourism", "leisure", "office", "historic"];

const STREET_BASE = 0.35;
const POI_BASE = 0.3;

type Tags = Record<string, string>;
type Classified = { kind: string; cls: string; base: number };

function classify(tags: Tags): Classified | null {
  if (!tags.name) return null;

  const place = tags.place;
  if (place && place in PLACE_WEIGHTS) {
    return { kind: "place", cls: place, base: PLACE_WEIGHTS[place] };
  }

  const highway = tags.highway;
  if (highway && ROAD_TYPES.has(highway)) {
    return { kind: "street", cls: highway, base: STREET_BASE };
  }

  for (const key of POI_KEYS) {
    if (tags[key]) return { kind: "poi", cls: `${key}:${tags[key]}`, base: POI_BASE };
  }

  return null;
}

function altNames(tags: Tags): string | null {
  const out: string[] = [];
  for (const [k, v] of Object.entries(tags)) {
    if (k.startsWith("name:") && v) out.push(v);
  }
  return out.length ? out.join("\n") : null;
}

function population(tags: Tags): number | null {
  const raw = tags.population;
  if (!raw) return null;
  const n = Number.parseInt(raw.replace(/,/g, "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function importance(base: number, pop: number | null): number {
  let score = base;
  if (pop && pop > 0) score += Math.min(Math.log10(pop) / 10, 0.7);
  return Math.round(score * 1e4) / 1e4;
}

/** Average every coordinate in a geometry into one representative [lng, lat]. */
function representativePoint(geom: Geometry): [number, number] | null {
  let lngSum = 0;
  let latSum = 0;
  let count = 0;
  const visit = (coords: unknown): void => {
    if (typeof (coords as Position)[0] === "number" && typeof (coords as Position)[1] === "number") {
      lngSum += (coords as Position)[0];
      latSum += (coords as Position)[1];
      count += 1;
      return;
    }
    for (const c of coords as unknown[]) visit(c);
  };
  if (geom.type === "GeometryCollection") return null;
  visit(geom.coordinates);
  return count ? [lngSum / count, latSum / count] : null;
}

// --- self-tagged street address ------------------------------------------------

/** A street line from the feature's OWN addr:* tags (no geocoding). null when absent. */
function addressLine(tags: Tags): string | null {
  const street = tags["addr:street"]?.trim();
  if (!street) return null;
  const num = tags["addr:housenumber"]?.trim();
  return num ? `${street} ${num}` : street;
}

// --- admin hierarchy (point-in-polygon) ----------------------------------------

type BBox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
type AdminArea = {
  name: string;
  level: number; // OSM admin_level — higher = more specific (10 ≈ neighbourhood, 2 = country)
  bbox: BBox;
  polys: Position[][][]; // [polygon][ring][vertex]; ring[0] is outer, the rest are holes
};

/** Ray-casting test: is point strictly within a single ring? */
function pointInRing(lng: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
function pointInRings(lng: number, lat: number, rings: Position[][]): boolean {
  if (!rings.length || !pointInRing(lng, lat, rings[0])) return false;
  for (let r = 1; r < rings.length; r++) {
    if (pointInRing(lng, lat, rings[r])) return false; // in a hole
  }
  return true;
}

/** Load boundary=administrative polygons from a GeoJSONSeq file into a flat list. */
function loadAdmins(path: string): AdminArea[] {
  const areas: AdminArea[] = [];
  const text = readFileSync(path, "utf8");
  for (const raw of text.split("\n")) {
    const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim();
    if (!line) continue;
    let feature: Feature;
    try {
      feature = JSON.parse(line) as Feature;
    } catch {
      continue;
    }
    const tags = (feature.properties ?? {}) as Tags;
    const name = tags.name?.trim();
    const level = Number.parseInt(tags.admin_level ?? "", 10);
    const geom = feature.geometry;
    if (!name || !Number.isFinite(level) || !geom) continue;

    let polys: Position[][][];
    if (geom.type === "Polygon") polys = [geom.coordinates];
    else if (geom.type === "MultiPolygon") polys = geom.coordinates;
    else continue;

    let minLng = Number.POSITIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const poly of polys)
      for (const ring of poly)
        for (const [x, y] of ring) {
          if (x < minLng) minLng = x;
          if (x > maxLng) maxLng = x;
          if (y < minLat) minLat = y;
          if (y > maxLat) maxLat = y;
        }
    areas.push({ name, level, bbox: [minLng, minLat, maxLng, maxLat], polys });
  }
  // Most-specific first so the composed string reads neighbourhood → country.
  areas.sort((a, b) => b.level - a.level);
  return areas;
}

const MAX_ADMIN_PARTS = 3;

/** Compose "Neighbourhood, City, Country" for a point, most specific first. */
function adminContextFor(lng: number, lat: number, admins: AdminArea[]): string | null {
  const parts: string[] = [];
  for (const a of admins) {
    if (lng < a.bbox[0] || lng > a.bbox[2] || lat < a.bbox[1] || lat > a.bbox[3]) continue;
    if (parts.includes(a.name)) continue;
    if (a.polys.some((rings) => pointInRings(lng, lat, rings))) {
      parts.push(a.name);
      if (parts.length >= MAX_ADMIN_PARTS) break;
    }
  }
  return parts.length ? parts.join(", ") : null;
}

// --- SQLite setup --------------------------------------------------------------

const [output, ...rest] = process.argv.slice(2);
if (!output) {
  console.error("usage: build-geocode.ts OUTPUT.sqlite [--region NAME]");
  process.exit(1);
}
const regionIdx = rest.indexOf("--region");
const region = regionIdx >= 0 ? (rest[regionIdx + 1] ?? "") : "";
const adminsIdx = rest.indexOf("--admins");
const adminsPath = adminsIdx >= 0 ? rest[adminsIdx + 1] : undefined;

// Admin boundary polygons for point-in-polygon hierarchy enrichment. Optional: without
// them, admin_context stays null and the client falls back to the region name.
const admins = adminsPath ? loadAdmins(adminsPath) : [];
if (adminsPath) console.error(`Loaded ${admins.length.toLocaleString()} admin areas`);

// Always rebuild from scratch — opening an existing file would append (duplicate
// `features` rows, then collide on `features_rtree.id`) since the schema uses
// CREATE TABLE IF NOT EXISTS. Drop any prior build (and stray WAL/SHM) first.
for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${output}${suffix}`, { force: true });

const db = new DatabaseSync(output);
// Bulk-load pragmas: this file is rebuilt from scratch, durability doesn't matter.
db.exec("PRAGMA journal_mode = OFF");
db.exec("PRAGMA synchronous = OFF");
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));

const insert = db.prepare(
  `INSERT INTO features
     (osm_type, osm_id, name, alt_names, kind, class, importance, population, admin_context, address, lat, lng)
   VALUES (@osm_type, @osm_id, @name, @alt_names, @kind, @cls, @importance, @population, @admin_context, @address, @lat, @lng)`,
);

let count = 0;
db.exec("BEGIN");

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

for await (const raw of rl) {
  // GeoJSONSeq (RFC 8142) prefixes each record with a record-separator (0x1e).
  const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim();
  if (!line) continue;

  let feature: Feature;
  try {
    feature = JSON.parse(line) as Feature;
  } catch {
    continue;
  }
  if (!feature.geometry) continue;

  const tags = (feature.properties ?? {}) as Tags & { "@type"?: string; "@id"?: string };
  const c = classify(tags);
  if (!c) continue;

  const point = representativePoint(feature.geometry);
  if (!point) continue;

  const pop = population(tags);
  insert.run({
    osm_type: tags["@type"] ?? "",
    osm_id: tags["@id"] ? Number.parseInt(tags["@id"], 10) : 0,
    name: tags.name,
    alt_names: altNames(tags),
    kind: c.kind,
    cls: c.cls,
    importance: importance(c.base, pop),
    population: pop,
    // Real per-feature admin hierarchy via point-in-polygon ("Kreuzberg, Berlin"); null
    // when no admins file was supplied or the point falls outside every boundary. We
    // deliberately do NOT store the bare region name here — being identical on every row
    // it drives the FTS IDF to ~0 and pollutes every region-name query; the client falls
    // back to the pack region for display.
    admin_context: adminContextFor(point[0], point[1], admins),
    address: addressLine(tags),
    lng: point[0],
    lat: point[1],
  });

  count += 1;
  if (count % 50_000 === 0) console.error(`  ...${count.toLocaleString()} features`);
}

console.error("Populating FTS5 + R-tree...");
db.exec(
  `INSERT INTO features_fts(rowid, name, alt_names, admin_context)
     SELECT id, name, alt_names, admin_context FROM features;
   INSERT INTO features_rtree(id, min_lng, max_lng, min_lat, max_lat)
     SELECT id, lng, lng, lat, lat FROM features;`,
);
db.exec("COMMIT");
db.exec("ANALYZE");
db.exec("VACUUM");
db.close();

console.error(`Done: ${count.toLocaleString()} features -> ${output}`);
