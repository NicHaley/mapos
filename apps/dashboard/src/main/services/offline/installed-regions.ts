import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A downloaded region pack on disk, with which artifacts it actually has and its
 * bounding box (from the `.pack.json` sidecar). This is the source of truth for
 * "which packs are active" — there is no separate active-region setting: every
 * fully-installed pack is live, and callers pick the right one per request by bbox.
 */
export type InstalledRegion = {
  region: string;
  dir: string;
  /** [minLng, minLat, maxLng, maxLat], when the sidecar recorded it. */
  bbox?: [number, number, number, number];
  pmtiles?: string;
  geocode?: string;
  valhalla?: string;
};

const PACK_META_FILENAME = ".pack.json";

function isBbox(v: unknown): v is [number, number, number, number] {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number");
}

/**
 * List fully-installed packs under `regionsDir`. A pack counts as installed only
 * once its `.pack.json` marker exists (downloads write it last), so half-downloaded
 * dirs are ignored. Reserved/hidden names (`_world`, dotfiles) are skipped.
 */
export function listInstalledRegions(regionsDir: string): InstalledRegion[] {
  if (!existsSync(regionsDir)) return [];
  const out: InstalledRegion[] = [];
  for (const region of readdirSync(regionsDir)) {
    if (region.startsWith(".") || region.startsWith("_")) continue;
    const dir = join(regionsDir, region);
    if (!existsSync(join(dir, PACK_META_FILENAME))) continue;

    let bbox: [number, number, number, number] | undefined;
    try {
      const meta = JSON.parse(readFileSync(join(dir, PACK_META_FILENAME), "utf8")) as {
        bbox?: unknown;
      };
      if (isBbox(meta.bbox)) bbox = meta.bbox;
    } catch {
      /* unreadable sidecar — still usable, just without bbox */
    }

    const pmtiles = join(dir, `${region}.pmtiles`);
    const geocode = join(dir, "geocode.sqlite");
    const valhalla = join(dir, "valhalla_tiles.tar");
    out.push({
      region,
      dir,
      bbox,
      ...(existsSync(pmtiles) ? { pmtiles } : {}),
      ...(existsSync(geocode) ? { geocode } : {}),
      ...(existsSync(valhalla) ? { valhalla } : {})
    });
  }
  return out;
}

function contains(b: [number, number, number, number], lng: number, lat: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

/**
 * Packs whose bbox contains the point. Packs without bbox metadata are treated as
 * candidates (fail-open) only when no bbox'd pack matches — so an older pack missing
 * geometry still serves requests rather than silently dropping out.
 *
 * Pass `failOpen: false` when a geographically-wrong pack is worse than none: routing
 * routes strictly within one pack's tiles, so a bbox-less pack that doesn't actually
 * cover the point can't produce a valid route — better to report "no coverage" than
 * to route against an arbitrary pack.
 */
export function regionsContaining(
  regions: InstalledRegion[],
  lng: number,
  lat: number,
  { failOpen = true }: { failOpen?: boolean } = {}
): InstalledRegion[] {
  const hits = regions.filter((r) => r.bbox && contains(r.bbox, lng, lat));
  if (hits.length || !failOpen) return hits;
  return regions.filter((r) => !r.bbox);
}
