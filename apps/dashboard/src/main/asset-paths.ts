import { join } from "node:path";
import { app } from "electron";

/**
 * Filesystem locations of assets bundled with the app (not user data). Centralised
 * so the main process and the services layer resolve the same paths — the dev vs
 * packaged split is easy to get subtly wrong if duplicated.
 */

/** Root of the bundled basemap assets: world basemap, glyphs/sprites, world geocode index. */
export function basemapAssetsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "basemap-assets")
    : join(__dirname, "../../resources/basemap-assets");
}

/** Bundled low-zoom (z0–6) world basemap, the backdrop outside downloaded packs. */
export function worldPmtilesPath(): string {
  return join(basemapAssetsDir(), "basemap", "world.pmtiles");
}

/** Bundled coarse world geocode index (countries + major cities) — offline search fallback. */
export function worldGeocodePath(): string {
  return join(basemapAssetsDir(), "basemap", "world.sqlite");
}

/**
 * The stdio↔HTTP MCP bridge an external client spawns to reach the running app. Shipped via
 * `extraResources` (never bundled), so it sits beside the basemap assets in the packaged app
 * rather than inside the asar.
 */
export function mcpBridgePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "mcp-stdio.mjs")
    : join(__dirname, "../../resources/mcp-stdio.mjs");
}
