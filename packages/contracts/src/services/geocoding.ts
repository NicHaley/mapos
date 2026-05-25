import { z } from "zod";
import { BBoxSchema } from "../primitives";

export const GeocodeResultSchema = z.object({
  id: z.string(),
  lat: z.number(),
  lng: z.number(),
  /** Primary display label, e.g. the place name or address line. */
  primaryLabel: z.string(),
  /** Secondary display label, e.g. "Toronto, Ontario, Canada". Empty when nothing usable. */
  secondaryLabel: z.string(),
  /** Optional extent returned by the provider (reverse geocoding rarely has it). */
  bbox: BBoxSchema.optional(),
  /** Optional OSM-style category tags, e.g. ["amenity:restaurant"]. */
  categories: z.array(z.string()).optional()
});
export type GeocodeResult = z.infer<typeof GeocodeResultSchema>;
