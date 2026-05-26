import {
  type GeocodeForwardRequest,
  GeocodeForwardRequestSchema,
  type GeocodeResult,
  type GeocodeReverseRequest,
  GeocodeReverseRequestSchema,
  type Isochrone,
  type IsochroneRequest,
  IsochroneRequestSchema,
  type Matrix,
  type Route,
  type RouteDirectionsRequest,
  RouteDirectionsRequestSchema,
  type RouteMatrixRequest,
  RouteMatrixRequestSchema,
  type ServiceId,
  type TileStyleRequest,
  TileStyleRequestSchema
} from "@mapos/contracts";
import type {
  AdapterContext,
  GeocodingCapability,
  IsochroneCapability,
  RoutingCapability,
  TileCapability
} from "@mapos/service-adapters";
import type { ServicesConfig } from "../mapos-config";
import { ServiceUnavailableError } from "./errors";
import { resolve, type Resolution } from "./resolve";
import type { ClientCredentials } from "./types";

export { ServiceUnavailableError } from "./errors";
export type { ServicesConfig } from "../mapos-config";
export type { ClientCredentials } from "./types";

type CapabilityKey = "geocoding" | "routing" | "isochrones" | "tiles";

type CapabilityType = {
  geocoding: GeocodingCapability;
  routing: RoutingCapability;
  isochrones: IsochroneCapability;
  tiles: TileCapability;
};

function requireCapability<K extends CapabilityKey>(
  resolution: Resolution,
  serviceId: ServiceId,
  capability: K
): { capability: CapabilityType[K]; endpoint: Resolution["endpoint"] } {
  const impl = resolution.adapter[capability] as CapabilityType[K] | undefined;
  if (!impl) {
    throw new ServiceUnavailableError(
      serviceId,
      `adapter "${resolution.adapter.id}" does not implement ${capability}`
    );
  }
  return { capability: impl, endpoint: resolution.endpoint };
}

/**
 * Build a service client bound to a given config + credentials snapshot. The
 * client is *not* reactive: if config changes, the caller is responsible for
 * tearing down the old client and creating a new one. This keeps the dispatcher
 * dependency-free and trivial to reason about.
 */
export function createClient(config: ServicesConfig, credentials: ClientCredentials = {}) {
  function get<K extends CapabilityKey>(
    serviceId: ServiceId,
    capability: K
  ): { capability: CapabilityType[K]; endpoint: Resolution["endpoint"] } {
    return requireCapability(resolve(serviceId, config, credentials), serviceId, capability);
  }

  return {
    geocoding: {
      forward: (req: GeocodeForwardRequest, ctx?: AdapterContext): Promise<GeocodeResult[]> => {
        const { capability, endpoint } = get("geocoding", "geocoding");
        return capability.forward(GeocodeForwardRequestSchema.parse(req), endpoint, ctx);
      },
      reverse: (req: GeocodeReverseRequest, ctx?: AdapterContext): Promise<GeocodeResult[]> => {
        const { capability, endpoint } = get("geocoding", "geocoding");
        return capability.reverse(GeocodeReverseRequestSchema.parse(req), endpoint, ctx);
      }
    },

    routing: {
      directions: (req: RouteDirectionsRequest, ctx?: AdapterContext): Promise<Route> => {
        const { capability, endpoint } = get("routing", "routing");
        return capability.directions(RouteDirectionsRequestSchema.parse(req), endpoint, ctx);
      },
      matrix: (req: RouteMatrixRequest, ctx?: AdapterContext): Promise<Matrix> => {
        const { capability, endpoint } = get("routing", "routing");
        return capability.matrix(RouteMatrixRequestSchema.parse(req), endpoint, ctx);
      }
    },

    isochrones: {
      contours: (req: IsochroneRequest, ctx?: AdapterContext): Promise<Isochrone> => {
        const { capability, endpoint } = get("isochrones", "isochrones");
        return capability.contours(IsochroneRequestSchema.parse(req), endpoint, ctx);
      }
    },

    tiles: {
      /** Synchronous — the renderer needs a URL string immediately for MapLibre. */
      styleUrl: (req: TileStyleRequest): string => {
        const { capability, endpoint } = get("tiles", "tiles");
        return capability.styleUrl(TileStyleRequestSchema.parse(req), endpoint);
      }
    },

    /**
     * Cheap availability check for UI gating (e.g. hiding a web-search button
     * when the active mode can't serve it). Does not perform any network call.
     */
    isAvailable: (serviceId: ServiceId): boolean => {
      try {
        const r = resolve(serviceId, config, credentials);
        if (serviceId === "tiles") return r.adapter.tiles !== undefined;
        if (serviceId === "geocoding") return r.adapter.geocoding !== undefined;
        if (serviceId === "routing") return r.adapter.routing !== undefined;
        if (serviceId === "isochrones") return r.adapter.isochrones !== undefined;
        return false;
      } catch {
        return false;
      }
    }
  };
}

export type MaposServiceClient = ReturnType<typeof createClient>;
