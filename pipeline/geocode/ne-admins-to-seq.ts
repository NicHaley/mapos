#!/usr/bin/env tsx
/**
 * Convert a Natural Earth admin-0 (countries) GeoJSON FeatureCollection into the
 * GeoJSONSeq + admin_level=2 shape `build-geocode.ts --admins` expects, so the
 * world index can resolve "Lyon" -> "France" via the same point-in-polygon path
 * region packs use (which normally gets its admin polygons from the OSM extract).
 *
 * NE is the source because the bundled world.pmtiles has only point labels for
 * countries, not polygons. Only used at build time — not shipped in the app.
 *
 *   tsx ne-admins-to-seq.ts ne_50m_admin_0_countries.geojson > world-admins.geojsonseq
 */

import { readFileSync } from "node:fs";
import type { FeatureCollection } from "geojson";

const input = process.argv[2];
if (!input) {
  console.error("usage: ne-admins-to-seq.ts NE_ADMIN0.geojson > out.geojsonseq");
  process.exit(1);
}

const fc = JSON.parse(readFileSync(input, "utf8")) as FeatureCollection;
let written = 0;
for (const f of fc.features) {
  const g = f.geometry;
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
  const p = (f.properties ?? {}) as Record<string, unknown>;
  // NAME is the clean English short form ("United Kingdom"); ADMIN/NAME_LONG are
  // the long forms. Prefer the short name so city secondary labels read well.
  const name =
    (typeof p.NAME === "string" && p.NAME) ||
    (typeof p.ADMIN === "string" && p.ADMIN) ||
    (typeof p.NAME_LONG === "string" && p.NAME_LONG) ||
    "";
  if (!name) continue;
  process.stdout.write(
    `${JSON.stringify({
      type: "Feature",
      geometry: g,
      properties: { name, admin_level: "2" }
    })}\n`
  );
  written += 1;
}
console.error(`wrote ${written} country polygons`);
