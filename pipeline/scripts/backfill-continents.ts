#!/usr/bin/env tsx
/**
 * Backfill continent metadata into already-built region sidecars.
 *
 * The Continent → Country → sub-region picker needs each dist/<region>/region.json
 * to carry `continent`/`continentName` (and the manifest a `continents` map). Packs
 * built before those flags existed have sidecars without them, so a plain
 * `make manifest` emits an empty `continents` map and the app files everything under
 * "Other". This patches every built region's sidecar from regions.json — no artifact
 * rebuild — then rebuilds the manifest so the new grouping shows up.
 *
 * Idempotent: re-running on already-backfilled sidecars is a no-op. Region dirs with
 * no catalog entry (renamed/removed slugs) are warned about and skipped.
 *
 * Usage:
 *   tsx scripts/backfill-continents.ts                 # dist/, then rebuild manifest
 *   tsx scripts/backfill-continents.ts --dist /Volumes/T7/mapos-dist
 *   tsx scripts/backfill-continents.ts --no-manifest   # patch sidecars only
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.ts";

type RegionMeta = {
  name?: string;
  group?: string;
  groupName?: string;
  continent?: string;
  continentName?: string;
};

function optArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const dist = optArg("dist") ?? "dist";
const rebuild = !process.argv.includes("--no-manifest");

if (!existsSync(dist) || !statSync(dist).isDirectory()) {
  console.error(`dist dir ${dist} does not exist`);
  process.exit(1);
}

const bySlug = new Map(loadCatalog().map((e) => [e.slug, e]));

let patched = 0;
let unchanged = 0;
const unknown: string[] = [];

for (const entry of readdirSync(dist).sort()) {
  if (entry.startsWith(".") || entry.startsWith("_")) continue;
  const regionDir = join(dist, entry);
  if (!statSync(regionDir).isDirectory()) continue;

  const cat = bySlug.get(entry);
  if (!cat) {
    unknown.push(entry);
    continue;
  }

  const metaPath = join(regionDir, "region.json");
  const meta: RegionMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};

  // Catalog is the source of truth for display metadata — overwrite so a regrouped
  // catalog (e.g. a leaf that moved from continent-level to its own country group)
  // propagates, not just fills gaps.
  const next: RegionMeta = {
    name: meta.name ?? cat.name,
    group: cat.group,
    groupName: cat.groupName,
    continent: cat.continent,
    continentName: cat.continentName
  };

  if (JSON.stringify(next) === JSON.stringify(meta)) {
    unchanged++;
    continue;
  }
  writeFileSync(metaPath, JSON.stringify(next, null, 2));
  patched++;
}

console.error(`backfill: ${patched} patched, ${unchanged} already current`);
if (unknown.length) {
  console.error(
    `warning: ${unknown.length} region dir(s) not in regions.json (skipped): ${unknown.join(", ")}`
  );
}

if (rebuild) {
  const makeManifest = join(dirname(fileURLToPath(import.meta.url)), "make-manifest.ts");
  const res = spawnSync("pnpm", ["exec", "tsx", makeManifest, "--dist", dist], {
    stdio: "inherit"
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
