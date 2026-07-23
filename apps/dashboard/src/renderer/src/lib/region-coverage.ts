/**
 * Point-vs-region-pack bbox helpers, used by the map's coverage indicator. Mirrors
 * `contains()` in apps/dashboard/src/main/services/offline/installed-regions.ts (the
 * source of truth for region selection); that module is Node-only, so it can't be
 * imported into the renderer.
 */

import type { InstalledRegionPack } from "@shared/types";
import type { RegionRow } from "../hooks/use-region-packs";

export type Bbox = [number, number, number, number];

export function bboxContains(b: Bbox, lng: number, lat: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

export function bboxArea(b: Bbox): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}

/**
 * A bbox usable for point-location. A region crossing the antimeridian (Alaska, NZ, Fiji,
 * Russia's Far East…) gets a header bbox that wraps to the full -180..180 span, so it "contains"
 * points an ocean away — reject anything spanning half the globe or more.
 */
export function bboxUsable(b: Bbox): boolean {
  return b[2] - b[0] < 180;
}

/** Region-pack coverage at a single point, in priority order. */
export type CoverageAt =
  | { kind: "covered"; pack: InstalledRegionPack }
  | { kind: "available" | "error" | "downloading"; row: RegionRow }
  | { kind: "none" };

/**
 * Which region pack covers a point: an installed pack if one does (smallest box = most
 * specific), otherwise the smallest not-yet-downloaded region available here, otherwise
 * nothing. Shared by the on-map coverage pill and the directions panel so both agree.
 */
export function resolveCoverageAt(
  installedPacks: InstalledRegionPack[],
  regions: RegionRow[],
  lng: number,
  lat: number
): CoverageAt {
  const installedHere = installedPacks
    .filter((p) => p.bbox && bboxContains(p.bbox, lng, lat))
    .sort((a, b) => bboxArea(a.bbox as Bbox) - bboxArea(b.bbox as Bbox));
  if (installedHere.length > 0) return { kind: "covered", pack: installedHere[0] };

  const candidates = regions.filter(
    (r) =>
      r.bbox &&
      bboxContains(r.bbox, lng, lat) &&
      (r.status === "available" ||
        r.status === "error" ||
        r.status === "downloading" ||
        r.status === "verifying")
  );
  if (candidates.length === 0) return { kind: "none" };

  const active = candidates.find((r) => r.status === "downloading" || r.status === "verifying");
  if (active) return { kind: "downloading", row: active };

  // Smallest box = the most specific region covering this spot.
  const target = candidates
    .slice()
    .sort((a, b) => bboxArea(a.bbox as Bbox) - bboxArea(b.bbox as Bbox))[0];
  return { kind: target.status === "error" ? "error" : "available", row: target };
}
