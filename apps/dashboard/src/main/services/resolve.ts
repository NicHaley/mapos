import type { Endpoint, ServiceId } from "@mapos/contracts";
import { type Adapter, adapters, defaultEndpoints, maposV1Adapter } from "@mapos/service-adapters";
import type { ServicesConfig } from "../mapos-config";
import { ServiceUnavailableError } from "./errors";
import type { ClientCredentials } from "./types";

export type Resolution = { adapter: Adapter; endpoint: Endpoint };

/**
 * The community provider chosen for each service. This map is the *implementation*
 * of community mode — users never see provider names, they just pick "Community".
 * Web search is omitted: no community provider exists (every plausible backend
 * requires a key the desktop can't ship).
 */
const communityProviderForService = {
  geocoding: "photon",
  routing: "valhalla",
  isochrones: "valhalla",
  tiles: "protomaps"
} as const satisfies Partial<Record<ServiceId, keyof typeof defaultEndpoints>>;

/**
 * Services the MapOS server (`mapos_v1` adapter) implements. Web search is
 * server-only — the server holds the Tavily key and exposes it at
 * `POST /v1/web-search`; there is no community provider.
 */
const SERVER_SUPPORTED_SERVICES: readonly ServiceId[] = [
  "geocoding",
  "routing",
  "isochrones",
  "tiles",
  "webSearch"
] as const;

export function resolve(
  serviceId: ServiceId,
  config: ServicesConfig,
  credentials: ClientCredentials
): Resolution {
  if (config.mode === "community") {
    return resolveCommunity(serviceId, credentials);
  }
  if (config.mode === "self_hosted") {
    return resolveServer(serviceId, config.baseUrl, config.authToken);
  }
  // mapos_cloud requires both the auth/billing flow and a deployed api.mapos.md,
  // neither of which exist in v1. Users are routed back to Community or self-hosted.
  throw new ServiceUnavailableError(
    serviceId,
    "MapOS Cloud is not yet available — use Community mode or a self-hosted server"
  );
}

function resolveCommunity(serviceId: ServiceId, credentials: ClientCredentials): Resolution {
  const providerId =
    communityProviderForService[serviceId as keyof typeof communityProviderForService];
  if (!providerId) {
    throw new ServiceUnavailableError(
      serviceId,
      "no community provider — sign in to MapOS Cloud or use a self-hosted server"
    );
  }
  return {
    adapter: adapters[providerId],
    endpoint: communityEndpoint(providerId, credentials)
  };
}

function resolveServer(serviceId: ServiceId, baseUrl: string, authToken?: string): Resolution {
  if (!SERVER_SUPPORTED_SERVICES.includes(serviceId)) {
    throw new ServiceUnavailableError(
      serviceId,
      `service "${serviceId}" is not implemented by the MapOS server`
    );
  }
  const endpoint: Endpoint = {
    url: baseUrl.replace(/\/+$/, ""),
    ...(authToken ? { auth: { type: "bearer", value: authToken } } : {})
  };
  return { adapter: maposV1Adapter, endpoint };
}

function communityEndpoint(
  providerId: keyof typeof defaultEndpoints,
  credentials: ClientCredentials
): Endpoint {
  const base = defaultEndpoints[providerId];
  if (providerId === "protomaps" && credentials.protomapsApiKey) {
    return { ...base, auth: { type: "apikey", value: credentials.protomapsApiKey } };
  }
  return base;
}
