import type { Adapter } from "@mapos/service-adapters";
import { offlineGeocoding } from "./geocoding";
import { offlineIsochrones, offlineRouting } from "./routing";
import { offlineTiles } from "./tiles";

/**
 * Local adapter backed by downloaded region packs. Unlike the adapters in
 * `@mapos/service-adapters` (which target Cloudflare Workers too and must stay
 * dependency-light), this one uses `better-sqlite3`, the region protocol, and the
 * `@valhallajs/valhallajs` native addon, so it lives in the Electron main process.
 * Implements geocoding, tiles, routing, and isochrones from downloaded packs.
 *
 * Geocoding is the exception to "in the main process": `geocoding.ts` is only a
 * client, and the SQLite work happens in a worker thread (see `geocode-worker.ts`).
 */
export const offlineAdapter: Adapter = {
  id: "offline",
  geocoding: offlineGeocoding,
  tiles: offlineTiles,
  routing: offlineRouting,
  isochrones: offlineIsochrones
};

export { closeOfflineGeocodeConnections } from "./geocoding";
export { closeOfflineRoutingActors } from "./routing";
