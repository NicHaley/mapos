#!/usr/bin/env tsx
/**
 * Print "<region>/<version>" for every region version beyond the newest --retain
 * (default 2), one per line. `make prune` feeds this list to `rm -rf` and
 * `rclone delete`. Mirrors the retention make-manifest.ts applies, so the manifest
 * never references a version that gets pruned.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function optArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

const dist = optArg("dist") ?? "dist";
const retain = Math.max(1, Number.parseInt(optArg("retain") ?? "2", 10));

for (const entry of readdirSync(dist).sort()) {
  if (entry.startsWith(".") || entry.startsWith("_")) continue;
  const regionDir = join(dist, entry);
  if (!isDir(regionDir)) continue;
  const versions = readdirSync(regionDir)
    .filter((v) => isDir(join(regionDir, v)))
    .sort()
    .reverse();
  for (const stale of versions.slice(retain)) {
    process.stdout.write(`${entry}/${stale}\n`);
  }
}
