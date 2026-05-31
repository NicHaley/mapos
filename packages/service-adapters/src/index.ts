import { maposV1Adapter } from "./mapos_v1";
import { photonAdapter } from "./photon";
import { tavilyAdapter } from "./tavily";
import { valhallaAdapter } from "./valhalla";

export {
  fetchJson,
  MapServiceError,
  MapServiceValidationError
} from "./http";
export type { FetchJsonOptions } from "./http";
export { maposV1Adapter } from "./mapos_v1";
export { MaposApiError } from "./mapos_v1/client";
export { photonAdapter } from "./photon";
export { tavilyAdapter } from "./tavily";
export type {
  Adapter,
  AdapterContext,
  GeocodingCapability,
  IsochroneCapability,
  RoutingCapability,
  TileCapability,
  WebSearchCapability
} from "./types";
export { valhallaAdapter } from "./valhalla";
export {
  buildRouteRequestBody,
  parseRouteResponse,
  ValhallaRouteResponseSchema,
  buildMatrixRequestBody,
  parseMatrixResponse,
  ValhallaMatrixResponseSchema,
  buildIsochroneRequestBody,
  parseIsochroneResponse,
  ValhallaIsochroneResponseSchema
} from "./valhalla";
export type {
  ValhallaRouteResponse,
  ValhallaMatrixResponse,
  ValhallaIsochroneResponse
} from "./valhalla";

/**
 * Registry of all built-in adapters. These back the MapOS server (`apps/server`):
 * `photon` geocodes, `valhalla` routes, and `tavily` serves web search behind the
 * server's `/v1/web-search` route. The desktop client talks to the server through
 * `mapos_v1`; it never invokes the upstream adapters directly. `searxng` is still
 * declared as an `AdapterId` in `@mapos/contracts` but has no implementation.
 */
export const adapters = {
  photon: photonAdapter,
  valhalla: valhallaAdapter,
  mapos_v1: maposV1Adapter,
  tavily: tavilyAdapter
} as const;

export type AdapterRegistry = typeof adapters;
export type LocalAdapterId = keyof AdapterRegistry;
