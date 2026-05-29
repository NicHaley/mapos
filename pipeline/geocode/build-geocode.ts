#!/usr/bin/env tsx
/**
 * Build a MapOS offline geocode index (SQLite + FTS5 + R-tree) from a stream of
 * GeoJSON features produced by `osmium export`.
 *
 * libosmium (via the `osmium` CLI) does the heavy lifting — node-location caching
 * and geometry assembly — and streams GeoJSONSeq on stdin. This script only
 * classifies, reduces geometry to a representative point, and loads SQLite using
 * the SAME better-sqlite3 the desktop/mobile client reads with (so FTS5 + R-tree
 * behaviour is identical at build and query time).
 *
 * Phase 1 scope: named places, POIs, and streets. House-number addresses are the
 * Phase-3 cliff and are out of scope here (the online pro geocoder covers those).
 *
 * Usage:
 *   osmium export filtered.osm.pbf -f geojsonseq -c export-config.json \
 *     | tsx build-geocode.ts OUTPUT.sqlite --region "Monaco"
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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

// --- SQLite setup --------------------------------------------------------------

const [output, ...rest] = process.argv.slice(2);
if (!output) {
  console.error("usage: build-geocode.ts OUTPUT.sqlite [--region NAME]");
  process.exit(1);
}
const regionIdx = rest.indexOf("--region");
const region = regionIdx >= 0 ? (rest[regionIdx + 1] ?? "") : "";

const db = new Database(output);
// Bulk-load pragmas: this file is rebuilt from scratch, durability doesn't matter.
db.pragma("journal_mode = OFF");
db.pragma("synchronous = OFF");
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));

const insert = db.prepare(
  `INSERT INTO features
     (osm_type, osm_id, name, alt_names, kind, class, importance, population, admin_context, lat, lng)
   VALUES (@osm_type, @osm_id, @name, @alt_names, @kind, @cls, @importance, @population, @admin_context, @lat, @lng)`,
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
    admin_context: region, // coarse for now; enrich via admins.sqlite (Phase 2)
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
