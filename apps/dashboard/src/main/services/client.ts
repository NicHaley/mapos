import { join } from "node:path";
import { app } from "electron";
import { loadOrInitMaposConfig } from "../mapos-config";
import { type MaposServiceClient, createClient } from "./index";
import { closeOfflineGeocodeConnections } from "./offline";
import type { ClientCredentials } from "./types";

let cached: MaposServiceClient | null = null;

function readCredentials(): ClientCredentials {
  const creds: ClientCredentials = {
    // Region packs live in userData, alongside index.db — large, derived, sync-excluded.
    regionsDir: join(app.getPath("userData"), "regions")
  };
  // Build-time injected by electron-vite. Declared in env.d.ts.
  const key = import.meta.env.MAIN_VITE_PROTOMAPS_KEY as string | undefined;
  if (key && key.length > 0) creds.protomapsApiKey = key;
  return creds;
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
  // Drop cached SQLite handles so a region switch doesn't read a stale file.
  closeOfflineGeocodeConnections();
}
