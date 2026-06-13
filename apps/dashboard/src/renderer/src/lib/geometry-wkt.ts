type CreateNoteArgs = Parameters<typeof window.api.fs.createNoteFile>[0];

/** The subset of createNoteFile args that determine a place's `geometry` frontmatter. */
export type GeometryCreateArgs = Pick<CreateNoteArgs, "lat" | "lng" | "geometryWkt">;

function fmtCoord(n: number): string {
  return Number.isFinite(n) ? String(n) : "0";
}

export function lineStringWkt(coords: [number, number][]): string {
  return `LINESTRING(${coords.map(([lng, lat]) => `${fmtCoord(lng)} ${fmtCoord(lat)}`).join(", ")})`;
}

export function polygonWkt(rings: [number, number][][]): string {
  const parts = rings.map(
    (ring) => `(${ring.map(([lng, lat]) => `${fmtCoord(lng)} ${fmtCoord(lat)}`).join(", ")})`
  );
  return `POLYGON(${parts.join(", ")})`;
}

/**
 * Convert a GeoJSON geometry JSON string into createNoteFile args that preserve its type:
 * points become `lat`/`lng`, lines and polygons become a `geometryWkt`. Returns null for
 * unparseable or degenerate geometry (too few coordinates to form a line/ring).
 */
export function geometryJsonToCreateArgs(geometryJson: string): GeometryCreateArgs | null {
  try {
    const geo = JSON.parse(geometryJson) as { type: string; coordinates: unknown };
    if (geo.type === "Point" && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      const [lng, lat] = geo.coordinates as number[];
      if (typeof lng !== "number" || typeof lat !== "number") return null;
      return { lat, lng };
    }
    if (geo.type === "LineString" && Array.isArray(geo.coordinates)) {
      const coords = geo.coordinates as [number, number][];
      if (coords.length < 2) return null;
      return { geometryWkt: lineStringWkt(coords) };
    }
    if (geo.type === "Polygon" && Array.isArray(geo.coordinates)) {
      const rings = (geo.coordinates as [number, number][][]).filter((r) => r.length >= 4);
      if (rings.length === 0) return null;
      return { geometryWkt: polygonWkt(rings) };
    }
  } catch {
    return null;
  }
  return null;
}
