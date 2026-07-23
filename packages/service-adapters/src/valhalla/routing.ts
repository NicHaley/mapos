import type {
  Endpoint,
  Maneuver,
  Matrix,
  MatrixCell,
  Route,
  RouteDirectionsRequest,
  RouteMatrixRequest
} from "@mapos/contracts";
import { z } from "zod";
import { fetchJson } from "../http";
import type { AdapterContext } from "../types";

/**
 * Decode a Google-style encoded polyline with 6 digits of precision (Valhalla's
 * default for the `shape` field in /route responses). Returns `[lng, lat]` pairs
 * so it can drop directly into a GeoJSON LineString.
 */
function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const precision = 1e6;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    coords.push([lng / precision, lat / precision]);
  }
  return coords;
}

const ValhallaManeuverSchema = z.object({
  type: z.number().optional(),
  instruction: z.string().optional(),
  // in `units` (km or mi)
  length: z.number().optional(),
  // seconds
  time: z.number().optional(),
  // Index range into THIS leg's decoded shape (leg-relative — rebased to the concatenated
  // route below).
  begin_shape_index: z.number().optional(),
  end_shape_index: z.number().optional()
});

const ValhallaLegSchema = z.object({
  summary: z
    .object({
      length: z.number().optional(),
      time: z.number().optional()
    })
    .optional(),
  shape: z.string().optional(),
  maneuvers: z.array(ValhallaManeuverSchema).optional()
});

export const ValhallaRouteResponseSchema = z.object({
  trip: z
    .object({
      summary: z
        .object({
          length: z.number().optional(),
          time: z.number().optional()
        })
        .optional(),
      legs: z.array(ValhallaLegSchema).optional(),
      units: z.enum(["kilometers", "miles"]).optional()
    })
    .optional()
});
export type ValhallaRouteResponse = z.infer<typeof ValhallaRouteResponseSchema>;

/**
 * Build the Valhalla `/route` request body. Shared by the HTTP adapter and the
 * in-process (local pack) adapter so both speak identical wire JSON — the only
 * difference between them is transport (`fetch` vs the native actor).
 */
export function buildRouteRequestBody(req: RouteDirectionsRequest) {
  return {
    locations: req.locations.map((l) => ({ lat: l.lat, lon: l.lng })),
    costing: req.costing,
    directions_options: { units: "kilometers" as const }
  };
}

/** Map a validated Valhalla `/route` response into the contract `Route`. */
export function parseRouteResponse(data: ValhallaRouteResponse): Route {
  const trip = data.trip;
  if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) {
    throw new Error("Valhalla returned no trip");
  }

  const allCoords: [number, number][] = [];
  const maneuvers: Maneuver[] = [];
  for (const leg of trip.legs) {
    // Global index of this leg's decoded[0]. Legs share a seam point: leg N>0's first shape
    // point equals the previous leg's last, which we don't re-push — so its decoded[k] lands
    // at (currentLength - 1) + k. For the first leg the base is simply 0.
    const legBase = allCoords.length === 0 ? 0 : allCoords.length - 1;
    if (leg.shape) {
      const decoded = decodePolyline6(leg.shape);
      for (let i = 0; i < decoded.length; i++) {
        // Avoid duplicating the seam point between legs
        if (i === 0 && allCoords.length > 0) continue;
        const pt = decoded[i];
        if (pt) allCoords.push(pt);
      }
    }
    for (const m of leg.maneuvers ?? []) {
      maneuvers.push({
        instruction: m.instruction ?? "",
        distanceMeters: Math.round((m.length ?? 0) * 1000),
        durationSeconds: Math.round(m.time ?? 0),
        type: m.type ?? 0,
        ...(m.begin_shape_index !== undefined
          ? { beginShapeIndex: legBase + m.begin_shape_index }
          : {}),
        ...(m.end_shape_index !== undefined ? { endShapeIndex: legBase + m.end_shape_index } : {})
      });
    }
  }

  const distanceMeters = Math.round((trip.summary?.length ?? 0) * 1000);
  const durationSeconds = Math.round(trip.summary?.time ?? 0);

  return {
    distanceMeters,
    durationSeconds,
    geometry: { type: "LineString", coordinates: allCoords },
    maneuvers
  };
}

/** HTTP transport: POST `/route` to a Valhalla server, then parse. */
export async function directions(
  req: RouteDirectionsRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Route> {
  const data = await fetchJson(
    `${ep.url}/route`,
    ValhallaRouteResponseSchema,
    { method: "POST", body: JSON.stringify(buildRouteRequestBody(req)) },
    { signal: ctx.signal }
  );
  return parseRouteResponse(data);
}

const ValhallaMatrixCellSchema = z.object({
  // km
  distance: z.number().nullable().optional(),
  // seconds
  time: z.number().nullable().optional()
});

export const ValhallaMatrixResponseSchema = z.object({
  sources_to_targets: z.array(z.array(ValhallaMatrixCellSchema)).optional()
});
export type ValhallaMatrixResponse = z.infer<typeof ValhallaMatrixResponseSchema>;

/** Build the Valhalla `/sources_to_targets` request body. */
export function buildMatrixRequestBody(req: RouteMatrixRequest) {
  return {
    sources: req.sources.map((l) => ({ lat: l.lat, lon: l.lng })),
    targets: req.targets.map((l) => ({ lat: l.lat, lon: l.lng })),
    costing: req.costing,
    units: "kilometers" as const
  };
}

/** Map a validated `/sources_to_targets` response into the contract `Matrix`. */
export function parseMatrixResponse(data: ValhallaMatrixResponse, req: RouteMatrixRequest): Matrix {
  const rows = data.sources_to_targets ?? [];
  const cells: MatrixCell[][] = rows.map((row) =>
    row.map((cell) => ({
      distanceMeters: cell.distance == null ? null : Math.round(cell.distance * 1000),
      durationSeconds: cell.time == null ? null : Math.round(cell.time)
    }))
  );
  return {
    sources: req.sources,
    targets: req.targets,
    cells
  };
}

/** HTTP transport: POST `/sources_to_targets` to a Valhalla server, then parse. */
export async function matrix(
  req: RouteMatrixRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Matrix> {
  const data = await fetchJson(
    `${ep.url}/sources_to_targets`,
    ValhallaMatrixResponseSchema,
    { method: "POST", body: JSON.stringify(buildMatrixRequestBody(req)) },
    { signal: ctx.signal }
  );
  return parseMatrixResponse(data, req);
}
