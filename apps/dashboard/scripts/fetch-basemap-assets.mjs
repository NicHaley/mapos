#!/usr/bin/env node
/**
 * Download the Protomaps basemap glyphs + sprites this app's style uses into
 * resources/basemap-assets/, so offline tiles render with no network. These are
 * GLOBAL assets (same fonts/sprites for every region), bundled with the app via
 * electron-builder `extraResources` and served over the mapos-asset:// scheme.
 *
 *   node scripts/fetch-basemap-assets.mjs           # default: Latin/European ranges
 *   node scripts/fetch-basemap-assets.mjs --all     # full Unicode (large: tens of MB)
 *
 * Re-run after bumping @protomaps/basemaps to keep the assets in sync.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://protomaps.github.io/basemaps-assets";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "basemap-assets");

// The three stacks the @protomaps/basemaps style references.
const STACKS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const SPRITE_FLAVORS = ["light", "black"];

// 256-codepoint blocks. Default covers Latin, IPA, Greek, Cyrillic, accents and
// common punctuation/symbols — enough for Western/European labels. --all grabs
// every block (full Unicode incl. CJK/Arabic/etc.) at the cost of size.
const WESTERN_BLOCKS = [0, 1, 2, 3, 4, 5, 30, 31, 32, 33];
const ALL = process.argv.includes("--all");
const BLOCKS = ALL ? Array.from({ length: 256 }, (_, i) => i) : WESTERN_BLOCKS;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  if (await exists(dest)) return 0;
  const res = await fetch(url);
  if (!res.ok) return 0; // 404 ranges/sprites are simply skipped
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

async function mapLimit(items, limit, fn) {
  let total = 0;
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      total += await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return total;
}

async function main() {
  console.log(`Fetching basemap assets (${ALL ? "full Unicode" : "Western"}) -> ${OUT}`);

  let spriteBytes = 0;
  for (const flavor of SPRITE_FLAVORS) {
    for (const file of [`${flavor}.json`, `${flavor}.png`, `${flavor}@2x.json`, `${flavor}@2x.png`]) {
      spriteBytes += await download(`${BASE}/sprites/v4/${file}`, join(OUT, "sprites", file));
    }
  }
  console.log(`  sprites: ${(spriteBytes / 1e3).toFixed(0)} KB`);

  const jobs = [];
  for (const stack of STACKS) {
    for (const b of BLOCKS) {
      const range = `${b * 256}-${b * 256 + 255}`;
      jobs.push({
        url: `${BASE}/fonts/${encodeURIComponent(stack)}/${range}.pbf`,
        dest: join(OUT, "fonts", stack, `${range}.pbf`)
      });
    }
  }
  const fontBytes = await mapLimit(jobs, 12, (j) => download(j.url, j.dest));
  console.log(`  fonts: ${(fontBytes / 1e6).toFixed(1)} MB across ${STACKS.length} stacks`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
