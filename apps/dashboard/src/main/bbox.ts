import { bbox } from "@turf/bbox";
import type { BBox, LatLng } from "@mapos/contracts";

/**
 * Compute the bounding box for a set of points. Returns null when the list is
 * empty. Uses Turf's numerically-stable bbox implementation.
 */
export function computeBbox(points: LatLng[]): BBox | null {
  if (points.length === 0) return null;
  const fc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [p.lng, p.lat] }
    }))
  };
  const [west, south, east, north] = bbox(fc);
  return { west, south, east, north };
}

/**
 * Expand a bounding box outward by a fraction of its own size in each
 * direction. `padFraction: 0.1` adds 10% padding on each side.
 */
export function expandBbox(b: BBox, padFraction: number): BBox {
  const latSpan = b.north - b.south;
  const lngSpan = b.east - b.west;
  const padLat = latSpan * padFraction;
  const padLng = lngSpan * padFraction;
  return {
    north: Math.min(90, b.north + padLat),
    south: Math.max(-90, b.south - padLat),
    east: b.east + padLng,
    west: b.west - padLng
  };
}
