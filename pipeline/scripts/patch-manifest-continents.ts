#!/usr/bin/env tsx
/**
 * Patch an existing manifest.json with continent grouping — WITHOUT rebuilding or
 * even having the world's dist/ on disk.
 *
 * Continent grouping is pure metadata (names + nesting); it touches no pack bytes.
 * So the live manifest can be upgraded in place: for every region already in the
 * manifest, look up its group/continent in regions.json and recompute the `groups`
 * and `continents` maps + per-region `continent`/`group` fields. Version/bbox/center
 * and all artifact data are preserved untouched.
 *
 * Use this to roll out the Continent → Country → sub-region picker to a world that's
 * already uploaded: download manifest.json from R2, patch, upload it back.
 *
 *   curl -sL "$R2/manifest.json" -o /tmp/manifest.json
 *   tsx scripts/patch-manifest-continents.ts --in /tmp/manifest.json
 *   # upload /tmp/manifest.json back to R2 (rclone/wrangler/aws cp ...)
 *
 * Regions in the manifest with no regions.json entry (renamed/removed slugs) are kept
 * as-is and warned about; they fall into the app's "Other" continent.
 *
 * Usage:
 *   tsx scripts/patch-manifest-continents.ts --in manifest.json [--out manifest.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { loadCatalog } from "./catalog.ts";

type RegionEntry = { name?: string; group?: string; continent?: string } & Record<string, unknown>;
type GroupEntry = { name: string; continent?: string; regions: string[] };
type ContinentEntry = { name: string; groups: string[] };
type Manifest = {
  schema: number;
  continents: Record<string, ContinentEntry>;
  groups: Record<string, GroupEntry>;
  regions: Record<string, RegionEntry>;
};

function optArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const inPath = optArg("in");
if (!inPath) {
  console.error("usage: patch-manifest-continents.ts --in <manifest.json> [--out <path>]");
  process.exit(1);
}
const outPath = optArg("out") ?? inPath;

const manifest = JSON.parse(readFileSync(inPath, "utf8")) as Manifest;
if (typeof manifest.regions !== "object") {
  console.error(`${inPath} is not a manifest (no regions map)`);
  process.exit(1);
}

const bySlug = new Map(loadCatalog().map((e) => [e.slug, e]));

// Recompute groups + continents from the catalog, keyed off whatever regions the
// manifest already publishes. Insertion order follows the manifest's region order.
manifest.schema = 4;
manifest.groups = {};
manifest.continents = {};
const unknown: string[] = [];

for (const [slug, region] of Object.entries(manifest.regions)) {
  const cat = bySlug.get(slug);
  if (!cat) {
    unknown.push(slug);
    // Stale grouping shouldn't linger (undefined keys drop on serialize); the app
    // files ungrouped regions into "Other".
    region.group = undefined;
    region.continent = undefined;
    continue;
  }

  region.name = region.name ?? cat.name;
  region.group = cat.group;
  region.continent = cat.continent;

  const g = manifest.groups[cat.group];
  if (g) {
    if (!g.regions.includes(slug)) g.regions.push(slug);
  } else {
    manifest.groups[cat.group] = {
      name: cat.groupName,
      continent: cat.continent,
      regions: [slug]
    };
  }

  const c = manifest.continents[cat.continent];
  if (c) {
    if (!c.groups.includes(cat.group)) c.groups.push(cat.group);
  } else {
    manifest.continents[cat.continent] = { name: cat.continentName, groups: [cat.group] };
  }
}

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.error(
  `patched ${Object.keys(manifest.regions).length} region(s) into ` +
    `${Object.keys(manifest.continents).length} continent(s) -> ${outPath}`
);
if (unknown.length) {
  console.error(
    `warning: ${unknown.length} region(s) not in regions.json (left ungrouped): ${unknown.join(", ")}`
  );
}
