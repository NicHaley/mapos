import type { GeocodeResult } from "@mapos/contracts";
import { orderDetailProperties } from "./types";

/**
 * Single source of truth for turning a geocoder result into a place's structured
 * details. Used by BOTH the search UI (renderer) and the chat `present_features`
 * tool (main process), so a feature shown either way carries byte-identical
 * properties — the facts never round-trip through the LLM and get reformatted.
 */

/** Keys the model is never allowed to supply itself (it has no real source for them). */
export const AI_REJECTED_DETAIL_KEYS = new Set(["osm_id", "wikidata_id"]);

/**
 * Canonical category token: drop an OSM "class:" prefix, lowercase, trim, and
 * collapse internal whitespace to underscores. So both "amenity:fast_food" (a
 * geocoder tag) and "fast food" (model free text) normalize to "fast_food".
 */
export function normalizeCategoryToken(raw: string): string {
  const colon = raw.lastIndexOf(":");
  const bare = colon >= 0 ? raw.slice(colon + 1) : raw;
  return bare.toLowerCase().trim().replace(/\s+/g, "_");
}

/**
 * Detail properties derived from a geocoder result, in canonical order. The fields
 * are already clean at the contract boundary — `category` is a normalized vocabulary
 * token (no stripping needed), `osmType`/`osmId` are the real source identity, and
 * `wikidataId` is a QID straight from the pack — so this is a faithful copy, not a
 * normalization step.
 */
export function detailPropertiesFromGeocodeResult(r: GeocodeResult): Record<string, string> {
  return orderDetailProperties({
    ...(r.category ? { category: r.category } : {}),
    ...(r.secondaryLabel ? { address: r.secondaryLabel } : {}),
    ...(r.osmType && r.osmId ? { osm_id: `${r.osmType}/${r.osmId}` } : {}),
    ...(r.wikidataId ? { wikidata_id: r.wikidataId } : {})
  });
}

/**
 * Sanitize model-supplied properties for a genuinely ad-hoc place (one with no
 * geocoder result behind it): normalize the category token, drop empty values and
 * any id keys the model can't legitimately source. Returns canonical order.
 */
export function sanitizeAdHocProperties(
  props: Record<string, string> | undefined
): Record<string, string> {
  if (!props) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (AI_REJECTED_DETAIL_KEYS.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    out[key] = key === "category" ? normalizeCategoryToken(value) : value;
  }
  return orderDetailProperties(out);
}
