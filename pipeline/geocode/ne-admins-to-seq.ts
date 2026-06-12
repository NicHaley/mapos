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
 * Naming: NE's own names are cartographic abbreviations ("Dem. Rep. Congo",
 * "United States of America") that don't match the Protomaps labels the world
 * index searches by — no NE string field matches everywhere. So each polygon is
 * renamed from the places extract via its Wikidata QID (--names), the standard
 * concordance key both datasets carry: the places layer is the single name
 * authority, NE supplies only geometry, and admin context equals the searchable
 * node's name BY CONSTRUCTION. Polygons without a QID match (disputed
 * territories, the ~97% of admin-1 provinces with no low-zoom label node) fall
 * back to NE's unabbreviated English name — safe, because what isn't a places
 * node isn't a search result, so there's nothing to be inconsistent with.
 *
 *   tsx ne-admins-to-seq.ts --names places.geojsonseq ne_50m_admin_0_countries.geojson > admins.geojsonseq
 *   tsx ne-admins-to-seq.ts --level 4 --names places.geojsonseq ne_10m_admin_1_states_provinces.geojson >> admins.geojsonseq
 */

import { readFileSync } from "node:fs";
import type { Feature, FeatureCollection } from "geojson";

const args = process.argv.slice(2);

function opt(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const level = opt("--level") ?? "2";
const namesPath = opt("--names");
// First positional = the NE file (any arg that isn't a flag or a flag's value).
const input = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
if (!input) {
  console.error(
    "usage: ne-admins-to-seq.ts [--level N] [--names PLACES.geojsonseq] NE_ADMIN.geojson > out.geojsonseq"
  );
  process.exit(1);
}

/**
 * Names from the world places extract, applying the same `name:en || name`
 * primary rule build-geocode applies to the searchable nodes — the whole point
 * is byte-identical names on both sides. `byQid` is the primary join; `nodeNames`
 * (country/state primaries only — the tiers admin polygons represent) backs the
 * fallback join for the rare node without a QID (e.g. China).
 */
function loadPlaceNames(path: string): { byQid: Map<string, string>; nodeNames: Set<string> } {
  const byQid = new Map<string, string>();
  const nodeNames = new Set<string>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = (raw.charCodeAt(0) === 0x1e ? raw.slice(1) : raw).trim();
    if (!line) continue;
    let f: Feature;
    try {
      f = JSON.parse(line) as Feature;
    } catch {
      continue;
    }
    const p = (f.properties ?? {}) as Record<string, string>;
    const name = p["name:en"]?.trim() || p.name?.trim();
    if (!name) continue;
    if (p.wikidata && !byQid.has(p.wikidata)) byQid.set(p.wikidata, name);
    if (p.place === "country" || p.place === "state") nodeNames.add(name);
  }
  return { byQid, nodeNames };
}

/** Wikidata QID across NE's admin-0 (UPPER) and admin-1 (lower) field casing. */
function pickQid(p: Record<string, unknown>): string {
  for (const key of ["wikidataid", "WIKIDATAID"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// NE name fields, unabbreviated English first ("Northern Cyprus", not NE's
// map-label "N. Cyprus"); admin-0 fields are UPPERCASE, admin-1 lowercase.
const NAME_FIELDS = ["name_en", "NAME_EN", "name", "NAME", "ADMIN", "NAME_LONG"];

function nameCandidates(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of NAME_FIELDS) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

/**
 * Polygon name, by decreasing certainty of matching the searchable node:
 * 1. Wikidata QID join (deterministic entity identity).
 * 2. Any NE name field that exactly equals a country/state node primary — covers
 *    a node missing its QID (NE "People's Republic of China" vs node "China").
 * 3. NE's unabbreviated English name. Only reached when no node matches at all
 *    (disputed territories, label-less provinces), so nothing in search can
 *    disagree with it.
 */
function resolveName(
  p: Record<string, unknown>,
  names: { byQid: Map<string, string>; nodeNames: Set<string> }
): { name: string; joined: boolean } {
  const qidName = names.byQid.get(pickQid(p));
  if (qidName) return { name: qidName, joined: true };
  const candidates = nameCandidates(p);
  const nodeMatch = candidates.find((c) => names.nodeNames.has(c));
  if (nodeMatch) return { name: nodeMatch, joined: true };
  return { name: candidates[0] ?? "", joined: false };
}

const placeNames = namesPath
  ? loadPlaceNames(namesPath)
  : { byQid: new Map<string, string>(), nodeNames: new Set<string>() };
const fc = JSON.parse(readFileSync(input, "utf8")) as FeatureCollection;
let written = 0;
let renamed = 0;
for (const f of fc.features) {
  const g = f.geometry;
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) continue;
  const p = (f.properties ?? {}) as Record<string, unknown>;
  const { name, joined } = resolveName(p, placeNames);
  if (joined) renamed += 1;
  if (!name) continue;
  // Into name:en too, so build-geocode's English-preferring loadAdmins keeps it.
  process.stdout.write(
    `${JSON.stringify({
      type: "Feature",
      geometry: g,
      properties: { name, "name:en": name, admin_level: level }
    })}\n`
  );
  written += 1;
}
console.error(
  `wrote ${written} admin_level=${level} polygons (${renamed} joined to place-node names)`
);
