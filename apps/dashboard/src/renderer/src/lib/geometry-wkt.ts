type CreateNoteArgs = Parameters<typeof window.api.fs.createNoteFile>[0];

/** The subset of createNoteFile args that determine a place's `geometry` frontmatter. */
export type GeometryCreateArgs = Pick<CreateNoteArgs, "lat" | "lng" | "geometryWkt">;

/** How a place reads on the map. A saved route's shape is a line. */
export type GeometryKind = "point" | "line" | "area";

/** What a place's glyph should say — its shape, or that the shape is a saved trip. */
export type FileGlyphKind = GeometryKind | "route";

/**
 * The glyph kind for a place file: its geometry, except that a line carrying `route` frontmatter
 * reads as a route. Shape alone can't tell them apart — a route's `geometry` *is* a LineString —
 * so the caller passes the flag it already has.
 */
export function glyphKindOf(
  geometryJson: string | undefined,
  hasRoute: boolean
): FileGlyphKind | null {
  const kind = geometryKindOf(geometryJson);
  return kind === "line" && hasRoute ? "route" : kind;
}

/** Classify a GeoJSON geometry JSON string. Null when absent or unrecognized. */
export function geometryKindOf(geometryJson: string | undefined): GeometryKind | null {
  if (!geometryJson) return null;
  try {
    const { type } = JSON.parse(geometryJson) as { type?: string };
    if (type === "Point" || type === "MultiPoint") return "point";
    if (type === "LineString" || type === "MultiLineString") return "line";
    if (type === "Polygon" || type === "MultiPolygon") return "area";
  } catch {
    return null;
  }
  return null;
}

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

export function pointWkt(lng: number, lat: number): string {
  return `POINT(${fmtCoord(lng)} ${fmtCoord(lat)})`;
}

/**
 * Convert a GeoJSON geometry JSON string into the WKT string that goes in a place
 * file's `geometry` frontmatter. Returns null for unparseable, unsupported, or
 * degenerate geometry (too few coordinates to form a line/ring).
 */
export function geometryJsonToWkt(geometryJson: string): string | null {
  const args = geometryJsonToCreateArgs(geometryJson);
  if (!args) return null;
  if (args.geometryWkt) return args.geometryWkt;
  if (typeof args.lng === "number" && typeof args.lat === "number") {
    return pointWkt(args.lng, args.lat);
  }
  return null;
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
