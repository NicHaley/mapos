import { z } from "zod";

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
