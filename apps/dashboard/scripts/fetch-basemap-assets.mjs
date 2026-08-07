#!/usr/bin/env node
/**
 * Download the global basemap assets into resources/basemap-assets/, so offline
 * tiles render with no network. Same for every region, bundled with the app via
 * electron-builder `extraResources` and served over the mapos-asset:// scheme.
 *
 * Two sources: glyphs + sprites come from the public Protomaps CDN; the world
 * basemap and its geocode index come from the R2 bucket the region-pack pipeline
 * publishes to (see WORLD_BASE).
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

// The world basemap and its geocode index are built by the region-pack pipeline,
// which is a separate repo, so unlike glyphs/sprites they have no public CDN.
// The pipeline's `make upload-world` publishes them to the same public R2 bucket
// the app downloads region packs from. Public read-only URL — it already ships
// inside every release binary. Override to point at a staging bucket.
const WORLD_BASE = (
  process.env.MAPOS_WORLD_BASE_URL ?? "https://pub-858df7b1f2be43cfbc42ab2a4b444ea3.r2.dev/_world"
).replace(/\/+$/, "");

// The three stacks the @protomaps/basemaps style references.
const STACKS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const SPRITE_FLAVORS = ["light", "dark"];

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

/**
 * `world.pmtiles` is the backdrop everywhere outside a downloaded region pack, so
 * shipping without it means a blank map below zoom 7 — that one is fatal, since
 * nothing downstream (the build:* / package paths run this script) would
 * otherwise catch its absence before a publish.
 *
 * `world.sqlite` only powers the coarse global search fallback and is guarded by
 * existsSync at runtime (services/offline/geocode-query.ts), so a miss degrades
 * rather than breaks.
 */
async function fetchWorldAsset(name, required) {
  const dest = join(OUT, "basemap", name);
  if (await exists(dest)) {
    const { size } = await stat(dest);
    console.log(`  ${name}: ${(size / 1e6).toFixed(0)} MB (already present)`);
    return;
  }

  const url = `${WORLD_BASE}/${name}`;
  console.log(`  ${name}: downloading from ${url}`);
  let reason = null;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      reason = `HTTP ${res.status}`;
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      console.log(`  ${name}: ${(buf.length / 1e6).toFixed(0)} MB`);
      return;
    }
  } catch (e) {
    reason = e.message;
  }

  if (!required) {
    console.warn(`  ! ${name} unavailable (${reason})`);
    console.warn("    Search outside downloaded regions will be unavailable.");
    return;
  }
  console.error(`  ✗ ${name} unavailable (${reason})`);
  console.error("    The map would ship with NO backdrop outside downloaded regions.");
  console.error("    Set MAPOS_WORLD_BASE_URL to another source, or with access to the");
  console.error("    region-pack pipeline run `make world bundle-world` there.");
  process.exit(1);
}

async function main() {
  console.log(`Fetching basemap assets (${ALL ? "full Unicode" : "Western"}) -> ${OUT}`);

  let spriteBytes = 0;
  for (const flavor of SPRITE_FLAVORS) {
    for (const file of [
      `${flavor}.json`,
      `${flavor}.png`,
      `${flavor}@2x.json`,
      `${flavor}@2x.png`
    ]) {
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

  // A local copy always wins: `make bundle-world` from the pipeline drops fresher
  // files straight into place, and re-downloading would clobber them with
  // whatever was last published.
  await fetchWorldAsset("world.pmtiles", true);
  await fetchWorldAsset("world.sqlite", false);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
