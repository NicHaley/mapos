import type { Endpoint, ServiceId } from "@mapos/contracts";
import { type Adapter, adapters, defaultEndpoints, maposV1Adapter } from "@mapos/service-adapters";
import type { ServicesConfig } from "../mapos-config";
import { ServiceUnavailableError } from "./errors";
import { offlineAdapter } from "./offline";
import { listInstalledRegions } from "./offline/installed-regions";
import type { ClientCredentials } from "./types";

export type Resolution = { adapter: Adapter; endpoint: Endpoint };

/**
 * The community provider chosen for each service. This map is the *implementation*
 * of community mode — users never see provider names, they just pick "Community".
 *
 * Routing and isochrones are deliberately omitted: they are served only from a
 * downloaded region's local Valhalla tiles (the offline overlay), never from the
 * public community Valhalla instance. Without offline tiles they are unavailable
 * in community mode rather than hammering a shared free service. (Self-hosted mode
 * still routes them through the user's own MapOS server.)
 *
 * Web search is omitted too: no community provider exists (every plausible backend
 * requires a key the desktop can't ship).
 */
const communityProviderForService = {
  geocoding: "photon",
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
  // Offline overlay wins for capabilities a downloaded region pack provides
  // locally; otherwise we fall through to the base mode. This keeps tiles/routing
  // on the base mode (e.g. self_hosted proxy) while geocoding goes local.
  const offline = resolveOfflineOverlay(serviceId, config, credentials);
  if (offline) return offline;

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

/**
 * Returns a local resolution when *any* downloaded pack provides this capability,
 * else null (fall through to the base mode). There is no single "active region":
 * every installed pack is live. The endpoint carries `regionsDir` and the offline
 * adapter picks the right pack per request by bbox (and, for tiles, builds a style
 * spanning all packs). If no point in a request falls inside a downloaded pack the
 * adapter surfaces an error — for capabilities the base mode can't serve offline
 * (community routing) that's the only possible outcome anyway.
 */
function resolveOfflineOverlay(
  serviceId: ServiceId,
  _config: ServicesConfig,
  credentials: ClientCredentials
): Resolution | null {
  const regionsDir = credentials.regionsDir;
  if (!regionsDir) return null;
  const installed = listInstalledRegions(regionsDir);
  if (installed.length === 0) return null;

  const has = {
    geocoding: installed.some((r) => r.geocode),
    tiles: installed.some((r) => r.pmtiles),
    routing: installed.some((r) => r.valhalla),
    isochrones: installed.some((r) => r.valhalla)
  };
  const provided =
    serviceId === "geocoding"
      ? has.geocoding
      : serviceId === "tiles"
        ? has.tiles
        : serviceId === "routing" || serviceId === "isochrones"
          ? has.routing
          : false;
  if (!provided) return null;

  // endpoint.url carries the regions directory; each offline adapter enumerates
  // installed packs from it and selects per request.
  return { adapter: offlineAdapter, endpoint: { url: regionsDir } };
}

function resolveCommunity(serviceId: ServiceId, credentials: ClientCredentials): Resolution {
  const providerId =
    communityProviderForService[serviceId as keyof typeof communityProviderForService];
  if (!providerId) {
    // Routing/isochrones are offline-only: the offline overlay would have served
    // them if a region pack with Valhalla tiles were downloaded.
    const reason =
      serviceId === "routing" || serviceId === "isochrones"
        ? "routing is offline-only — download a region pack to enable it"
        : "no community provider — sign in to MapOS Cloud or use a self-hosted server";
    throw new ServiceUnavailableError(serviceId, reason);
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
