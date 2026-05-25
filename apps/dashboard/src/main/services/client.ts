import { app } from "electron";
import { loadOrInitMaposConfig } from "../mapos-config";
import { type MaposServiceClient, createClient } from "./index";

let cached: MaposServiceClient | null = null;

function readCredentials(): { protomapsApiKey?: string } {
  // Build-time injected by electron-vite. Declared in env.d.ts.
  const key = import.meta.env.MAIN_VITE_PROTOMAPS_KEY as string | undefined;
  return key && key.length > 0 ? { protomapsApiKey: key } : {};
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
}
