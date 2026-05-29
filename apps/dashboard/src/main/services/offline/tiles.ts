import type { Endpoint, TileStyleRequest } from "@mapos/contracts";
import type { TileCapability } from "@mapos/service-adapters";
import { REGION_SCHEME } from "../../region-protocol";

/**
 * Offline tiles: returns a style URL served by the region protocol handler,
 * which generates a Protomaps basemap style pointing at the local pmtiles.
 * `ep.url` carries the region slug (set by resolve()).
 */
function styleUrl(req: TileStyleRequest, ep: Endpoint): string {
  const theme = req.isDark ? "dark" : "light";
  return `${REGION_SCHEME}://${ep.url}/style.json?theme=${theme}`;
}

export const offlineTiles: TileCapability = { styleUrl };
