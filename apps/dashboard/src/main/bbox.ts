import type { BBox, LatLng } from "@mapos/contracts";
import { bbox } from "@turf/bbox";

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
