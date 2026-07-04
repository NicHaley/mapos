#!/usr/bin/env tsx
/**
 * Convert an Osmosis .poly boundary file (Geofabrik publishes one for every
 * extract, at the pbf URL with `-latest.osm.pbf` -> `.poly`) into a GeoJSON
 * MultiPolygon for `pmtiles extract --region`. Clipping tile extracts to the
 * real boundary instead of the bounding box is the difference between a
 * country-sized pack and an ocean-sized one for coastal/diagonal regions.
 *
 * Format (https://wiki.openstreetmap.org/wiki/Osmosis/Polygon_Filter_File_Format):
 * first line is a name, then sections — a header line (a `!` prefix marks a
 * hole in the preceding outer ring), "lon lat" coordinate lines, END — with a
 * final END closing the file.
 *
 * Geofabrik polys for extracts spanning the antimeridian use longitudes beyond
 * ±180 (e.g. 190 for the Chatham Islands). GeoJSON consumers expect [-180, 180],
 * so rings reaching past ±180 are split at the antimeridian and the far part is
 * shifted back into range.
 *
 * Exits non-zero on anything that doesn't parse as a .poly (e.g. Geofabrik's
 * 200-status "no such file" HTML page) so callers can fall back to a bbox.
 *
 * Usage: tsx poly-to-geojson.ts input.poly output.geojson
 */

import { readFileSync, writeFileSync } from "node:fs";

type Pt = [number, number];
/** [outer, ...holes] */
type Poly = Pt[][];

function fail(msg: string): never {
  console.error(`poly-to-geojson: ${msg}`);
  process.exit(1);
}

const [input, output] = process.argv.slice(2);
if (!input || !output) fail("usage: poly-to-geojson.ts input.poly output.geojson");

const lines = readFileSync(input, "utf8").split("\n");

// ------------------------------------------------------------------ parse ----

const polys: Poly[] = [];
let ring: Pt[] | null = null;
let isHole = false;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line === "") continue;
  if (ring === null) {
    if (line === "END") break; // final END — file done
    if (/\s/.test(line)) fail(`line ${i + 1}: expected a section header, got "${line}"`);
    isHole = line.startsWith("!");
    ring = [];
    continue;
  }
  if (line === "END") {
    if (ring.length < 3) fail(`line ${i + 1}: ring with fewer than 3 points`);
    if (isHole) {
      const parent = polys[polys.length - 1];
      if (!parent) fail(`line ${i + 1}: hole before any outer ring`);
      parent.push(ring);
    } else {
      polys.push([ring]);
    }
    ring = null;
    continue;
  }
  const parts = line.split(/\s+/).map(Number);
  if (parts.length !== 2 || parts.some(Number.isNaN)) {
    fail(`line ${i + 1}: expected "lon lat", got "${line}"`);
  }
  ring.push([parts[0], parts[1]]);
}

if (ring !== null) fail("unterminated ring section");
if (polys.length === 0) fail("no rings found");

// ----------------------------------------------- antimeridian normalization ----

/** Sutherland–Hodgman clip of a ring against the half-plane keep(p) === true. */
function clipRing(r: Pt[], keep: (p: Pt) => boolean, cross: (a: Pt, b: Pt) => Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    if (keep(a)) out.push(a);
    if (keep(a) !== keep(b)) out.push(cross(a, b));
  }
  return out;
}

function atLon(x: number): (a: Pt, b: Pt) => Pt {
  return (a, b) => [x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])];
}

/**
 * Split one polygon at a meridian; the half beyond it is shifted by `shift`
 * degrees back into range. A half whose outer ring clips away entirely is
 * dropped wholesale (its holes must not get promoted to outer rings).
 */
function splitAt(poly: Poly, lon: number, beyond: (x: number) => boolean, shift: number): Poly[] {
  const side = (keep: (p: Pt) => boolean, dx: number): Poly | null => {
    const rings = poly.map((r) => clipRing(r, keep, atLon(lon)).map<Pt>((p) => [p[0] + dx, p[1]]));
    if (rings[0].length < 3) return null;
    return [rings[0], ...rings.slice(1).filter((r) => r.length >= 3)];
  };
  const near = side((p) => !beyond(p[0]), 0);
  const far = side((p) => beyond(p[0]), shift);
  return [near, far].filter((p): p is Poly => p !== null);
}

let normalized: Poly[] = polys;
if (normalized.some((p) => p.some((r) => r.some(([x]) => x > 180)))) {
  normalized = normalized.flatMap((p) => splitAt(p, 180, (x) => x > 180, -360));
}
if (normalized.some((p) => p.some((r) => r.some(([x]) => x < -180)))) {
  normalized = normalized.flatMap((p) => splitAt(p, -180, (x) => x < -180, 360));
}
if (normalized.length === 0) fail("normalization left no polygons");

// ------------------------------------------------------------------ write ----

// GeoJSON rings must be explicitly closed.
const coordinates = normalized.map((p) =>
  p.map((r) => {
    const closed = [...r];
    const [fx, fy] = closed[0];
    const [lx, ly] = closed[closed.length - 1];
    if (fx !== lx || fy !== ly) closed.push([fx, fy]);
    return closed;
  })
);

writeFileSync(output, `${JSON.stringify({ type: "MultiPolygon", coordinates })}\n`);
console.error(
  `poly-to-geojson: ${input} -> ${output} (${coordinates.length} polygon(s), ${coordinates.reduce((s, p) => s + p.length, 0)} ring(s))`
);
