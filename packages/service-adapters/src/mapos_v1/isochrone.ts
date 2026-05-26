import {
  type Endpoint,
  type Isochrone,
  type IsochroneRequest,
  IsochroneSchema
} from "@mapos/contracts";
import type { AdapterContext } from "../types";
import { fetchMapos } from "./client";

function tokenFor(ep: Endpoint): string | undefined {
  return ep.auth?.type === "bearer" ? ep.auth.value : undefined;
}

export function contours(
  req: IsochroneRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<Isochrone> {
  return fetchMapos(
    `${ep.url}/v1/isochrones`,
    IsochroneSchema,
    { method: "POST", body: JSON.stringify(req) },
    { signal: ctx.signal, authToken: tokenFor(ep) }
  );
}
