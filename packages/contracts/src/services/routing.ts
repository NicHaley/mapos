import { z } from "zod";
import { LatLngSchema } from "../primitives";

export const RouteCostingSchema = z.enum(["auto", "pedestrian", "bicycle"]);
export type RouteCosting = z.infer<typeof RouteCostingSchema>;

export const RouteDirectionsRequestSchema = z.object({
  /** Ordered list of waypoints; must have at least two. */
  locations: z.array(LatLngSchema).min(2),
  costing: RouteCostingSchema
});
export type RouteDirectionsRequest = z.infer<typeof RouteDirectionsRequestSchema>;

export const RouteMatrixRequestSchema = z.object({
  sources: z.array(LatLngSchema).min(1),
  targets: z.array(LatLngSchema).min(1),
  costing: RouteCostingSchema
});
export type RouteMatrixRequest = z.infer<typeof RouteMatrixRequestSchema>;

export const ManeuverSchema = z.object({
  /** Narrative instruction, e.g. "Turn right onto King Street". */
  instruction: z.string(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  /** Valhalla maneuver type code (kept for UI icon mapping). */
  type: z.number(),
  /** Inclusive index range into `Route.geometry.coordinates` (global across legs) that this
   *  maneuver covers — lets the UI highlight the exact segment for a step and map a click on
   *  the line back to a step. Optional: a provider may omit shape indices. */
  beginShapeIndex: z.number().optional(),
  endShapeIndex: z.number().optional()
});
export type Maneuver = z.infer<typeof ManeuverSchema>;

/**
 * Lax GeoJSON LineString validation. The provider adapter is responsible for
 * producing a well-formed geometry; this only verifies the shape so a bad
 * server response is caught before being handed to the renderer.
 */
const LineStringSchema = z.custom<GeoJSON.LineString>((data) => {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.type === "LineString" && Array.isArray(obj.coordinates);
});

export const RouteSchema = z.object({
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  geometry: LineStringSchema,
  maneuvers: z.array(ManeuverSchema)
});
export type Route = z.infer<typeof RouteSchema>;

export const MatrixCellSchema = z.object({
  distanceMeters: z.number().nullable(),
  durationSeconds: z.number().nullable()
});
export type MatrixCell = z.infer<typeof MatrixCellSchema>;

export const MatrixSchema = z.object({
  sources: z.array(LatLngSchema),
  targets: z.array(LatLngSchema),
  /** Row-major, cells[sourceIdx][targetIdx]. */
  cells: z.array(z.array(MatrixCellSchema))
});
export type Matrix = z.infer<typeof MatrixSchema>;
