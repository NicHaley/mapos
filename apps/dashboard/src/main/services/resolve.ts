import type { Endpoint, ServiceId } from "@mapos/contracts";
import { type Adapter, maposV1Adapter } from "@mapos/service-adapters";
import type { ServicesConfig } from "../mapos-config";
import { ServiceUnavailableError } from "./errors";
import { offlineAdapter } from "./offline";
import { listInstalledRegions } from "./offline/installed-regions";
import type { ClientCredentials } from "./types";

export type Resolution = { adapter: Adapter; endpoint: Endpoint };

/** Services the MapOS server (`mapos_v1` adapter) implements. */
const SERVER_SUPPORTED_SERVICES: readonly ServiceId[] = [
  "geocoding",
  "routing",
  "isochrones",
  "tiles"
] as const;

export function resolve(
  serviceId: ServiceId,
  config: ServicesConfig,
  credentials: ClientCredentials
): Resolution {
  // Offline overlay wins for capabilities a downloaded region pack provides
  // locally; otherwise we fall through to the base mode. This keeps tiles/routing
  // on the base mode (e.g. the cloud proxy) while geocoding goes local.
  const offline = resolveOfflineOverlay(serviceId, config, credentials);
  if (offline) return offline;

  if (config.mode === "local") {
    // Tiles and geocoding always work offline, even with zero region packs. Tiles:
    // the bundled z0–6 world basemap serves worldwide. Geocoding: the bundled coarse
    // world index (countries + major cities) answers as a fallback. Packs layer
    // detail on top — when one is installed the overlay above already returned this
    // same adapter with that detail (and the world index merges beneath it). So this
    // branch is the no-pack base case for a fresh install.
    if (serviceId === "tiles" || serviceId === "geocoding") {
      return { adapter: offlineAdapter, endpoint: offlineEndpoint(credentials) };
    }
    // Routing/isochrones are fully offline only via a pack: anything the overlay
    // didn't serve has no provider. Surface a "download a pack" message.
    throw new ServiceUnavailableError(serviceId, localUnavailableReason(serviceId));
  }

  // cloud: a custom `baseUrl` routes to that server (the folded-in self-hosted path);
  // its absence means the canonical MapOS Cloud, which needs an auth/billing flow and a
  // deployed api.mapos.md — neither exists in v1.
  if (config.baseUrl) {
    return resolveServer(serviceId, config.baseUrl, config.authToken);
  }
  throw new ServiceUnavailableError(
    serviceId,
    "MapOS Cloud is not yet available — switch to Local mode or set a custom server URL"
  );
}

function localUnavailableReason(serviceId: ServiceId): string {
  return `${serviceId} is not available offline — download a region pack to enable it`;
}

/**
 * Returns a local resolution when *any* downloaded pack provides this capability,
 * else null (fall through to the base mode). There is no single "active region":
 * every installed pack is live. The endpoint carries `regionsDir` and the offline
 * adapter picks the right pack per request by bbox (and, for tiles, builds a style
 * spanning all packs). If no point in a request falls inside a downloaded pack the
 * adapter surfaces an error — for capabilities the base mode can't serve offline
 * (e.g. routing in local mode) that's the only possible outcome anyway.
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
  // installed packs from it and selects per request. `worldGeocode` lets the
  // geocoding adapter merge the bundled coarse world index beneath the pack(s).
  return { adapter: offlineAdapter, endpoint: offlineEndpoint(credentials) };
}

/**
 * Endpoint for the offline adapter: the regions dir plus the bundled world
 * geocode index path. `has.geocoding` (the overlay gate) deliberately keys on
 * real packs only, never this — so the world index is a local fallback and never
 * silently replaces cloud geocoding for a user with no packs.
 */
function offlineEndpoint(credentials: ClientCredentials): Endpoint {
  return {
    url: credentials.regionsDir ?? "",
    ...(credentials.worldGeocodePath ? { worldGeocode: credentials.worldGeocodePath } : {})
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
