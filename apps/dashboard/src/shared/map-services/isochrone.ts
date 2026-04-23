import { z } from "zod";
import { VALHALLA_BASE } from "./config";
import { fetchJson } from "./http";
import type { Isochrone, LatLng, RouteCosting } from "./types";

const PositionSchema = z.array(z.number());

const PolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(PositionSchema))
});

const MultiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(z.array(PositionSchema)))
});

const ValhallaIsochroneFeatureSchema = z.object({
  type: z.literal("Feature").optional(),
  properties: z
    .object({
      contour: z.number().optional(),
      metric: z.string().optional()
    })
    .optional(),
  geometry: z.union([PolygonSchema, MultiPolygonSchema]).optional()
});

const ValhallaIsochroneResponseSchema = z.object({
  features: z.array(ValhallaIsochroneFeatureSchema).optional()
});

export type GetIsochroneInput = {
  location: LatLng;
  /** Contours in minutes, e.g. [5, 10, 15]. At least one required. */
  minutesContours: number[];
  costing: RouteCosting;
};

/** Take the outer ring of a Polygon or of the first polygon in a MultiPolygon. */
function toPolygon(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): GeoJSON.Polygon | null {
  if (geom.type === "Polygon") {
    if (geom.coordinates.length === 0) return null;
    const outer = geom.coordinates[0];
    if (!outer) return null;
    return { type: "Polygon", coordinates: [outer] };
  }
  if (geom.type === "MultiPolygon") {
    const first = geom.coordinates[0];
    if (!first || first.length === 0) return null;
    const outer = first[0];
    if (!outer) return null;
    return { type: "Polygon", coordinates: [outer] };
  }
  return null;
}

export async function getIsochrone(
  input: GetIsochroneInput,
  opts: { signal?: AbortSignal } = {}
): Promise<Isochrone> {
  if (input.minutesContours.length === 0) {
    throw new Error("getIsochrone requires at least one contour");
  }
  const body = {
    locations: [{ lat: input.location.lat, lon: input.location.lng }],
    costing: input.costing,
    contours: input.minutesContours.map((time) => ({ time })),
    polygons: true
  };
  const data = await fetchJson(
    `${VALHALLA_BASE}/isochrone`,
    ValhallaIsochroneResponseSchema,
    { method: "POST", body: JSON.stringify(body) },
    { signal: opts.signal }
  );
  const features = data.features ?? [];
  const contours: Isochrone["contours"] = [];
  for (const f of features) {
    const minutes = f.properties?.contour;
    if (typeof minutes !== "number" || !f.geometry) continue;
    const polygon = toPolygon(f.geometry);
    if (!polygon) continue;
    contours.push({ minutes, polygon });
  }
  contours.sort((a, b) => a.minutes - b.minutes);
  return { contours };
}
