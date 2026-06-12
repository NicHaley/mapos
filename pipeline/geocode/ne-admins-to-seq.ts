#!/usr/bin/env tsx
/**
 * Convert a Natural Earth admin GeoJSON FeatureCollection (admin-0 countries or
 * admin-1 states/provinces) into the GeoJSONSeq + admin_level shape
 * `build-geocode.ts --admins` expects, so the world index can resolve
 * "Lyon" -> "France" and "Montreal" -> "Quebec, Canada" via the same
 * point-in-polygon path region packs use (which gets its polygons from OSM).
 *
 * NE is the source because the bundled world.pmtiles has only point labels, not
 * polygons. Build-time input only — not shipped in the app.
 *
 *   tsx ne-admins-to-seq.ts ne_50m_admin_0_countries.geojson > admins.geojsonseq
 *   tsx ne-admins-to-seq.ts --level 4 ne_50m_admin_1_states_provinces.geojson >> admins.geojsonseq
 */

import { readFileSync } from "node:fs";
import type { FeatureCollection } from "geojson";

const args = process.argv.slice(2);
const levelIdx = args.indexOf("--level");
const level = levelIdx >= 0 ? args[levelIdx + 1] : "2";
const input = args.find((a, i) => a !== "--level" && args[i - 1] !== "--level");
if (!input) {
  console.error("usage: ne-admins-to-seq.ts [--level N] NE_ADMIN.geojson > out.geojsonseq");
  process.exit(1);
}

/** Clean English name across NE's admin-0 (UPPER) and admin-1 (lower) field names. */
function pickName(p: Record<string, unknown>): string {
  for (const key of ["name_en", "NAME", "name", "ADMIN", "NAME_LONG"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const fc = JSON.parse(readFileSync(input, "utf8")) as FeatureCollection;
let written = 0;
for (const f of fc.features) {
  const g = f.geometry;
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
  const name = pickName((f.properties ?? {}) as Record<string, unknown>);
  if (!name) continue;
  // name_en into name:en too, so build-geocode's English-preferring loadAdmins keeps it.
  process.stdout.write(
    `${JSON.stringify({
      type: "Feature",
      geometry: g,
      properties: { name, "name:en": name, admin_level: level }
    })}\n`
  );
  written += 1;
}
console.error(`wrote ${written} admin_level=${level} polygons`);
