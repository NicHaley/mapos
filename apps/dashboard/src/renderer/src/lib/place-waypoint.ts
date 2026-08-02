import type { DirectionsWaypoint } from "@renderer/hooks/use-nav-tabs";
import { isVaultFilePath } from "@renderer/lib/place-utils";
import type { PlaceRecord } from "@shared/types";

/** A representative point for a place, for use as a directions endpoint: a Point's
 *  coordinate, a LineString's midpoint, or a Polygon's first-ring vertex average.
 *  Returns null when the geometry is missing or unparseable. */
export function waypointFromPlace(place: PlaceRecord): DirectionsWaypoint | null {
  if (!place.geometry) return null;
  try {
    const geo = JSON.parse(place.geometry) as { type: string; coordinates: unknown };
    const label = place.title || "Selected place";
    // Provenance for a saved route's `[[wikilink]]`. Only real vault files: previews carry
    // synthetic paths (`geojson-feature:…`, POI ids) that no link could ever resolve.
    const filePath = isVaultFilePath(place.filePath) ? place.filePath : undefined;
    const at = (lat: number, lng: number): DirectionsWaypoint => ({ lat, lng, label, filePath });
    if (geo.type === "Point") {
      const [lng, lat] = geo.coordinates as number[];
      if (typeof lng === "number" && typeof lat === "number") return at(lat, lng);
    } else if (geo.type === "LineString") {
      const coords = geo.coordinates as [number, number][];
      if (coords.length > 0) {
        const [lng, lat] = coords[Math.floor(coords.length / 2)];
        return at(lat, lng);
      }
    } else if (geo.type === "Polygon") {
      const ring = (geo.coordinates as [number, number][][])[0];
      if (ring?.length) {
        const sum = ring.reduce((a, [lng, lat]) => [a[0] + lng, a[1] + lat], [0, 0]);
        return at(sum[1] / ring.length, sum[0] / ring.length);
      }
    }
  } catch {
    return null;
  }
  return null;
}
