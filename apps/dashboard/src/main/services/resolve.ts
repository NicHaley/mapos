import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Endpoint, ServiceId } from "@mapos/contracts";
import { type Adapter, adapters, defaultEndpoints, maposV1Adapter } from "@mapos/service-adapters";
import type { ServicesConfig } from "../mapos-config";
import { ServiceUnavailableError } from "./errors";
import { offlineAdapter } from "./offline";
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
 * Returns a local resolution when `offlineRegion` is set and the pack actually
 * provides this capability, else null (fall through to the base mode). Geocoding,
 * tiles, routing, and isochrones are served from the pack when present. A
 * missing/undownloaded artifact returns null rather than throwing, so the base
 * mode (e.g. community Valhalla) transparently serves the request.
 */
function resolveOfflineOverlay(
  serviceId: ServiceId,
  config: ServicesConfig,
  credentials: ClientCredentials
): Resolution | null {
  const region = config.offlineRegion;
  if (!region || !credentials.regionsDir) return null;
  const regionDir = join(credentials.regionsDir, region);

  if (serviceId === "geocoding") {
    const dbPath = join(regionDir, "geocode.sqlite");
    if (!existsSync(dbPath)) return null;
    // endpoint.url carries the sqlite path for the offline geocoding adapter.
    return { adapter: offlineAdapter, endpoint: { url: dbPath } };
  }
  if (serviceId === "tiles") {
    const pmtiles = join(regionDir, `${region}.pmtiles`);
    if (!existsSync(pmtiles)) return null;
    // endpoint.url carries the region slug; the tiles adapter builds the
    // mapos-region:// style URL from it.
    return { adapter: offlineAdapter, endpoint: { url: region } };
  }
  if (serviceId === "routing" || serviceId === "isochrones") {
    const tar = join(regionDir, "valhalla_tiles.tar");
    if (!existsSync(tar)) return null;
    // endpoint.url carries the absolute tar path; the offline routing adapter
    // builds an in-process Valhalla Actor from it (symmetric with geocoding's
    // sqlite path).
    return { adapter: offlineAdapter, endpoint: { url: tar } };
  }
  return null;
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
