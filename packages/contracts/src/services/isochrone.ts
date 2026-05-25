import { z } from "zod";
import { LatLngSchema } from "../primitives";
import { RouteCostingSchema } from "./routing";

export const IsochroneRequestSchema = z.object({
  location: LatLngSchema,
  /** Contours in minutes, e.g. [5, 10, 15]. At least one required. */
  minutesContours: z.array(z.number().positive()).min(1),
  costing: RouteCostingSchema
});
export type IsochroneRequest = z.infer<typeof IsochroneRequestSchema>;

/**
 * Lax GeoJSON Polygon validation. The provider adapter is responsible for
 * producing a well-formed geometry; this only verifies the shape.
 */
const PolygonSchema = z.custom<GeoJSON.Polygon>((data) => {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.type === "Polygon" && Array.isArray(obj.coordinates);
});

export const IsochroneSchema = z.object({
  contours: z.array(
    z.object({
      minutes: z.number(),
      polygon: PolygonSchema
    })
  )
});
export type Isochrone = z.infer<typeof IsochroneSchema>;
