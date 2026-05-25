import type { Endpoint, ServiceId } from "@mapos/contracts";
import { type Adapter, adapters, defaultEndpoints } from "@mapos/service-adapters";
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

export function resolve(
  serviceId: ServiceId,
  config: ServicesConfig,
  credentials: ClientCredentials
): Resolution {
  if (config.mode === "community") {
    return resolveCommunity(serviceId, credentials);
  }
  // mapos_cloud and self_hosted both dispatch via the (not-yet-built) mapos_v1
  // adapter against a single base URL. Until that adapter exists, every service
  // call in these modes is unavailable.
  throw new ServiceUnavailableError(
    serviceId,
    `${config.mode} mode requires the MapOS server adapter, which is not yet implemented`
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
