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
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const ARTIFACTS = {
  pmtiles: (region: string) => `${region}.pmtiles`,
  valhalla: () => "valhalla_tiles.tar",
  geocode: () => "geocode.sqlite",
} as const;

type ArtifactEntry = { file: string; bytes: number; sha256: string };
type VersionEntry = { path: string; total_bytes: number; artifacts: Record<string, ArtifactEntry> };
type RegionEntry = {
  name?: string;
  group?: string;
  /** [minLng, minLat, maxLng, maxLat] — read from the latest pmtiles header. */
  bbox?: [number, number, number, number];
  /** [lng, lat] — pmtiles header center; used to place the region's globe marker. */
  center?: [number, number];
  latest: string;
  versions: Record<string, VersionEntry>;
};
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

/**
 * Checksum cache: re-hashing every artifact in dist/ on every run is O(total
 * bytes) — hours at world scale (~500 regions of multi-GB packs). Entries are
 * keyed by relative path and validated by (size, mtimeMs), so only new or
 * touched artifacts are hashed. Hashing streams the file (constant memory).
 * Stale keys are swept on save so the cache tracks what is actually in dist/.
 */
type ShaCacheEntry = { size: number; mtimeMs: number; sha256: string };
type ShaCache = Record<string, ShaCacheEntry>;

function loadShaCache(path: string): ShaCache {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ShaCache;
  } catch {
    return {};
  }
}

async function sha256Stream(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function cachedSha256(cache: ShaCache, path: string, key: string): Promise<string> {
  const { size, mtimeMs } = statSync(path);
  const hit = cache[key];
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.sha256;
  const sha256 = await sha256Stream(path);
  cache[key] = { size, mtimeMs, sha256 };
  return sha256;
}

/**
 * Read the bbox + center from a PMTiles v3 header without pulling in the pmtiles
 * library. The header is a fixed 127-byte struct; lon/lat are stored as int32
 * little-endian in degrees * 1e7. Spec:
 * https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md#header
 * Returns undefined if the file isn't a readable v3 PMTiles archive.
 */
function readPmtilesGeo(
  path: string,
): { bbox: [number, number, number, number]; center: [number, number] } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(127);
    if (readSync(fd, buf, 0, 127, 0) < 127) return undefined;
    if (buf.toString("ascii", 0, 7) !== "PMTiles" || buf[7] !== 3) return undefined;
    const e7 = (offset: number): number => buf.readInt32LE(offset) / 1e7;
    const minLng = e7(102);
    const minLat = e7(106);
    const maxLng = e7(110);
    const maxLat = e7(114);
    const centerLng = e7(119);
    const centerLat = e7(123);
    return { bbox: [minLng, minLat, maxLng, maxLat], center: [centerLng, centerLat] };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
const manifest: Manifest = { schema: 3, groups: {}, regions: {} };

const shaCachePath = join(dist, ".sha-cache.json");
const shaCache = loadShaCache(shaCachePath);
const seenShaKeys = new Set<string>();

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
      const cacheKey = `${entry}/${version}/${file}`;
      seenShaKeys.add(cacheKey);
      artifacts[key] = {
        file,
        bytes: statSync(path).size,
        sha256: await cachedSha256(shaCache, path, cacheKey),
      };
    }
    // Only complete versions are published. A build that died mid-region leaves
    // partial artifacts behind (and usually no region.json sidecar, so the entry
    // would surface in the UI as a bare slug under "Other") — and a partial pack
    // must never be offered to clients. Valhalla is optional: roadless regions
    // (uninhabited islands) ship without routing tiles, and the stage order
    // (pmtiles -> valhalla -> geocode) guarantees geocode.sqlite only exists
    // once valhalla finished or was deliberately skipped.
    if (!("pmtiles" in artifacts && "geocode" in artifacts)) {
      if (Object.keys(artifacts).length > 0) {
        console.error(`skipping incomplete version ${entry}/${version} (${Object.keys(artifacts).join(", ")})`);
      }
      continue;
    }
    versions[version] = {
      path: `${entry}/${version}`,
      total_bytes: Object.values(artifacts).reduce((s, a) => s + a.bytes, 0),
      artifacts,
    };
  }
  const kept = Object.keys(versions).sort().reverse();
  if (kept.length === 0) continue;

  // Geometry is stable across versions, so read it from the latest pmtiles only.
  const geo = readPmtilesGeo(join(regionDir, kept[0], `${entry}.pmtiles`));

  manifest.regions[entry] = {
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.group ? { group: meta.group } : {}),
    ...(geo ? { bbox: geo.bbox, center: geo.center } : {}),
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

// Persist the checksum cache, dropping entries for files no longer scanned
// (pruned versions, removed regions) so it stays bounded.
for (const key of Object.keys(shaCache)) {
  if (!seenShaKeys.has(key)) delete shaCache[key];
}
writeFileSync(shaCachePath, JSON.stringify(shaCache, null, 2));

const manifestPath = join(dist, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.error(
  `manifest rebuilt: ${Object.keys(manifest.regions).length} region(s), retain=${retain} -> ${manifestPath}`,
);
