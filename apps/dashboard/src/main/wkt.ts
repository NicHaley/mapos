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
