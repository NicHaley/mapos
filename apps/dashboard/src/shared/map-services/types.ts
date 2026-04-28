/**
 * Provider-agnostic types for the MapOS map-services layer. Anything Photon- or
 * Valhalla-specific is normalized to these shapes before crossing the module
 * boundary so consumers (UI, chat tools, future external MCP) don't need to
 * care which vendor produced the data.
 */

export type LatLng = { lat: number; lng: number };

export type BBox = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type GeocodeResult = {
  id: string;
  lat: number;
  lng: number;
  /** Primary display label, e.g. the place name or address line. */
  primaryLabel: string;
  /** Secondary display label, e.g. "Toronto, Ontario, Canada". Empty when nothing usable. */
  secondaryLabel: string;
  /** Optional extent returned by the provider (reverse geocoding rarely has it). */
  bbox?: BBox;
  /** Optional OSM-style category tags, e.g. ["amenity:restaurant"]. */
  categories?: string[];
};

export type RouteCosting = "auto" | "pedestrian" | "bicycle";

export type Maneuver = {
  /** Narrative instruction, e.g. "Turn right onto King Street". */
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Valhalla maneuver type code (kept for UI icon mapping). */
  type: number;
};

export type Route = {
  distanceMeters: number;
  durationSeconds: number;
  geometry: GeoJSON.LineString;
  maneuvers: Maneuver[];
};

export type Isochrone = {
  contours: Array<{
    minutes: number;
    polygon: GeoJSON.Polygon;
  }>;
};

export type MatrixCell = {
  distanceMeters: number | null;
  durationSeconds: number | null;
};

export type Matrix = {
  sources: LatLng[];
  targets: LatLng[];
  /** Row-major, cells[sourceIdx][targetIdx]. */
  cells: MatrixCell[][];
};
