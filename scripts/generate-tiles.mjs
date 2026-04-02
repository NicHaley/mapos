#!/usr/bin/env node
/**
 * generate-tiles.mjs
 *
 * Extracts every Geofabrik region from the latest Protomaps planet build and
 * uploads them to Cloudflare R2. Designed to run monthly.
 *
 * HOW IT WORKS
 * ────────────
 * 1. Fetches the latest planet build date from build-metadata.protomaps.dev
 * 2. Skips early if that build was already fully processed (checks R2)
 * 3. Fetches all regions from the Geofabrik index (download.geofabrik.de)
 * 4. For each region, runs `pmtiles extract` against the remote planet file
 *    using HTTP range requests — only the tiles within the bbox are downloaded
 * 5. Uploads the extract to R2 at regions/{build}/{id}.pmtiles, then deletes
 *    the local file immediately to keep disk usage bounded
 * 6. Writes manifest.json to the bucket root with URLs for every region
 *
 * RESUMABILITY
 * ────────────
 * Regions are uploaded to build-scoped paths (regions/{build}/{id}.pmtiles).
 * If the script is interrupted, re-running it will skip regions already
 * uploaded for the current build and continue from where it left off.
 * Each monthly build uses a different path, so old and new builds coexist
 * in R2 until you clean them up.
 *
 * MANIFEST
 * ────────
 * After all regions are processed, manifest.json is written to the bucket root.
 * It contains the current build date and a URL + metadata entry for every
 * region. MapOS fetches this on startup to populate the region picker — the
 * manifest URL is stable across builds even though tile URLs include the date.
 *
 *   https://your-r2-url/manifest.json       ← stable, updated each build
 *   https://your-r2-url/regions/20260401/   ← build-scoped tile files
 *
 * SETUP
 * ─────
 * Dependencies: node >= 18, pmtiles CLI, rclone
 *   brew install rclone
 *   brew install protomaps/homebrew-protomaps/pmtiles
 *
 * Copy .env.example to .env and fill in your R2 credentials:
 *   cp .env.example .env
 *
 * USAGE
 * ─────
 *   node scripts/generate-tiles.mjs              # full run
 *   TEST_REGION=1 node scripts/generate-tiles.mjs  # process one region only
 *   DRY_RUN=1 node scripts/generate-tiles.mjs    # list regions, no extraction
 *   FORCE=1 node scripts/generate-tiles.mjs      # re-run even if already done
 *
 * ENVIRONMENT VARIABLES
 * ─────────────────────
 * Required (set in .env):
 *   BUCKET                              R2 bucket name
 *   R2_PUBLIC_URL                       Public base URL for the bucket, no trailing slash
 *                                       e.g. https://pub-abc123.r2.dev
 *   RCLONE_CONFIG_R2_ACCESS_KEY_ID      R2 access key ID
 *   RCLONE_CONFIG_R2_SECRET_ACCESS_KEY  R2 secret access key
 *   RCLONE_CONFIG_R2_ENDPOINT           R2 S3-compatible endpoint
 *                                       e.g. https://<account_id>.r2.cloudflarestorage.com
 *
 * Optional:
 *   CONCURRENCY   Parallel extract/upload workers (default: 4)
 *   MAX_ZOOM      Highest zoom level to include in extracts (default: 14)
 *   OUTPUT_DIR    Temp directory for in-progress extracts (default: /tmp/mapos-tiles)
 *   SKIP_IDS      Space-separated region IDs to skip, e.g. "africa europe"
 *   DRY_RUN       "1" — print regions and bboxes, skip all extraction and upload
 *   FORCE         "1" — re-extract and re-upload even if already done this build
 *   TEST_REGION   "1" — only process the first region (useful for smoke testing)
 *   ENV_FILE      Path to .env file (default: ../.env relative to this script)
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

// ── Load .env ──────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = process.env.ENV_FILE ?? join(__dirname, "..", ".env");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ── Config ─────────────────────────────────────────────────────────────────

const REQUIRED = [
  "BUCKET",
  "R2_PUBLIC_URL",
  "RCLONE_CONFIG_R2_ACCESS_KEY_ID",
  "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY",
  "RCLONE_CONFIG_R2_ENDPOINT"
];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`ERROR: ${key} is required`);
    process.exit(1);
  }
}

const BUCKET = process.env.BUCKET;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? "4", 10);
const MAX_ZOOM = process.env.MAX_ZOOM ?? "14";
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "/tmp/mapos-tiles";
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE = process.env.FORCE === "1";
const SKIP_IDS = new Set((process.env.SKIP_IDS ?? "").split(/\s+/).filter(Boolean));
const TEST_REGION = process.env.TEST_REGION === "1";

// rclone picks these up automatically for the "r2" remote
process.env.RCLONE_CONFIG_R2_TYPE = "s3";
process.env.RCLONE_CONFIG_R2_PROVIDER = "Cloudflare";

// ── Helpers ────────────────────────────────────────────────────────────────

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const warn = (msg) => console.warn(`[${new Date().toISOString().slice(11, 19)}] WARN: ${msg}`);

function bboxFromGeometry(geometry) {
  if (!geometry) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  function visit(coords) {
    if (typeof coords[0] === "number") {
      if (coords[0] < minX) minX = coords[0];
      if (coords[1] < minY) minY = coords[1];
      if (coords[0] > maxX) maxX = coords[0];
      if (coords[1] > maxY) maxY = coords[1];
    } else {
      for (const c of coords) visit(c);
    }
  }
  visit(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function r2Upload(localPath, remoteKey) {
  await exec("rclone", ["copyto", localPath, `r2:${BUCKET}/${remoteKey}`, "--quiet"]);
}

async function r2Exists(remoteKey) {
  try {
    await exec("rclone", ["ls", `r2:${BUCKET}/${remoteKey}`]);
    return true;
  } catch {
    return false;
  }
}

async function r2Read(remoteKey) {
  try {
    const { stdout } = await exec("rclone", ["cat", `r2:${BUCKET}/${remoteKey}`]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function r2WriteString(content, remoteKey) {
  const tmp = join(OUTPUT_DIR, remoteKey.replaceAll("/", "__"));
  await writeFile(tmp, content);
  await r2Upload(tmp, remoteKey);
  await unlink(tmp);
}

// Runs up to `concurrency` async tasks in parallel, working through `items`.
async function parallel(items, concurrency, fn) {
  const queue = [...items];
  async function worker() {
    while (queue.length > 0) {
      await fn(queue.shift());
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// ── Step 1: Detect latest build ────────────────────────────────────────────

log("Fetching latest planet build...");
const buildsRes = await fetch("https://build-metadata.protomaps.dev/builds.json");
const builds = await buildsRes.json();
const latest = builds.at(-1);
const BUILD = latest.key.replace(".pmtiles", ""); // e.g. "20260401"
const SOURCE = `https://build.protomaps.com/${latest.key}`;
log(`Planet build: ${BUILD}  (${SOURCE})`);

// ── Step 2: Skip if already processed ─────────────────────────────────────

if (!FORCE && !DRY_RUN) {
  const lastProcessed = await r2Read("builds/latest-processed.txt");
  if (lastProcessed === BUILD) {
    log(`Build ${BUILD} already processed. Exiting. (Set FORCE=1 to re-run)`);
    process.exit(0);
  }
}

// ── Step 3: Fetch Geofabrik region index ───────────────────────────────────

log("Fetching Geofabrik region index...");
const geoRes = await fetch("https://download.geofabrik.de/index-v1.json");
const geo = await geoRes.json();

let regions = geo.features
  .map((f) => ({
    id: f.properties.id,
    name: f.properties.name,
    parent: f.properties.parent ?? "",
    bbox: bboxFromGeometry(f.geometry)
  }))
  .filter((r) => r.bbox !== null);

if (TEST_REGION) {
  regions = regions.slice(0, 1);
  log(`TEST_REGION=1 — only processing "${regions[0].id}"`);
}

log(`Processing ${regions.length} region(s) at concurrency ${CONCURRENCY}`);

if (DRY_RUN) {
  for (const r of regions) {
    console.log(`  [dry-run]  ${r.id.padEnd(50)}  bbox: ${r.bbox.join(", ")}`);
  }
  log("Dry run complete.");
  process.exit(0);
}

// ── Step 4: Extract and upload each region ─────────────────────────────────

await mkdir(OUTPUT_DIR, { recursive: true });

const succeeded = [];
const failed = [];

async function processRegion(region) {
  const { id, name, parent, bbox } = region;

  if (SKIP_IDS.has(id)) {
    log(`[${id}] Skipped`);
    return;
  }

  const outfile = join(OUTPUT_DIR, `${id.replaceAll("/", "__")}.pmtiles`);
  const remoteKey = `regions/${BUILD}/${id}.pmtiles`;
  const bboxStr = bbox.join(",");

  if (!FORCE && (await r2Exists(remoteKey))) {
    log(`[${id}] Already uploaded for build ${BUILD}, skipping`);
    const { stdout } = await exec("rclone", ["ls", `r2:${BUCKET}/${remoteKey}`]);
    const size = Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
    succeeded.push({ id, name, parent, bbox, size_bytes: size });
    return;
  }

  log(`[${id}] Extracting...`);

  try {
    await exec(
      "pmtiles",
      ["extract", SOURCE, outfile, `--bbox=${bboxStr}`, `--maxzoom=${MAX_ZOOM}`],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const { size } = await stat(outfile);
    log(`[${id}] Uploading ${formatBytes(size)}...`);

    await r2Upload(outfile, remoteKey);
    await unlink(outfile);

    succeeded.push({ id, name, parent, bbox, size_bytes: size });
    log(`[${id}] Done`);
  } catch (err) {
    warn(`[${id}] Failed — ${err.stderr?.trim() ?? err.message}`);
    failed.push(id);
    await unlink(outfile).catch(() => {});
  }
}

await parallel(regions, CONCURRENCY, processRegion);

// ── Step 5: Generate and upload manifest ───────────────────────────────────

log("Generating manifest.json...");

const manifest = {
  build: BUILD,
  generated_at: new Date().toISOString(),
  regions: succeeded.map((r) => ({
    id: r.id,
    name: r.name,
    parent: r.parent,
    bbox: r.bbox,
    url: `${PUBLIC_URL}/regions/${BUILD}/${r.id}.pmtiles`,
    size_bytes: r.size_bytes
  }))
};

const manifestPath = join(OUTPUT_DIR, "manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await r2Upload(manifestPath, "manifest.json");
await unlink(manifestPath);
log(`Manifest uploaded → r2:${BUCKET}/manifest.json`);

// ── Step 6: Mark build as processed ───────────────────────────────────────

await r2WriteString(BUILD, "builds/latest-processed.txt");
log(`Marked build ${BUILD} as processed`);

// ── Summary ────────────────────────────────────────────────────────────────

const skipped = regions.length - succeeded.length - failed.length;

console.log("\n========================================");
console.log(`  Build:    ${BUILD}`);
console.log(`  Success:  ${succeeded.length}`);
console.log(`  Failed:   ${failed.length}`);
console.log(`  Skipped:  ${skipped}`);
console.log("========================================\n");

if (failed.length > 0) {
  console.log("Failed regions:");
  for (const id of failed) console.log(`  ${id}`);
  process.exit(1);
}
