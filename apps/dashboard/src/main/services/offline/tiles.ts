import type { Endpoint, TileStyleRequest } from "@mapos/contracts";
import type { TileCapability } from "@mapos/service-adapters";
import { REGION_SCHEME } from "../../region-protocol";

/**
 * Offline tiles: returns a style URL served by the region protocol handler, which
 * generates a Protomaps basemap style spanning *every* downloaded pack over the
 * shared world backdrop. The `_all` host is a sentinel — the handler enumerates the
 * regions directory itself, so no specific region is encoded here. `ep.url` (the
 * regions directory) is unused: the handler already holds that path.
 */
function styleUrl(req: TileStyleRequest, _ep: Endpoint): string {
  const theme = req.isDark ? "dark" : "light";
  return `${REGION_SCHEME}://_all/style.json?theme=${theme}`;
}

export const offlineTiles: TileCapability = { styleUrl };
