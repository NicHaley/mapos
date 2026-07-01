import { z } from "zod";
import { BBoxSchema, LatLngSchema } from "../primitives";

export const GeocodeFeatureKindSchema = z.enum(["place", "poi", "street", "address"]);
export type GeocodeFeatureKind = z.infer<typeof GeocodeFeatureKindSchema>;

export const GeocodeForwardRequestSchema = z.object({
  /** Free-text query. Optional so a pure category filter ("all cafes in bbox") works. */
  query: z.string().optional(),
  /** Max results to return. Adapters may clamp to their provider's ceiling. */
  limit: z.number().int().min(1).max(50).optional(),
  /** ISO 639-1 language code, e.g. "en", "fr". */
  lang: z.string().optional(),
  /** Optional bias rectangle for results. */
  bbox: BBoxSchema.optional(),
  /** Restrict to normalized category ids, e.g. ["restaurant","cafe"]. Offline packs only. */
  categories: z.array(z.string()).optional(),
  /** Restrict to feature kinds, e.g. ["poi"]. Offline packs only. */
  kinds: z.array(GeocodeFeatureKindSchema).optional()
});
export type GeocodeForwardRequest = z.infer<typeof GeocodeForwardRequestSchema>;

export const GeocodeReverseRequestSchema = z.object({
  point: LatLngSchema,
  limit: z.number().int().min(1).max(50).optional(),
  lang: z.string().optional(),
  /** Restrict to normalized category ids ("what restaurants are near here"). Offline packs only. */
  categories: z.array(z.string()).optional(),
  /** Restrict to feature kinds, e.g. ["poi"]. Offline packs only. */
  kinds: z.array(GeocodeFeatureKindSchema).optional()
});
export type GeocodeReverseRequest = z.infer<typeof GeocodeReverseRequestSchema>;

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
  /**
   * Normalized category id (a single controlled-vocabulary token, e.g. "restaurant",
   * "fast_food"). Offline packs store this directly; Photon derives it from the OSM
   * value tag. Absent for features without a category (cities, streets).
   */
  category: z.string().optional(),
  /** OSM element type of the source feature, when known. */
  osmType: z.enum(["node", "way", "relation"]).optional(),
  /** OSM element id of the source feature, when known. Pair with osmType for a URL. */
  osmId: z.number().optional(),
  /** Wikidata QID (e.g. "Q64"), links to wikidata.org. Offline packs only for now. */
  wikidataId: z.string().optional()
});
export type GeocodeResult = z.infer<typeof GeocodeResultSchema>;
