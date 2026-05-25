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
  time: z.number().optional()
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

const ValhallaRouteResponseSchema = z.object({
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

export async function directions(
  req: RouteDirectionsRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Route> {
  const body = {
    locations: req.locations.map((l) => ({ lat: l.lat, lon: l.lng })),
    costing: req.costing,
    directions_options: { units: "kilometers" as const }
  };
  const data = await fetchJson(
    `${ep.url}/route`,
    ValhallaRouteResponseSchema,
    { method: "POST", body: JSON.stringify(body) },
    { signal: ctx.signal }
  );
  const trip = data.trip;
  if (!trip || !Array.isArray(trip.legs) || trip.legs.length === 0) {
    throw new Error("Valhalla returned no trip");
  }

  const allCoords: [number, number][] = [];
  const maneuvers: Maneuver[] = [];
  for (const leg of trip.legs) {
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
        type: m.type ?? 0
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

const ValhallaMatrixCellSchema = z.object({
  // km
  distance: z.number().nullable().optional(),
  // seconds
  time: z.number().nullable().optional()
});

const ValhallaMatrixResponseSchema = z.object({
  sources_to_targets: z.array(z.array(ValhallaMatrixCellSchema)).optional()
});

export async function matrix(
  req: RouteMatrixRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Matrix> {
  const body = {
    sources: req.sources.map((l) => ({ lat: l.lat, lon: l.lng })),
    targets: req.targets.map((l) => ({ lat: l.lat, lon: l.lng })),
    costing: req.costing,
    units: "kilometers"
  };
  const data = await fetchJson(
    `${ep.url}/sources_to_targets`,
    ValhallaMatrixResponseSchema,
    { method: "POST", body: JSON.stringify(body) },
    { signal: ctx.signal }
  );
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
