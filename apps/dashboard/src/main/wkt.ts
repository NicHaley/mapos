import { parse } from "wellknown";

export type GeoJSONGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] };

const SUPPORTED_TYPES = new Set(["Point", "LineString", "Polygon"]);

export function parseWkt(wkt: unknown): GeoJSONGeometry | null {
  if (typeof wkt !== "string" || !wkt.trim()) return null;
  try {
    const result = parse(wkt);
    if (!result || !SUPPORTED_TYPES.has(result.type)) return null;
    return result as GeoJSONGeometry;
  } catch {
    return null;
  }
}

const coord = (c: number[]): string => `${c[0]} ${c[1]}`;
const ring = (r: number[][]): string => `(${r.map(coord).join(", ")})`;

/**
 * Serialize a GeoJSON geometry to WKT for place-file frontmatter. Only the geometry
 * types MapOS place files support (Point, LineString, Polygon) round-trip through
 * {@link parseWkt} and the renderer — anything else returns null so the caller can
 * surface a clear error rather than write a file that never appears on the map.
 */
export function geometryToWkt(geom: unknown): string | null {
  if (!geom || typeof geom !== "object") return null;
  const g = geom as { type?: string; coordinates?: unknown };
  switch (g.type) {
    case "Point":
      return `POINT(${coord(g.coordinates as number[])})`;
    case "LineString":
      return `LINESTRING(${(g.coordinates as number[][]).map(coord).join(", ")})`;
    case "Polygon":
      return `POLYGON(${(g.coordinates as number[][][]).map(ring).join(", ")})`;
    default:
      return null;
  }
}
