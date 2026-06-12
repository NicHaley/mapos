#!/usr/bin/env tsx
/**
 * Generate regions.json — the full build catalog — from the Geofabrik index.
 *
 * Coverage policy: LEAF extracts only. A leaf is an entry no other entry names as
 * parent, computed AFTER dropping EXCLUDE — so excluding a sole child (enfield)
 * promotes its parent (greater-london) back to a leaf. This yields full world
 * coverage with no overlap: subregions where a country is split, the country
 * itself otherwise. Continents and redundant combo extracts are excluded;
 * combos that are the ONLY coverage of their countries (gcc-states,
 * israel-and-palestine, ...) are kept.
 *
 * The catalog is checked in. Re-run when Geofabrik reshuffles; output is
 * deterministic (stable sort, no timestamps) so a re-run with an unchanged
 * index is byte-identical.
 *
 * Usage:
 *   tsx scripts/gen-catalog.ts                  # fetch live index, write regions.json
 *   tsx scripts/gen-catalog.ts --index /tmp/geofabrik-index.json
 *   tsx scripts/gen-catalog.ts --check          # exit 1 if regions.json is stale
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CATALOG_PATH, type CatalogEntry } from "./catalog.ts";

const INDEX_URL = "https://download.geofabrik.de/index-v1-nogeom.json";

/**
 * Extracts whose area is fully covered by other entries in the catalog —
 * verified against the 2026-06 index (each member exists as its own extract).
 * `enfield` is the inverse case: a lone London-borough extract whose presence
 * would demote greater-london to a non-leaf and leave the rest of London
 * uncovered.
 */
const EXCLUDE = new Set([
  "alps", //                 overlaps the individual Alpine countries
  "britain-and-ireland", //  overlaps united-kingdom tree + ireland-and-northern-ireland
  "dach", //                 overlaps germany, austria, switzerland
  "great-britain", //        overlaps england, scotland, wales (under united-kingdom)
  "sea", //                  South-East Asia; overlaps the individual SEA countries
  "south-africa-and-lesotho", // overlaps south-africa + lesotho
  "us", //                   whole-US node Geofabrik added in 2026; the us/* states
  //                         still parent to north-america, so it reads as a childless
  //                         leaf and would double-cover every state
  "us-midwest", //           the five US regional combos overlap the us/* states
  "us-northeast",
  "us-pacific",
  "us-south",
  "us-west",
  "enfield" //              single-borough extract; keep greater-london whole instead
]);

/**
 * Reviewed leaves that match the "looks like a combo" heuristic (childless,
 * shallow, no single ISO code) but are legitimately kept — either sole coverage
 * of their countries or real territories. Anything matching the heuristic that
 * is in neither this set nor EXCLUDE triggers a warning so a future Geofabrik
 * reshuffle gets reviewed instead of silently double-covering.
 */
const REVIEWED_KEEP = new Set([
  "antarctica",
  "azores",
  "canary-islands",
  "comores",
  "gcc-states", //            sole coverage of QA/AE/OM/BH/KW
  "guernsey-jersey",
  "haiti-and-domrep", //      sole coverage of HT/DO
  "isle-of-man",
  "israel-and-palestine", //  sole coverage of IL/PS
  "kosovo",
  "malaysia-singapore-brunei", // sole coverage of MY/SG/BN
  "senegal-and-gambia", //    sole coverage of SN/GM
  // Russia's federal districts: the real leaves of the russia root.
  "central-fed-district",
  "crimean-fed-district",
  "far-eastern-fed-district",
  "kaliningrad",
  "north-caucasus-fed-district",
  "northwestern-fed-district",
  "siberian-fed-district",
  "south-fed-district",
  "ural-fed-district",
  "volga-fed-district"
]);

/**
 * Continent reassignment for top-level Geofabrik roots that are really countries,
 * not continents. Russia is its own root (no continent parent) and straddles
 * Europe/Asia; we file it under Europe so the picker tree stays Continent →
 * Country → sub-region with no one-country "continents". Antarctica stays its own
 * root because it genuinely is a continent.
 */
const CONTINENT_OVERRIDES: Record<string, { slug: string; name: string }> = {
  russia: { slug: "europe", name: "Europe" }
};

/** Geocode admin-context country for kept leaves the ISO walk can't resolve. */
const COUNTRY_OVERRIDES: Record<string, string> = {
  azores: "Portugal",
  "canary-islands": "Spain",
  kosovo: "Kosovo",
  "isle-of-man": "Isle of Man"
};

/** Per-country CITY_LEVEL_MAX overrides (countries whose city admin_level deviates from 8). */
const CITY_LEVEL_MAX: Record<string, number> = { japan: 7 };

/**
 * Per-region tile maxzoom caps. Antarctica's Mercator footprint is the full
 * longitude band under extreme polar inflation — at the default z15 even a
 * boundary-clipped extract is planet-scale (the bbox version came out at 89 GB).
 * z10 keeps coastline and stations legible at a sane size.
 */
const TILES_MAXZOOM: Record<string, number> = { antarctica: 10 };

type IndexEntry = {
  id: string;
  parent?: string;
  name: string;
  urls: { pbf?: string };
  "iso3166-1:alpha2"?: string[];
};

function optArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function slugify(id: string): string {
  return id
    .toLowerCase()
    .replace(/[/\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Geofabrik authors some index names with an embedded HTML break for their
// download site, e.g. "Vestlandet<br />(Western Norway)". Flatten to one line.
function cleanName(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "us/district-of-columbia" -> "District of Columbia" (particles stay lowercase).
function titleCaseId(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last
    .split("-")
    .map((w, i) =>
      i > 0 && ["of", "and", "the"].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(" ");
}

async function loadIndex(src: string): Promise<IndexEntry[]> {
  const text = /^https?:\/\//.test(src)
    ? await (await fetch(src)).text()
    : readFileSync(src, "utf8");
  const parsed = JSON.parse(text) as { features: Array<{ properties: IndexEntry }> };
  return parsed.features.map((f) => ({ ...f.properties, name: cleanName(f.properties.name) }));
}

const entries = await loadIndex(optArg("index") ?? INDEX_URL);
const byId = new Map(entries.map((e) => [e.id, e]));

for (const id of [...EXCLUDE, ...REVIEWED_KEEP]) {
  if (!byId.has(id)) console.warn(`warning: curated id "${id}" no longer in the Geofabrik index`);
}

// Leaves of the PRUNED tree: drop EXCLUDE first so an excluded sole child
// (enfield) returns its parent (greater-london) to the leaf set.
const kept = entries.filter((e) => !EXCLUDE.has(e.id));
const hasChild = new Set(kept.filter((e) => e.parent).map((e) => e.parent as string));
const leaves = kept.filter((e) => !hasChild.has(e.id));

/** [leaf, parent, ..., root] */
function chain(e: IndexEntry): IndexEntry[] {
  const out = [e];
  let cur = e;
  while (cur.parent) {
    const p = byId.get(cur.parent);
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}

const singleIso = (e: IndexEntry): boolean => e["iso3166-1:alpha2"]?.length === 1;

// Combo-grouping tripwire: childless, shallow, no single ISO country code.
// Every current match is curated (EXCLUDE or REVIEWED_KEEP); warn on novelties.
for (const leaf of leaves) {
  const c = chain(leaf);
  if (
    c.length <= 2 &&
    !singleIso(leaf) &&
    !leaf.id.startsWith("us/") &&
    !REVIEWED_KEEP.has(leaf.id)
  ) {
    console.warn(
      `warning: unreviewed shallow leaf "${leaf.id}" (${leaf.name}) — check it is not an overlapping combo extract, then add it to REVIEWED_KEEP or EXCLUDE`
    );
  }
}

const regions: CatalogEntry[] = [];
for (const leaf of leaves) {
  const c = chain(leaf);
  const root = c[c.length - 1];
  if (root === leaf && hasChildren(leaf)) continue; // continents are never leaves, but be safe

  const pbfUrl = leaf.urls.pbf;
  if (!pbfUrl) {
    console.warn(`warning: leaf "${leaf.id}" has no pbf url — skipped`);
    continue;
  }

  // Display name. US states mostly carry their raw id as name in the index.
  let name = leaf.name === leaf.id ? titleCaseId(leaf.id) : leaf.name;
  // Deep leaves (German regbez, English counties, Greater London) are ambiguous
  // without context; qualify with the immediate parent.
  if (c.length >= 4) name = `${name} (${c[1].name})`;

  let group: string;
  let groupName: string;
  let country: string | undefined;
  if (c.some((n) => n.id.startsWith("us/"))) {
    // States hang off north-america with us/-prefixed ids (and us/california's
    // leaves are norcal/socal). The `us` node itself is EXCLUDEd as redundant.
    group = "united-states";
    groupName = "United States";
    country = "United States";
  } else {
    // Group at the COUNTRY level: the nearest single-ISO node in the chain,
    // INCLUDING the leaf — so a whole-country leaf (Algeria) groups under itself
    // rather than its continent, keeping every group at one consistent level.
    // Multi-country combos with no single ISO (gcc-states, israel-and-palestine)
    // have no country, so they become their own country-level group.
    const countryNode = c.find(singleIso) ?? leaf;
    group = slugify(countryNode.id);
    groupName = countryNode.name;
    country = c.find(singleIso)?.name ?? COUNTRY_OVERRIDES[leaf.id];
  }

  const cityLevelMax = c.map((n) => CITY_LEVEL_MAX[n.id]).find((v) => v !== undefined);

  regions.push({
    slug: slugify(leaf.id),
    geofabrikId: leaf.id,
    name,
    group,
    groupName,
    ...(country ? { country } : {}),
    continent: CONTINENT_OVERRIDES[root.id]?.slug ?? root.id,
    continentName: CONTINENT_OVERRIDES[root.id]?.name ?? root.name,
    pbfUrl,
    ...(cityLevelMax !== undefined ? { cityLevelMax } : {}),
    ...(leaf.id in TILES_MAXZOOM ? { tilesMaxzoom: TILES_MAXZOOM[leaf.id] } : {})
  });
}

function hasChildren(e: IndexEntry): boolean {
  return hasChild.has(e.id);
}

// Stable order -> reviewable diffs.
regions.sort((a, b) => a.group.localeCompare(b.group) || a.slug.localeCompare(b.slug));

const dupes = regions.map((r) => r.slug).filter((s, i, all) => all.indexOf(s) !== i);
if (dupes.length > 0) {
  console.error(`slug collisions: ${[...new Set(dupes)].join(", ")}`);
  process.exit(1);
}

const out = optArg("out") ?? CATALOG_PATH;
const json = `${JSON.stringify({ source: INDEX_URL, regions }, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== json) {
    console.error(`${out} is stale — re-run scripts/gen-catalog.ts`);
    process.exit(1);
  }
  console.error(`${out} is up to date (${regions.length} regions)`);
} else {
  writeFileSync(out, json);
  console.error(`wrote ${regions.length} regions -> ${out}`);
}
