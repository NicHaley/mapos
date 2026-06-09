#!/usr/bin/env tsx
/**
 * Look up one catalog entry and print shell-evalable make variables, so a single
 * region can be built from regions.json without hand-passing URL/metadata:
 *
 *   eval $(tsx scripts/resolve-region.ts --slug us-georgia)
 *   # REGION='us-georgia' SRC_URL='https://...' NAME='Georgia' ...
 *
 * Used by the Makefile's `build-slug` target and handy for ad-hoc shells.
 */

import { loadCatalog } from "./catalog.ts";

const i = process.argv.indexOf("--slug");
const slug = i >= 0 ? process.argv[i + 1] : undefined;
if (!slug) {
  console.error("usage: resolve-region.ts --slug <slug>");
  process.exit(1);
}

const entry = loadCatalog().find((r) => r.slug === slug);
if (!entry) {
  console.error(`unknown region slug "${slug}" — see regions.json (or re-run gen-catalog.ts)`);
  process.exit(1);
}

// POSIX single-quote escaping; names can contain apostrophes (e.g. Côte d'Ivoire).
const sh = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;

const vars: Record<string, string | undefined> = {
  REGION: entry.slug,
  SRC_URL: entry.pbfUrl,
  NAME: entry.name,
  GROUP: entry.group,
  GROUP_NAME: entry.groupName,
  CONTINENT: entry.continent,
  CONTINENT_NAME: entry.continentName,
  COUNTRY: entry.country,
  CITY_LEVEL_MAX: entry.cityLevelMax?.toString(),
  TILES_MAXZOOM: entry.tilesMaxzoom?.toString(),
};
for (const [k, v] of Object.entries(vars)) {
  if (v !== undefined) console.log(`${k}=${sh(v)}`);
}
