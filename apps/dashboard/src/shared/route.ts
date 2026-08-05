import type { RouteCosting } from "@mapos/contracts";

/** One endpoint of a saved route, in the order it is visited. */
export type RouteStop = {
  label: string;
  lat: number;
  lng: number;
  /**
   * `[[Wikilink]]` to the vault place this stop came from, when it came from one.
   *
   * Identity only — the coordinates above stay authoritative. Moving the linked place does
   * not re-shape a saved route, and a link that stops resolving (the file was renamed or
   * deleted; nothing in MapOS rewrites wikilinks) costs the marker and the Obsidian graph
   * edge, never the route itself.
   */
  file?: string;
};

/**
 * The `route` frontmatter key: the minimum needed to reopen a saved route in the
 * directions panel. Distance and duration are deliberately absent — the panel recomputes
 * them, and a stored copy would go stale the moment a region pack updates the road graph.
 * The route's shape lives in `geometry` (also derived, but persisted because the spatial
 * index is built from it alone).
 */
export type RouteFrontmatter = { mode: RouteCosting; stops: RouteStop[] };

const COSTINGS: readonly RouteCosting[] = ["auto", "pedestrian", "bicycle"];

/** Two stops minimum to be a route at all; the cap keeps a pathological hand-edited
 *  file from turning into an enormous routing request. Both are rejections, not clamps —
 *  see parseRouteFrontmatter. */
const MIN_STOPS = 2;
const MAX_STOPS = 25;

/** Long geocoder labels ("1250 Boulevard René-Lévesque Ouest, Ville-Marie, Montréal…")
 *  would blow past the 255-byte filename limit once two are joined. */
const TITLE_LABEL_MAX = 40;

/** Coordinates round-trip through YAML as floats, so compare at ~10cm — the same
 *  precision the draw layer writes at. Any finer and reopening a file looks "dirty". */
const KEY_PRECISION = 6;

function parseStop(value: unknown, index: number): RouteStop | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  // Number() rather than a typeof check: a hand-editor quoting a coordinate is a
  // formatting slip, not a reason to drop the route.
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const file = typeof raw.file === "string" && raw.file.trim() ? raw.file.trim() : undefined;
  return { label: label || `Stop ${index + 1}`, lat, lng, file };
}

/**
 * Read the `route` frontmatter value, tolerating anything a hand-edit can produce.
 *
 * Never throws: this runs inside `parsePlaceFile`'s try/catch, where a throw is swallowed
 * and takes the *whole place* out of the index. A malformed `route` must cost the route,
 * never the file.
 */
export function parseRouteFrontmatter(value: unknown): RouteFrontmatter | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.stops)) return null;
  // Over the cap the route is rejected, not clipped, for the same reason a bad stop rejects it
  // below: keeping the first 25 of 40 would reopen the panel with a shorter trip than the file
  // describes, and saving from there would write that shorter trip back over the original.
  if (raw.stops.length > MAX_STOPS) return null;
  const stops: RouteStop[] = [];
  for (const [i, entry] of raw.stops.entries()) {
    const stop = parseStop(entry, i);
    // One bad stop invalidates the route — silently dropping it would reopen the
    // directions panel with a different trip than the file describes.
    if (!stop) return null;
    stops.push(stop);
  }
  if (stops.length < MIN_STOPS) return null;
  const mode = COSTINGS.find((c) => c === raw.mode) ?? "auto";
  return { mode, stops };
}

/**
 * Canonical identity of a route, for comparing what's on screen against what's on disk.
 * Coordinates and mode only — labels and links are annotations on the same trip, so a
 * route whose geometry hasn't moved is not "unsaved".
 */
export function routeKey(stops: RouteStop[], mode: string): string {
  const points = stops
    .map((s) => `${s.lat.toFixed(KEY_PRECISION)},${s.lng.toFixed(KEY_PRECISION)}`)
    .join("|");
  return `${mode}:${points}`;
}

/** Whether a route on screen differs from the one saved in the file. */
export function routeIsDirty(
  saved: RouteFrontmatter | null | undefined,
  stops: RouteStop[],
  mode: RouteCosting
): boolean {
  if (!saved) return true;
  return routeKey(saved.stops, saved.mode) !== routeKey(stops, mode);
}

/** Default title for a newly saved route — "{origin} to {destination}". */
export function defaultRouteTitle(stops: RouteStop[]): string {
  const first = stops[0]?.label.trim();
  const last = stops[stops.length - 1]?.label.trim();
  if (!first || !last) return "Route";
  const clip = (s: string): string =>
    s.length > TITLE_LABEL_MAX ? s.slice(0, TITLE_LABEL_MAX).trimEnd() : s;
  return `${clip(first)} to ${clip(last)}`;
}
