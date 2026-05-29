import type { Adapter } from "@mapos/service-adapters";
import { offlineGeocoding } from "./geocoding";

/**
 * Local adapter backed by downloaded region packs. Unlike the adapters in
 * `@mapos/service-adapters` (which target Cloudflare Workers too and must stay
 * dependency-light), this one uses `better-sqlite3` and so lives in the Electron
 * main process. Today it implements only geocoding; tiles and routing capabilities
 * will be added here as those offline integrations land.
 */
export const offlineAdapter: Adapter = {
  id: "offline",
  geocoding: offlineGeocoding
};

export { closeOfflineGeocodeConnections } from "./geocoding";
