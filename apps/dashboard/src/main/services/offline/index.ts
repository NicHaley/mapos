import type { Adapter } from "@mapos/service-adapters";
import { offlineGeocoding } from "./geocoding";
import { offlineTiles } from "./tiles";

/**
 * Local adapter backed by downloaded region packs. Unlike the adapters in
 * `@mapos/service-adapters` (which target Cloudflare Workers too and must stay
 * dependency-light), this one uses `better-sqlite3` and the region protocol and
 * so lives in the Electron main process. Implements geocoding and tiles today;
 * routing will be added here when that offline integration lands.
 */
export const offlineAdapter: Adapter = {
  id: "offline",
  geocoding: offlineGeocoding,
  tiles: offlineTiles
};

export { closeOfflineGeocodeConnections } from "./geocoding";
