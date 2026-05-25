import { z } from "zod";

export const LatLngSchema = z.object({
  lat: z.number(),
  lng: z.number()
});
export type LatLng = z.infer<typeof LatLngSchema>;

export const BBoxSchema = z.object({
  north: z.number(),
  south: z.number(),
  east: z.number(),
  west: z.number()
});
export type BBox = z.infer<typeof BBoxSchema>;
