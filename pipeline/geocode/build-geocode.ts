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
 *     | tsx build-geocode.ts OUTPUT.sqlite --region "Monaco" --admins admins.geojsonseq \
 *         --country "Monaco" [--max-city-level 8]
 */

import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Feature, Geometry, Position } from "geojson";
import { resolveCategory } from "./categories";

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
  isolated_dwelling: 0.15
};

const ROAD_TYPES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "pedestrian",
  "road"
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
  // brand is an alternative identity ("BNP" for "BNP Paribas Agence Centrale"),
  // searchable like a translated name. Skip it when the name already contains it.
  const brand = tags.brand?.trim();
  if (brand && !tags.name.toLowerCase().includes(brand.toLowerCase())) out.push(brand);
  return out.length ? out.join("\n") : null;
}

// Descriptor tags whose values become extra category_terms, so metadata queries
// like "sushi" or "tennis" match POIs whose NAME doesn't contain the word.
// Values are ;-separated lists in OSM ("italian;pizza").
const DESCRIPTOR_KEYS = ["cuisine", "sport"];

function descriptorTerms(tags: Tags): string[] {
  const out: string[] = [];
  for (const key of DESCRIPTOR_KEYS) {
    const raw = tags[key];
    if (!raw) continue;
    for (const part of raw.split(";")) {
      const term = part.trim().toLowerCase().replace(/_/g, " ");
      if (term) out.push(term);
    }
  }
  return out;
}

function population(tags: Tags): number | null {
  const raw = tags.population;
  if (!raw) return null;
  const n = Number.parseInt(raw.replace(/,/g, "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function importance(base: number, pop: number | null, famous: boolean): number {
  let score = base;
  if (pop && pop > 0) score += Math.min(Math.log10(pop) / 10, 0.7);
  // A wikidata/wikipedia tag is a cheap fame proxy (Nominatim weights full Wikipedia
  // importance; we just need landmarks to outrank same-category neighbours, since
  // POIs otherwise share a flat base score).
  if (famous) score += 0.2;
  return Math.round(score * 1e4) / 1e4;
}

type GeomSummary = {
  lng: number; // average of every coordinate — one representative point
  lat: number;
  minLng: number; // extent, degenerate (min == max) for point features
  minLat: number;
  maxLng: number;
  maxLat: number;
};

/** Reduce a geometry to a representative point (coordinate average) + its extent. */
function summarizeGeometry(geom: Geometry): GeomSummary | null {
  let lngSum = 0;
  let latSum = 0;
  let count = 0;
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  const visit = (coords: unknown): void => {
    if (
      typeof (coords as Position)[0] === "number" &&
      typeof (coords as Position)[1] === "number"
    ) {
      const lng = (coords as Position)[0];
      const lat = (coords as Position)[1];
      lngSum += lng;
      latSum += lat;
      count += 1;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const c of coords as unknown[]) visit(c);
  };
  if (geom.type === "GeometryCollection") return null;
  visit(geom.coordinates);
  if (!count) return null;
  return { lng: lngSum / count, lat: latSum / count, minLng, minLat, maxLng, maxLat };
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

// Approximate OSM admin_level of a place's OWN boundary, by place class. Used as the
// rank floor: when resolving a place's admin context we only walk UP to coarser areas
// (admin_level < this), never into its own sub-areas — so the city "Berlin" is described
// by its country, not by the "Mitte" district its label point happens to sit in. POIs
// and streets have no own level (Infinity), so they pick up the full local hierarchy.
const PLACE_ADMIN_LEVEL: Record<string, number> = {
  city: 8,
  town: 8,
  village: 8,
  borough: 9,
  suburb: 10,
  neighbourhood: 10,
  quarter: 10,
  hamlet: 10,
  locality: 10,
  isolated_dwelling: 10
};

type AdminOpts = {
  ownLevel: number;
  ownName: string;
  country: string | null;
  maxCityLevel: number;
};

// admin_level boundary between the "municipality and larger" tier (city/county/state)
// and the "sub-municipal" tier (district/borough/suburb). This split is the OSM
// admin_level convention — the wiki defines levels >=9 as subdivisions WITHIN a
// municipality and <=8 as the municipality and above — and is the most stable part of
// the scheme across countries. A handful deviate (e.g. JP wards at 7); those packs pass
// --max-city-level to shift the boundary. Default 8 covers DE/MC and most of EU/NA.
const DEFAULT_MAX_CITY_LEVEL = 8;

/**
 * Compose a feature's admin context the way Nominatim/Photon do: walk only UP the
 * containing hierarchy (areas coarser than the feature itself), then pick ONE area from
 * the sub-municipal band (a district/suburb) and ONE from the municipality band (the city
 * — never skipped in favour of the state, which is what mislabels Bremerhaven as Bremen),
 * and ALWAYS append the country. The country comes from the region's group, not the
 * polygons — a city extract has no level-2 boundary, just as Nominatim uses a country table.
 */
function adminContextFor(
  lng: number,
  lat: number,
  admins: AdminArea[],
  opts: AdminOpts
): string | null {
  // admins are pre-sorted most-specific (level desc) first, so the first match in each
  // band is the most specific in that band: the smallest district, and the city itself.
  let locality: string | null = null; // sub-municipal: district / borough / suburb
  let city: string | null = null; // municipality / county / state (first <= maxCityLevel)
  let coarsest: string | null = null; // fallback when nothing reaches the municipality band
  for (const a of admins) {
    if (lng < a.bbox[0] || lng > a.bbox[2] || lat < a.bbox[1] || lat > a.bbox[3]) continue;
    if (a.level >= opts.ownLevel) continue; // never describe a place by its own / finer areas
    if (a.name === opts.ownName) continue; // nor by an area sharing its name (places only)
    if (!a.polys.some((rings) => pointInRings(lng, lat, rings))) continue;
    coarsest = a.name; // sorted desc, so the last match seen is the coarsest
    if (a.level > opts.maxCityLevel) {
      if (!locality) locality = a.name;
    } else if (!city) {
      city = a.name;
    }
  }
  // If no area reached the municipality band (a country whose smallest admin unit is
  // sub-municipal, or a sparse extract), fall back to the coarsest area so the city tier
  // is never silently dropped.
  if (!city && coarsest && coarsest !== locality) city = coarsest;
  const parts: string[] = [];
  if (locality) parts.push(locality);
  if (city && city !== locality) parts.push(city);
  if (opts.country && !parts.includes(opts.country)) parts.push(opts.country);
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
const countryIdx = rest.indexOf("--country");
// Always appended as the outermost admin context (Nominatim/Photon both show it), since
// a region extract rarely contains its own level-2 country polygon.
const country = countryIdx >= 0 ? rest[countryIdx + 1]?.trim() || null : null;
// Per-pack override for the municipality/sub-municipal admin_level boundary (see
// DEFAULT_MAX_CITY_LEVEL). Only deviating countries need to set it.
const maxCityLevelIdx = rest.indexOf("--max-city-level");
const maxCityLevelArg =
  maxCityLevelIdx >= 0 ? Number.parseInt(rest[maxCityLevelIdx + 1] ?? "", 10) : Number.NaN;
const maxCityLevel = Number.isFinite(maxCityLevelArg) ? maxCityLevelArg : DEFAULT_MAX_CITY_LEVEL;

// Admin boundary polygons for point-in-polygon hierarchy enrichment. Optional: without
// them, admin_context stays null and the client falls back to the region name.
const admins = adminsPath ? loadAdmins(adminsPath) : [];
if (adminsPath) console.error(`Loaded ${admins.length.toLocaleString()} admin areas`);

// Always rebuild from scratch — opening an existing file would append (duplicate
// `features` rows, then collide on `features_rtree.id`) since the schema uses
// CREATE TABLE IF NOT EXISTS. Drop any prior build (and stray WAL/SHM) first.
for (const suffix of ["", "-wal", "-shm", "-journal"])
  rmSync(`${output}${suffix}`, { force: true });

const db = new DatabaseSync(output);
let count = 0;
let finalCount = 0;

try {
  // Bulk-load pragmas: this file is rebuilt from scratch, durability doesn't matter.
  db.exec("PRAGMA journal_mode = OFF");
  db.exec("PRAGMA synchronous = OFF");
  db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));

  const insert = db.prepare(
    `INSERT INTO features
       (osm_type, osm_id, name, alt_names, kind, class, category, category_terms, importance, population, admin_context, address, lat, lng,
        bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat)
     VALUES (@osm_type, @osm_id, @name, @alt_names, @kind, @cls, @category, @category_terms, @importance, @population, @admin_context, @address, @lat, @lng,
        @bbox_min_lng, @bbox_min_lat, @bbox_max_lng, @bbox_max_lat)`
  );

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

    const geom = summarizeGeometry(feature.geometry);
    if (!geom) continue;

    const pop = population(tags);
    // Normalized category + FTS synonym blob, POIs only — places/streets aren't a
    // searchable metadata family (their cls like "city"/"residential" stays in class).
    // Descriptor tags (cuisine, sport) extend the blob so "sushi"/"tennis" match.
    const cat = c.kind === "poi" ? resolveCategory(c.cls) : null;
    const categoryTerms = cat ? [cat.synonyms, ...descriptorTerms(tags)].join(" ") : null;
    insert.run({
      osm_type: tags["@type"] ?? "",
      osm_id: tags["@id"] ? Number.parseInt(tags["@id"], 10) : 0,
      name: tags.name,
      alt_names: altNames(tags),
      kind: c.kind,
      cls: c.cls,
      category: cat?.category ?? null,
      category_terms: categoryTerms,
      importance: importance(c.base, pop, Boolean(tags.wikidata || tags.wikipedia)),
      population: pop,
      // Real per-feature admin hierarchy via point-in-polygon ("Neukölln, Berlin, Germany"),
      // walking only up from the feature's own rank so a place isn't labelled by its sub-areas.
      // null when no admins/country are available; the client then falls back to the pack
      // region. We deliberately never store the bare region name (identical on every row, it
      // drives the FTS IDF to ~0 and pollutes region-name queries).
      admin_context: adminContextFor(geom.lng, geom.lat, admins, {
        ownLevel:
          c.kind === "place"
            ? (PLACE_ADMIN_LEVEL[c.cls] ?? Number.POSITIVE_INFINITY)
            : Number.POSITIVE_INFINITY,
        // Only a place suppresses a same-named container (so the city "Berlin" → "Germany",
        // not "Berlin, Germany"). A POI named "Berlin" should still keep "Berlin" as context.
        ownName: c.kind === "place" ? tags.name : "",
        country,
        maxCityLevel
      }),
      address: addressLine(tags),
      lng: geom.lng,
      lat: geom.lat,
      bbox_min_lng: geom.minLng,
      bbox_min_lat: geom.minLat,
      bbox_max_lng: geom.maxLng,
      bbox_max_lat: geom.maxLat
    });

    count += 1;
    if (count % 50_000 === 0) console.error(`  ...${count.toLocaleString()} features`);
  }

  console.error("Merging duplicate features...");
  // Street segments: OSM splits a way wherever ANY tag changes, so one street is
  // many rows ("Boulevard du Larvotto" ×43 in Monaco) and a street search returns
  // `limit` identical labels. Merge per (name, admin_context) — the admin scope
  // keeps same-named streets in different towns apart ("Hauptstraße"). When a pack
  // was built without admin polygons, a coarse ~5 km grid stands in so a name-only
  // merge can't collapse distinct streets region-wide.
  db.exec(
    `CREATE TEMP TABLE street_merge AS
       SELECT min(id) AS keep_id,
              avg(lat) AS lat, avg(lng) AS lng,
              min(bbox_min_lng) AS min_lng, min(bbox_min_lat) AS min_lat,
              max(bbox_max_lng) AS max_lng, max(bbox_max_lat) AS max_lat
       FROM features
       WHERE kind = 'street'
       GROUP BY name,
                ifnull(admin_context, ''),
                CASE WHEN admin_context IS NULL THEN round(lat * 20) ELSE 0 END,
                CASE WHEN admin_context IS NULL THEN round(lng * 20) ELSE 0 END;
     UPDATE features SET
       lat = m.lat, lng = m.lng,
       bbox_min_lng = m.min_lng, bbox_min_lat = m.min_lat,
       bbox_max_lng = m.max_lng, bbox_max_lat = m.max_lat
     FROM street_merge AS m
     WHERE features.id = m.keep_id;`
  );
  const droppedStreets = db
    .prepare(
      "DELETE FROM features WHERE kind = 'street' AND id NOT IN (SELECT keep_id FROM street_merge)"
    )
    .run().changes;

  // POIs: the classic node+way double-mapping (a restaurant as both the POI node
  // and its building outline). Dedupe per (name, category, ~55 m grid), preferring
  // the node (mapper-placed point) but keeping the union extent so the building's
  // bbox survives on the kept row.
  db.exec(
    `CREATE TEMP TABLE poi_merge AS
       SELECT coalesce(min(CASE WHEN osm_type = 'node' THEN id END), min(id)) AS keep_id,
              min(bbox_min_lng) AS min_lng, min(bbox_min_lat) AS min_lat,
              max(bbox_max_lng) AS max_lng, max(bbox_max_lat) AS max_lat
       FROM features
       WHERE kind = 'poi'
       GROUP BY name, ifnull(category, ''), round(lat * 2000), round(lng * 2000);
     UPDATE features SET
       bbox_min_lng = m.min_lng, bbox_min_lat = m.min_lat,
       bbox_max_lng = m.max_lng, bbox_max_lat = m.max_lat
     FROM poi_merge AS m
     WHERE features.id = m.keep_id;`
  );
  const droppedPois = db
    .prepare(
      "DELETE FROM features WHERE kind = 'poi' AND id NOT IN (SELECT keep_id FROM poi_merge)"
    )
    .run().changes;
  console.error(
    `  merged ${Number(droppedStreets).toLocaleString()} street segments, ${Number(droppedPois).toLocaleString()} duplicate POIs`
  );
  finalCount = count - Number(droppedStreets) - Number(droppedPois);

  console.error("Populating FTS5 + R-tree...");
  db.exec(
    `INSERT INTO features_fts(rowid, name, alt_names, admin_context, category_terms, address)
       SELECT id, name, alt_names, admin_context, category_terms, address FROM features;
     INSERT INTO features_rtree(id, min_lng, max_lng, min_lat, max_lat)
       SELECT id, lng, lng, lat, lat FROM features;
     INSERT INTO features_fts(features_fts) VALUES('optimize');`
  );
  db.exec("COMMIT");
  db.exec("ANALYZE");
  db.exec("VACUUM");
} finally {
  db.close();
}

console.error(`Done: ${finalCount.toLocaleString()} features (${count.toLocaleString()} before merge) -> ${output}`);
