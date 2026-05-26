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
export type {
  Adapter,
  AdapterContext,
  GeocodingCapability,
  IsochroneCapability,
  RoutingCapability,
  TileCapability
} from "./types";

/**
 * Registry of locally-runnable adapters. `mapos_v1`, `tavily`, `searxng` are
 * declared as `AdapterId`s in `@mapos/contracts` but live elsewhere — server-side
 * adapters belong in a future server package.
 */
export const adapters = {
  photon: photonAdapter,
  valhalla: valhallaAdapter,
  protomaps: protomapsAdapter
} as const;

export type AdapterRegistry = typeof adapters;
export type LocalAdapterId = keyof AdapterRegistry;
