import { join } from "node:path";
import { app } from "electron";
import { loadOrInitMaposConfig } from "../mapos-config";
import { closeRegionArchives } from "../region-protocol";
import { type MaposServiceClient, createClient } from "./index";
import { closeOfflineGeocodeConnections, closeOfflineRoutingActors } from "./offline";
import type { ClientCredentials } from "./types";

let cached: MaposServiceClient | null = null;

function readCredentials(): ClientCredentials {
  return {
    // Region packs live in userData, alongside index.db — large, derived, sync-excluded.
    regionsDir: join(app.getPath("userData"), "regions")
  };
}

/**
 * Lazy singleton. The client is a snapshot of the config + credentials at the
 * time of first access; call {@link invalidateServiceClient} after persisting
 * a config change so the next request rebuilds against the new state.
 */
export function getServiceClient(): MaposServiceClient {
  if (!cached) {
    const cfg = loadOrInitMaposConfig(app.getPath("userData"));
    cached = createClient(cfg.services, readCredentials());
  }
  return cached;
}

export function invalidateServiceClient(): void {
  cached = null;
  // Drop cached SQLite handles + Valhalla Actors + pmtiles fds so a region switch
  // doesn't read a stale file, keep the old region's tiles memory-mapped, or serve
  // a deleted inode through a cached archive.
  closeOfflineGeocodeConnections();
  closeOfflineRoutingActors();
  closeRegionArchives();
}
