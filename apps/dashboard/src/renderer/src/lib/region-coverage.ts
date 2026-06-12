/**
 * Point-vs-region-pack bbox helpers, used by the map's coverage indicator. Mirrors
 * `contains()` in apps/dashboard/src/main/services/offline/installed-regions.ts (the
 * source of truth for region selection); that module is Node-only, so it can't be
 * imported into the renderer.
 */

export type Bbox = [number, number, number, number];

export function bboxContains(b: Bbox, lng: number, lat: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

export function bboxArea(b: Bbox): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
