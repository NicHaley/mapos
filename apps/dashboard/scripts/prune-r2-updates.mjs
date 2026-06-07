#!/usr/bin/env node
// Prune old app releases from the R2 updates bucket, keeping the newest --keep
// versions (mirrors the region pipeline's RETAIN). electron-updater's differential
// downloads diff against the locally-installed copy, not old server artifacts, so
// keeping >1 is purely a rollover safety margin (a client mid-download of the prior
// version isn't cut off).
//
//   node prune-r2-updates.mjs --bucket mapos-updates --keep 2 --current 1.0.0-alpha.4 [--dry-run]
//
// Lists/deletes via rclone's `r2:` remote (RCLONE_CONFIG_R2_* must be in the env,
// same as the region pipeline). Wrangler can't list a bucket, hence rclone here.

import { execFileSync } from "node:child_process";

function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes("--dry-run");
const bucket = opt("bucket", process.env.MAPOS_R2_BUCKET ?? "mapos-updates");
const keep = Math.max(1, Number.parseInt(opt("keep", "2"), 10));
const current = opt("current", undefined);
const remote = `r2:${bucket}`;

// The four artifacts electron-builder produces per mac version. The .dmg (no
// suffix) is the cleanest single-delimiter handle for discovering versions.
const artifacts = (v) => [
  `MapOS-${v}-arm64-mac.zip`,
  `MapOS-${v}-arm64-mac.zip.blockmap`,
  `MapOS-${v}.dmg`,
  `MapOS-${v}.dmg.blockmap`
];

// Semver precedence (the subset MapOS uses: MAJOR.MINOR.PATCH[-prerelease]). A
// release outranks its prereleases, so `1.0.0` > `1.0.0-alpha.2` — the case a
// plain version sort gets backwards.
function compare(a, b) {
  const split = (v) => {
    const i = v.indexOf("-");
    const core = (i < 0 ? v : v.slice(0, i)).split(".").map(Number);
    return { core, pre: i < 0 ? "" : v.slice(i + 1) };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // release > prerelease
  if (pb.pre === "") return -1;
  const as = pa.pre.split(".");
  const bs = pb.pre.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1; // fewer identifiers = lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const rclone = (args) => execFileSync("rclone", args, { encoding: "utf8" });

let listing;
try {
  listing = rclone(["lsf", remote]);
} catch (e) {
  console.warn(`warning: could not list ${remote} — skipping prune (${e.message.split("\n")[0]})`);
  console.warn("  (RCLONE_CONFIG_R2_* not in env, or keys can't reach the bucket?)");
  process.exit(0);
}

const versions = [
  ...new Set(
    listing
      .split("\n")
      .map((f) => f.trim().match(/^MapOS-(.+)\.dmg$/)?.[1])
      .filter(Boolean)
  )
].sort((a, b) => compare(b, a)); // newest first

const kept = versions.slice(0, keep);
// Never delete the version we just published, even if discovery missed it.
const stale = versions.slice(keep).filter((v) => v !== current);

console.log(`prune: ${versions.length} version(s) on ${remote}, keep newest ${keep}`);
console.log(`  keep:  ${kept.join(", ") || "(none)"}`);
if (stale.length === 0) {
  console.log("  prune: nothing to remove");
  process.exit(0);
}
console.log(`  prune: ${stale.join(", ")}`);

for (const v of stale) {
  for (const file of artifacts(v)) {
    if (dryRun) {
      console.log(`  would delete ${file}`);
      continue;
    }
    try {
      rclone(["delete", `${remote}/${file}`]);
      console.log(`  ✗ ${file}`);
    } catch {
      // Already gone (e.g. partial earlier prune) — not an error.
    }
  }
}
