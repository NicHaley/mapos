import { maposV1Adapter } from "./mapos_v1";
import { photonAdapter } from "./photon";
import { protomapsAdapter } from "./protomaps";
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
export type {
  Adapter,
  AdapterContext,
  GeocodingCapability,
  IsochroneCapability,
  RoutingCapability,
  TileCapability
} from "./types";
export { valhallaAdapter } from "./valhalla";

/**
 * Registry of all built-in adapters. `tavily` and `searxng` are still declared
 * as `AdapterId`s in `@mapos/contracts` but have no implementation yet — web
 * search is out of scope for v1.
 */
export const adapters = {
  photon: photonAdapter,
  valhalla: valhallaAdapter,
  protomaps: protomapsAdapter,
  mapos_v1: maposV1Adapter
} as const;

export type AdapterRegistry = typeof adapters;
export type LocalAdapterId = keyof AdapterRegistry;
