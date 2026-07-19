/**
 * The tile service is a URL service rather than a request/response one: callers
 * resolve a MapLibre style URL from the dispatcher and hand it directly to the
 * renderer. The contract is therefore just the inputs the dispatcher needs.
 */

import { z } from "zod";

export const TileStyleRequestSchema = z.object({
  isDark: z.boolean(),
  // Monochrome basemap ("Map color: Monochrome" = white/black flavor) vs the
  // default tinted light/dark flavor. Optional so older callers still parse.
  monochrome: z.boolean().default(false)
});
export type TileStyleRequest = z.infer<typeof TileStyleRequestSchema>;

/** Map data credits — the single source for every attribution surface (the style
 * JSON `attribution` field and the always-visible credit line on the map). */
export const MAP_ATTRIBUTIONS: readonly { name: string; url: string; suffix?: string }[] = [
  { name: "OpenStreetMap", url: "https://openstreetmap.org/copyright", suffix: " contributors" },
  { name: "Protomaps", url: "https://protomaps.com" }
];

export const MAP_ATTRIBUTION_HTML = MAP_ATTRIBUTIONS.map(
  (a) => `© <a href="${a.url}">${a.name}</a>${a.suffix ?? ""}`
).join(" · ");
