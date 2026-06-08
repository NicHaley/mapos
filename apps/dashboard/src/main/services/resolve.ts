import type { Endpoint, ServiceId } from "@mapos/contracts";
import { type Adapter, maposV1Adapter } from "@mapos/service-adapters";
import type { ServicesConfig } from "../mapos-config";
import { ServiceUnavailableError } from "./errors";
import { offlineAdapter } from "./offline";
import { listInstalledRegions } from "./offline/installed-regions";
import type { ClientCredentials } from "./types";

export type Resolution = { adapter: Adapter; endpoint: Endpoint };

/**
 * Services the MapOS server (`mapos_v1` adapter) implements. Web search is
 * server-only — the server holds the Tavily key and exposes it at
 * `POST /v1/web-search`.
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
  // on the base mode (e.g. the cloud proxy) while geocoding goes local.
  const offline = resolveOfflineOverlay(serviceId, config, credentials);
  if (offline) return offline;

  if (config.mode === "local") {
    // Tiles always work offline, even with zero region packs: the world basemap
    // (z0–6) ships bundled with the app and is served over the region protocol
    // worldwide. Packs only layer z7+ detail on top — when one is installed the
    // offline overlay above already returns this same adapter with that detail. So
    // the only thing this branch adds is the no-pack base case (a fresh install).
    if (serviceId === "tiles") {
      return { adapter: offlineAdapter, endpoint: { url: credentials.regionsDir ?? "" } };
    }
    // Everything else is fully offline only via a pack: anything the overlay didn't
    // serve has no provider. Surface a capability-appropriate "download a pack" message.
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
  if (serviceId === "webSearch") {
    return "web search is not available offline — connect to MapOS Cloud";
  }
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
  // installed packs from it and selects per request.
  return { adapter: offlineAdapter, endpoint: { url: regionsDir } };
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
