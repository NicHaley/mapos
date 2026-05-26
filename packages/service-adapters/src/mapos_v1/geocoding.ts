import {
  type Endpoint,
  type GeocodeForwardRequest,
  type GeocodeResult,
  GeocodeResultSchema,
  type GeocodeReverseRequest
} from "@mapos/contracts";
import { z } from "zod";
import type { AdapterContext } from "../types";
import { fetchMapos } from "./client";

const ResultArraySchema = z.array(GeocodeResultSchema);

function tokenFor(ep: Endpoint): string | undefined {
  return ep.auth?.type === "bearer" ? ep.auth.value : undefined;
}

export function forward(
  req: GeocodeForwardRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  return fetchMapos(
    `${ep.url}/v1/geocoding/forward`,
    ResultArraySchema,
    { method: "POST", body: JSON.stringify(req) },
    { signal: ctx.signal, authToken: tokenFor(ep) }
  );
}

export function reverse(
  req: GeocodeReverseRequest,
  ep: Endpoint,
  ctx: AdapterContext = {}
): Promise<GeocodeResult[]> {
  return fetchMapos(
    `${ep.url}/v1/geocoding/reverse`,
    ResultArraySchema,
    { method: "POST", body: JSON.stringify(req) },
    { signal: ctx.signal, authToken: tokenFor(ep) }
  );
}
