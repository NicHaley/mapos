#!/usr/bin/env tsx
/**
 * Generate / merge the R2 manifest the client reads to discover regions.
 *
 * Scans dist/<region>/<version>/ for the three artifacts, records size + sha256,
 * and merges the entry into dist/manifest.json (keeping other regions intact).
 *
 * Usage:
 *   tsx make-manifest.ts --dist dist --region monaco --version 2026-05-28 --name Monaco
 *   tsx make-manifest.ts --dist dist --region berlin --version 2026-05-30 \
 *     --name Berlin --group germany --group-name Germany
 *
 * Regions are flat (keyed by slug); --group threads a region into a top-level
 * `groups` map so the download UI can render a country that expands into its
 * sub-regions. A group is presentation only — its members are normal regions.
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
type RegionEntry = { name?: string; group?: string; latest: string; versions: Record<string, VersionEntry> };
type GroupEntry = { name: string; regions: string[] };
type Manifest = { schema: number; groups: Record<string, GroupEntry>; regions: Record<string, RegionEntry> };

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing required --${name}`);
  process.exit(1);
}

function optArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const dist = arg("dist", "dist");
const region = arg("region");
const version = arg("version");
const name = optArg("name");
const group = optArg("group");
const groupName = optArg("group-name");

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
  : { schema: 2, groups: {}, regions: {} };
manifest.schema = 2;
manifest.groups ??= {};

const total = Object.values(artifacts).reduce((sum, a) => sum + a.bytes, 0);
if (!manifest.regions[region]) {
  manifest.regions[region] = { latest: version, versions: {} };
}
const regionEntry = manifest.regions[region];
regionEntry.latest = version;
if (name) regionEntry.name = name;
if (group) regionEntry.group = group;
regionEntry.versions[version] = {
  path: `${region}/${version}`,
  total_bytes: total,
  artifacts,
};

// Thread the region into its country group (presentation-only; members are
// normal regions). Idempotent: re-running won't duplicate the membership.
if (group) {
  const existing = manifest.groups[group];
  if (existing) {
    if (groupName) existing.name = groupName;
  } else {
    manifest.groups[group] = { name: groupName ?? titleCase(group), regions: [] };
  }
  if (!manifest.groups[group].regions.includes(region)) {
    manifest.groups[group].regions.push(region);
  }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const groupNote = group ? ` [${group}]` : "";
console.error(`manifest updated: ${region}@${version}${groupNote} (${(total / 1e6).toFixed(1)} MB)`);
