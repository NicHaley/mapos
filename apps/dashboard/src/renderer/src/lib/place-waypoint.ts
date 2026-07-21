import type { DirectionsWaypoint } from "@renderer/hooks/use-nav-tabs";
import type { PlaceRecord } from "@shared/types";

/** A representative point for a place, for use as a directions endpoint: a Point's
 *  coordinate, a LineString's midpoint, or a Polygon's first-ring vertex average.
 *  Returns null when the geometry is missing or unparseable. */
export function waypointFromPlace(place: PlaceRecord): DirectionsWaypoint | null {
  if (!place.geometry) return null;
  try {
    const geo = JSON.parse(place.geometry) as { type: string; coordinates: unknown };
    const label = place.title || "Selected place";
    if (geo.type === "Point") {
      const [lng, lat] = geo.coordinates as number[];
      if (typeof lng === "number" && typeof lat === "number") return { lat, lng, label };
    } else if (geo.type === "LineString") {
      const coords = geo.coordinates as [number, number][];
      if (coords.length > 0) {
        const [lng, lat] = coords[Math.floor(coords.length / 2)];
        return { lat, lng, label };
      }
    } else if (geo.type === "Polygon") {
      const ring = (geo.coordinates as [number, number][][])[0];
      if (ring?.length) {
        const sum = ring.reduce((a, [lng, lat]) => [a[0] + lng, a[1] + lat], [0, 0]);
        return { lat: sum[1] / ring.length, lng: sum[0] / ring.length, label };
      }
    }
  } catch {
    return null;
  }
  return null;
}
