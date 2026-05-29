#!/usr/bin/env tsx
/**
 * Generate / merge the R2 manifest the client reads to discover regions.
 *
 * Scans dist/<region>/<version>/ for the three artifacts, records size + sha256,
 * and merges the entry into dist/manifest.json (keeping other regions intact).
 *
 * Usage:
 *   tsx make-manifest.ts --dist dist --region monaco --version 2026-05-28
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARTIFACTS = {
  pmtiles: (region: string) => `${region}.pmtiles`,
  valhalla: () => "valhalla_tiles.tar",
  geocode: () => "geocode.sqlite",
} as const;

type ArtifactEntry = { file: string; bytes: number; sha256: string };
type VersionEntry = { path: string; total_bytes: number; artifacts: Record<string, ArtifactEntry> };
type RegionEntry = { latest: string; versions: Record<string, VersionEntry> };
type Manifest = { schema: number; regions: Record<string, RegionEntry> };

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing required --${name}`);
  process.exit(1);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const dist = arg("dist", "dist");
const region = arg("region");
const version = arg("version");

const regionDir = join(dist, region, version);
const artifacts: Record<string, ArtifactEntry> = {};
for (const [key, nameFor] of Object.entries(ARTIFACTS)) {
  const file = nameFor(region);
  const path = join(regionDir, file);
  if (!existsSync(path)) {
    console.warn(`  warning: missing ${path}, skipping ${key}`);
    continue;
  }
  artifacts[key] = { file, bytes: statSync(path).size, sha256: sha256(path) };
}

const manifestPath = join(dist, "manifest.json");
const manifest: Manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
  : { schema: 1, regions: {} };

const total = Object.values(artifacts).reduce((sum, a) => sum + a.bytes, 0);
if (!manifest.regions[region]) {
  manifest.regions[region] = { latest: version, versions: {} };
}
const regionEntry = manifest.regions[region];
regionEntry.latest = version;
regionEntry.versions[version] = {
  path: `${region}/${version}`,
  total_bytes: total,
  artifacts,
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.error(`manifest updated: ${region}@${version} (${(total / 1e6).toFixed(1)} MB)`);
