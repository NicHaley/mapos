import { maposV1Adapter } from "./mapos_v1";
import { photonAdapter } from "./photon";
import { protomapsAdapter } from "./protomaps";
import { tavilyAdapter } from "./tavily";
import { valhallaAdapter } from "./valhalla";

export { defaultEndpoints } from "./defaults";
export {
  fetchJson,
  MapServiceError,
  MapServiceValidationError
} from "./http";
export type { FetchJsonOptions } from "./http";
export { maposV1Adapter } from "./mapos_v1";
export { MaposApiError } from "./mapos_v1/client";
export { photonAdapter } from "./photon";
export { protomapsAdapter } from "./protomaps";
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
 * Registry of all built-in adapters. `tavily` provides web search server-side
 * only — it needs a key the desktop can't ship, so it's invoked behind the MapOS
 * server's `/v1/web-search` route rather than in community mode. `searxng` is
 * still declared as an `AdapterId` in `@mapos/contracts` but has no implementation.
 */
export const adapters = {
  photon: photonAdapter,
  valhalla: valhallaAdapter,
  protomaps: protomapsAdapter,
  mapos_v1: maposV1Adapter,
  tavily: tavilyAdapter
} as const;

export type AdapterRegistry = typeof adapters;
export type LocalAdapterId = keyof AdapterRegistry;
