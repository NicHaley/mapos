#!/usr/bin/env tsx
/**
 * Rebuild the R2 manifest the client reads to discover regions.
 *
 * The manifest is regenerated from a scan of dist/ — it always mirrors what is on
 * disk (and, after `make upload`, what is on R2). Per region we keep only the
 * newest --retain versions (default 2: the live version + the previous one, so a
 * client mid-download isn't broken during a rollout). Older versions are dropped
 * from the manifest here and pruned from disk/R2 by `make prune`.
 *
 * Region display metadata (name, group) lives in a per-region sidecar
 * dist/<region>/region.json, written here when --name/--group are passed at build
 * time so later scans stay deterministic without re-passing the flags.
 *
 * Usage:
 *   # refresh a region's sidecar, then rebuild the manifest:
 *   tsx make-manifest.ts --dist dist --region berlin --name Berlin \
 *     --group germany --group-name Germany --retain 2
 *   # just rebuild the manifest from whatever is already in dist:
 *   tsx make-manifest.ts --dist dist
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
type RegionMeta = { name?: string; group?: string; groupName?: string };

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

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

// Subdirectories sorted newest-first. Version dirs are ISO dates (YYYY-MM-DD) or
// fixed tags like "dev", which sort lexicographically the way we want.
function versionDirs(regionDir: string): string[] {
  return readdirSync(regionDir)
    .filter((v) => isDir(join(regionDir, v)))
    .sort()
    .reverse();
}

const dist = optArg("dist") ?? "dist";
const retain = Math.max(1, Number.parseInt(optArg("retain") ?? "2", 10));
const region = optArg("region");

// 1. Upsert the region's metadata sidecar from any provided flags (merge, so a
//    partial invocation doesn't wipe fields set earlier).
if (region) {
  const name = optArg("name");
  const group = optArg("group");
  const groupName = optArg("group-name");
  if (name || group || groupName) {
    const regionDir = join(dist, region);
    if (!isDir(regionDir)) {
      console.error(`region dir ${regionDir} does not exist`);
      process.exit(1);
    }
    const metaPath = join(regionDir, "region.json");
    const meta: RegionMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
    if (name) meta.name = name;
    if (group) meta.group = group;
    if (groupName) meta.groupName = groupName;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
}

// 2. Rebuild the manifest from a scan of dist/.
const manifest: Manifest = { schema: 2, groups: {}, regions: {} };

for (const entry of readdirSync(dist).sort()) {
  // Skip hidden files and reserved prefixes (_world is a bundled asset, not a region).
  if (entry.startsWith(".") || entry.startsWith("_")) continue;
  const regionDir = join(dist, entry);
  if (!isDir(regionDir)) continue;

  const meta: RegionMeta = existsSync(join(regionDir, "region.json"))
    ? JSON.parse(readFileSync(join(regionDir, "region.json"), "utf8"))
    : {};

  const versions: Record<string, VersionEntry> = {};
  for (const version of versionDirs(regionDir).slice(0, retain)) {
    const verDir = join(regionDir, version);
    const artifacts: Record<string, ArtifactEntry> = {};
    for (const [key, nameFor] of Object.entries(ARTIFACTS)) {
      const file = nameFor(entry);
      const path = join(verDir, file);
      if (!existsSync(path)) continue;
      artifacts[key] = { file, bytes: statSync(path).size, sha256: sha256(path) };
    }
    if (Object.keys(artifacts).length === 0) continue;
    versions[version] = {
      path: `${entry}/${version}`,
      total_bytes: Object.values(artifacts).reduce((s, a) => s + a.bytes, 0),
      artifacts,
    };
  }
  const kept = Object.keys(versions).sort().reverse();
  if (kept.length === 0) continue;

  manifest.regions[entry] = {
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.group ? { group: meta.group } : {}),
    latest: kept[0],
    versions,
  };

  if (meta.group) {
    const g = manifest.groups[meta.group];
    if (g) {
      if (meta.groupName) g.name = meta.groupName;
      if (!g.regions.includes(entry)) g.regions.push(entry);
    } else {
      manifest.groups[meta.group] = { name: meta.groupName ?? titleCase(meta.group), regions: [entry] };
    }
  }
}

const manifestPath = join(dist, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.error(
  `manifest rebuilt: ${Object.keys(manifest.regions).length} region(s), retain=${retain} -> ${manifestPath}`,
);
