import {
  type Endpoint,
  type Matrix,
  MatrixSchema,
  type Route,
  type RouteDirectionsRequest,
  type RouteMatrixRequest,
  RouteSchema
} from "@mapos/contracts";
import type { AdapterContext } from "../types";
import { fetchMapos } from "./client";

function tokenFor(ep: Endpoint): string | undefined {
  return ep.auth?.type === "bearer" ? ep.auth.value : undefined;
}

export function directions(
  req: RouteDirectionsRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Route> {
  return fetchMapos(
    `${ep.url}/v1/routing/directions`,
    RouteSchema,
    { method: "POST", body: JSON.stringify(req) },
    { signal: ctx.signal, authToken: tokenFor(ep) }
  );
}

export function matrix(
  req: RouteMatrixRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Matrix> {
  return fetchMapos(
    `${ep.url}/v1/routing/matrix`,
    MatrixSchema,
    { method: "POST", body: JSON.stringify(req) },
    { signal: ctx.signal, authToken: tokenFor(ep) }
  );
}
