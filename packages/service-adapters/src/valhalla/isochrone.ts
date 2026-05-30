import type { Endpoint, Isochrone, IsochroneRequest } from "@mapos/contracts";
import { z } from "zod";
import { fetchJson } from "../http";
import type { AdapterContext } from "../types";

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

export const ValhallaIsochroneResponseSchema = z.object({
  features: z.array(ValhallaIsochroneFeatureSchema).optional()
});
export type ValhallaIsochroneResponse = z.infer<typeof ValhallaIsochroneResponseSchema>;

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

/**
 * Build the Valhalla `/isochrone` request body. Shared by the HTTP adapter and
 * the in-process (local pack) adapter.
 */
export function buildIsochroneRequestBody(req: IsochroneRequest) {
  return {
    locations: [{ lat: req.location.lat, lon: req.location.lng }],
    costing: req.costing,
    contours: req.minutesContours.map((time) => ({ time })),
    polygons: true
  };
}

/** Map a validated Valhalla `/isochrone` response into the contract `Isochrone`. */
export function parseIsochroneResponse(data: ValhallaIsochroneResponse): Isochrone {
  const features = data.features ?? [];
  const out: Isochrone["contours"] = [];
  for (const f of features) {
    const minutes = f.properties?.contour;
    if (typeof minutes !== "number" || !f.geometry) continue;
    const polygon = toPolygon(f.geometry);
    if (!polygon) continue;
    out.push({ minutes, polygon });
  }
  out.sort((a, b) => a.minutes - b.minutes);
  return { contours: out };
}

/** HTTP transport: POST `/isochrone` to a Valhalla server, then parse. */
export async function contours(
  req: IsochroneRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Isochrone> {
  const data = await fetchJson(
    `${ep.url}/isochrone`,
    ValhallaIsochroneResponseSchema,
    { method: "POST", body: JSON.stringify(buildIsochroneRequestBody(req)) },
    { signal: ctx.signal }
  );
  return parseIsochroneResponse(data);
}
