#!/usr/bin/env tsx
/**
 * Batch driver: build every region in regions.json through the existing make
 * stages, one at a time. Resumable — a region is skipped when
 * dist/<slug>/<version>/ already holds all three artifacts, so re-running with
 * the same --version picks up where a crashed or interrupted batch left off.
 *
 *   tsx scripts/batch-build.ts --dry-run                 # show the work list
 *   tsx scripts/batch-build.ts --continent europe        # one continent
 *   tsx scripts/batch-build.ts --group germany --no-upload
 *   tsx scripts/batch-build.ts --slug monaco --slug us-georgia
 *   tsx scripts/batch-build.ts --retry-failed            # re-run logged failures
 *   tsx scripts/batch-build.ts --redo-pmtiles            # re-extract tiles for BUILT regions
 *                                # (e.g. after a clipping/maxzoom change; other artifacts kept)
 *
 * One batch-wide VERSION (default: today) stamps every region; pass the same
 * --version when resuming a multi-day run or the skip check restarts from zero.
 * Failures append JSONL to failures.log and the batch continues; successes are
 * logged there too so --retry-failed can key on each slug's latest outcome.
 *
 * Sequential by design: the Valhalla docker build dominates wall-clock, and one
 * download at a time is polite to Geofabrik. Don't run two drivers at once.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CatalogEntry, loadCatalog } from "./catalog.ts";

const PIPELINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(PIPELINE_DIR, "failures.log");

// Auto-load the repo-root .env (BUCKET, RCLONE_CONFIG_R2_*, DIST_DIR) so the driver
// works without sourcing it first; the spawned `make` inherits the result. Real
// environment variables win over file values. Mirrors the Makefile's `-include ../.env`.
const ENV_PATH = join(PIPELINE_DIR, "..", ".env");
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

// Built-artifact root, kept in sync with the Makefile's DIST_DIR (which reads the
// same env var — set it in the repo-root .env to build onto an external drive).
const DIST_DIR_RAW = process.env.DIST_DIR ?? "dist";
const DIST_DIR = isAbsolute(DIST_DIR_RAW) ? DIST_DIR_RAW : join(PIPELINE_DIR, DIST_DIR_RAW);

type LogLine = {
  slug: string;
  version: string;
  status: "done" | "failed";
  stage?: string;
  error?: string;
  at: string;
};

const args = process.argv.slice(2);
function flag(name: string): boolean {
  return args.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
}
function optAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === `--${name}` && !args[i + 1].startsWith("--")) out.push(args[i + 1]);
  }
  return out;
}

const version = opt("version") ?? new Date().toISOString().slice(0, 10);
const dryRun = flag("dry-run");
const noUpload = flag("no-upload");
const sleepSec = Number(opt("sleep") ?? "0");
const limit = opt("limit") ? Number(opt("limit")) : Number.POSITIVE_INFINITY;
const retain = opt("retain");
const redoPmtiles = flag("redo-pmtiles");

// ----------------------------------------------------------- select work ----

let regions = loadCatalog();

const slugs = optAll("slug");
if (slugs.length > 0) {
  const known = new Set(regions.map((r) => r.slug));
  const unknown = slugs.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    console.error(`unknown slug(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  regions = regions.filter((r) => slugs.includes(r.slug));
}
const group = opt("group");
if (group) regions = regions.filter((r) => r.group === group);
const continent = opt("continent");
if (continent) regions = regions.filter((r) => r.continent === continent);

if (flag("retry-failed")) {
  // Latest logged outcome per slug; retry only the ones that last failed.
  const latest = new Map<string, LogLine>();
  if (existsSync(LOG_PATH)) {
    for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as LogLine;
      latest.set(entry.slug, entry);
    }
  }
  regions = regions.filter((r) => latest.get(r.slug)?.status === "failed");
}

regions = regions.slice(0, Math.max(0, limit));

// --------------------------------------------------------------- helpers ----

/**
 * Built = pmtiles + geocode exist with size > 0, plus routing tiles unless the
 * valhalla stage left a .no-routing marker (roadless regions ship without
 * routing). Partial dirs re-attempt.
 */
function isBuilt(slug: string): boolean {
  const dir = join(DIST_DIR, slug, version);
  const has = (f: string): boolean => {
    const p = join(dir, f);
    return existsSync(p) && statSync(p).size > 0;
  };
  const routing = has("valhalla_tiles.tar") || existsSync(join(dir, ".no-routing"));
  return routing && has(`${slug}.pmtiles`) && has("geocode.sqlite");
}

function makeVars(r: CatalogEntry): string[] {
  return [
    `REGION=${r.slug}`,
    `SRC_URL=${r.pbfUrl}`,
    `VERSION=${version}`,
    `NAME=${r.name}`,
    `GROUP=${r.group}`,
    `GROUP_NAME=${r.groupName}`,
    ...(r.country ? [`COUNTRY=${r.country}`] : []),
    ...(r.cityLevelMax !== undefined ? [`CITY_LEVEL_MAX=${r.cityLevelMax}`] : []),
    ...(r.tilesMaxzoom !== undefined ? [`TILES_MAXZOOM=${r.tilesMaxzoom}`] : []),
    ...(retain ? [`RETAIN=${retain}`] : []),
  ];
}

function runMake(target: string, vars: string[]): void {
  const res = spawnSync("make", [target, ...vars], { cwd: PIPELINE_DIR, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`make ${target} exited with ${res.status ?? "signal"}`);
}

function logOutcome(entry: Omit<LogLine, "at">): void {
  appendFileSync(LOG_PATH, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

const sleep = (s: number): Promise<void> => new Promise((res) => setTimeout(res, s * 1000));

// ------------------------------------------------------------------- run ----

// Fail fast on a broken environment instead of logging hundreds of misleading
// per-region failures (e.g. a PATH without homebrew makes every osmium call die).
if (!dryRun) {
  const checks: Array<[string, string[]]> = [
    ["make", ["--version"]],
    ["osmium", ["--version"]],
    ["pmtiles", ["--help"]],
    ["docker", ["info"]], // also verifies the daemon is actually running
    ...(noUpload ? [] : [["rclone", ["--version"]] as [string, string[]]]),
  ];
  const missing = checks
    .filter(([cmd, args]) => spawnSync(cmd, args, { stdio: "ignore" }).status !== 0)
    .map(([cmd]) => cmd);
  if (missing.length > 0) {
    console.error(
      `preflight failed — not available in this environment: ${missing.join(", ")}\n` +
        `PATH=${process.env.PATH}`,
    );
    process.exit(1);
  }
  // An overridden DIST_DIR must already exist (the Makefile's dist-guard enforces the
  // same per region) — fail here once instead of logging a failure for every region.
  if (process.env.DIST_DIR && !existsSync(DIST_DIR)) {
    console.error(`preflight failed — DIST_DIR=${DIST_DIR} does not exist (external drive not mounted?)`);
    process.exit(1);
  }
  if (!noUpload && !Object.keys(process.env).some((k) => k.startsWith("RCLONE_CONFIG_R2_"))) {
    console.warn(
      "warning: no RCLONE_CONFIG_R2_* env vars — uploads will fail unless rclone.conf defines the r2 remote (source the .env, or pass --no-upload)",
    );
  }
}

console.log(`batch: ${regions.length} region(s), VERSION=${version}${dryRun ? " (dry run)" : ""}`);
console.log(`       resume with: --version ${version}\n`);

let built = 0;
let skipped = 0;
let failed = 0;

for (const [i, r] of regions.entries()) {
  const tag = `[${i + 1}/${regions.length}] ${r.slug}`;
  // --redo-pmtiles inverts the skip: it only touches regions already built at
  // this version, re-extracting just the tile artifact (valhalla/geocode kept).
  if (redoPmtiles ? !isBuilt(r.slug) : isBuilt(r.slug)) {
    console.log(
      `${tag} — ${redoPmtiles ? `not built at ${version}, nothing to redo` : `already built at ${version}`}, skipping`,
    );
    skipped++;
    continue;
  }
  if (dryRun) {
    console.log(`${tag} — would ${redoPmtiles ? "redo pmtiles" : "build"} (group=${r.group}, ${r.pbfUrl})`);
    continue;
  }

  let stage = redoPmtiles ? "pmtiles" : "all";
  try {
    console.log(`${tag} — ${redoPmtiles ? "re-extracting tiles" : "building"}`);
    if (redoPmtiles) {
      runMake("pmtiles", makeVars(r));
      stage = "manifest";
      runMake("manifest", makeVars(r));
    } else {
      runMake("all", makeVars(r));
    }
    if (!noUpload) {
      stage = "upload";
      runMake("upload", makeVars(r));
    }
    // Free work/<slug> (multi-GB for large regions). On failure it is kept for inspection.
    stage = "clean";
    runMake("clean", [`REGION=${r.slug}`]);
    logOutcome({ slug: r.slug, version, status: "done" });
    built++;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`${tag} — FAILED at ${stage}: ${error}`);
    logOutcome({ slug: r.slug, version, status: "failed", stage, error });
    failed++;
  }
  if (sleepSec > 0 && i < regions.length - 1) await sleep(sleepSec);
}

console.log(`\nbatch done: ${built} built, ${skipped} skipped, ${failed} failed (VERSION=${version})`);
if (failed > 0) {
  console.log(`see ${LOG_PATH}; re-run with --retry-failed --version ${version}`);
  process.exit(1);
}
