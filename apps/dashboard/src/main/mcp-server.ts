import {
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { GeocodeResult } from "@mapos/contracts";
import { MapServiceError } from "@mapos/service-adapters";
import { bbox as turfBbox } from "@turf/bbox";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { ipcMain } from "electron";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import matter from "gray-matter";
import { type TSchema, Type } from "typebox";
import { elevationStats, hasElevationData } from "../shared/elevation";
import {
  detailPropertiesFromGeocodeResult,
  sanitizeAdHocProperties
} from "../shared/geocode-detail";
import { placeNameFromPath, scoreNameMatch } from "../shared/name-match";
import type { RouteFrontmatter, RouteStop } from "../shared/route";
import {
  type MapOverlayLayer,
  type NavStatePayload,
  type NavTabInfo,
  type PlaceRecord,
  orderDetailProperties
} from "../shared/types";
import { wikilinkForFile } from "../shared/wikilinks";
import { computeBbox } from "./bbox";
import {
  queryNear,
  querySpatialIndex,
  queryWithinPolygon,
  rebuildIndexFromPlaces,
  removeFeaturePropertiesForFile,
  removeFeatures,
  runReadonlyQuery,
  syncFeatureForFile
} from "./db";
import { stringifyPlaceFile } from "./frontmatter";
import { type GeoOperation, runGeoCompute } from "./geo-compute";
import { getMainWindow, sendToRenderer } from "./main-window";
import {
  cancelDownload as cancelRegionDownload,
  deleteRegion,
  downloadRegion,
  fetchManifest,
  getActiveDownloads,
  listLocal as listLocalRegions
} from "./region-packs";
import { getServiceClient } from "./services/client";
import { type ToolAnnotations, type ToolDefinition, defineTool } from "./tool-defs";
import { isProtectedVaultPath, resolveInVault } from "./vault-path";
import { importAttachmentToVault, parsePlaceFile, uniquePathInDir } from "./watcher";
import { downloadWikidataImage } from "./wiki-image";
import { geometryToWkt } from "./wkt";

/**
 * A large geometry stashed server-side so its coordinates never cross the LLM boundary.
 * The agent gets back an opaque id (`route_N`, `iso_N`, `geom_N`) and passes that id to
 * render/query/save/geo_compute; the tool layer resolves it here.
 */
/** One endpoint stashed with a route so save_features_to_vault can write `route` frontmatter. */
export type StashedRouteStop = {
  label: string;
  lat: number;
  lng: number;
  /** Absolute vault path when the stop came from a saved place. */
  vaultPath?: string;
  /** Geocode result id when the stop came from geocode_search — resolved to a wikilink at save time. */
  resultId?: string;
};

export type StashedGeometry = {
  kind: "route" | "isochrone" | "geometry";
  /** GeoJSON geometry (Point | LineString | Polygon | MultiPolygon | …). */
  geometry: Geometry;
  /** route only: summary facts, so saving a route derives them from the source. */
  distanceMeters?: number;
  durationSeconds?: number;
  mode?: string;
  /** route only: ordered stops for `route` frontmatter (reopens in the directions panel). */
  stops?: StashedRouteStop[];
  /** isochrone only: the contour's minute value. */
  minutes?: number;
};

export type VaultOperation = {
  path: string;
  previousContent: string | null; // null = file was created this turn (undo = delete it)
};

function errorPayload(err: unknown): string {
  if (err instanceof MapServiceError) {
    return JSON.stringify({
      error: err.message,
      status: err.status,
      url: err.url,
      body: err.bodySnippet
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ error: message });
}

const TEXT_RESULT = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {}
});

/** Pull a single GeoJSON Geometry out of a Turf result (geometry, Feature, or FeatureCollection). */
function extractGeometry(result: unknown): Geometry | null {
  if (!result || typeof result !== "object") return null;
  const r = result as {
    type?: string;
    geometry?: unknown;
    features?: Array<{ geometry?: unknown }>;
    coordinates?: unknown;
    geometries?: unknown;
  };
  if (r.type === "Feature") return (r.geometry as Geometry | null) ?? null;
  if (r.type === "FeatureCollection") {
    const geoms = (r.features ?? []).map((f) => f.geometry).filter(Boolean) as Geometry[];
    if (geoms.length === 0) return null;
    if (geoms.length === 1) return geoms[0];
    return { type: "GeometryCollection", geometries: geoms };
  }
  if (r.coordinates != null || r.geometries != null) return result as Geometry;
  return null;
}

/** Count coordinate positions in a geometry — a cheap size summary for the model. */
function countPositions(geom: Geometry): number {
  if (geom.type === "GeometryCollection") {
    return geom.geometries.reduce((n, g) => n + countPositions(g), 0);
  }
  let count = 0;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number") count++;
    else for (const x of c) walk(x);
  };
  walk((geom as { coordinates?: unknown }).coordinates);
  return count;
}

/**
 * Recursively collect vault-relative file paths under `dir`, skipping dotfiles and
 * dot-directories (`.mapos`, `.git`, …). Paths use forward slashes so they read the
 * same on every OS. `stopAt` bounds the walk so a huge vault can't blow up a tool call.
 */
function collectVaultFiles(dir: string, vaultRoot: string, out: string[], stopAt: number): void {
  if (out.length >= stopAt) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip rather than fail the whole walk
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectVaultFiles(abs, vaultRoot, out, stopAt);
    } else if (entry.isFile()) {
      out.push(relative(vaultRoot, abs).split(sep).join("/"));
    }
    if (out.length >= stopAt) return;
  }
}

// Some models — smaller local ones especially — emit an array-valued tool argument
// as a JSON-encoded string (e.g. `features: "[{...}]"`) rather than a real array. The
// SDK's TypeBox validation runs before the handler and doesn't parse it back, so the
// call fails with a confusing "features.0: must be object". Tools that take such an
// array declare the param with `jsonArrayParam` (accepts either shape) and normalize
// the value with `coerceJsonArray` at the top of their handler.
function jsonArrayParam<T extends TSchema>(
  item: T,
  options: { minItems?: number; description: string }
) {
  return Type.Union([Type.Array(item, options), Type.String()], {
    description: `${options.description} Pass a JSON array of objects; a JSON string of that same array is also accepted.`
  });
}

function coerceJsonArray<T>(value: readonly T[] | string): T[] {
  if (typeof value !== "string") return [...value];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
  } catch {
    return [];
  }
}

// Read-only built-ins plus `bash` (kept for legitimate shell needs like `exiftool`
// during photo import). `write` and `edit` are deliberately omitted: any vault
// mutation must go through `write_vault_file`/`delete_vault_file`/`rename_vault_file`
// so undo tracking and spatial-index updates stay in sync. Raw bash redirects to
// vault paths are forbidden by the system prompt.
export const BUILTIN_TOOL_NAMES = ["read", "bash", "grep", "find", "ls"] as const;

type ViewportState = {
  north: number;
  south: number;
  east: number;
  west: number;
  centerLat: number;
  centerLng: number;
  zoom: number;
};

let lastViewport: ViewportState | null = null;
ipcMain.on("map:viewport-update", (_event, data: ViewportState) => {
  lastViewport = data;
});

// The renderer pushes its current tab/selection state up whenever it changes, mirroring
// the viewport cache above. get_active_file / get_open_tabs read this snapshot.
let lastNavState: NavStatePayload | null = null;
ipcMain.on("nav:state-update", (_event, data: NavStatePayload) => {
  lastNavState = data;
});

// On-demand geolocation. The GPS fix comes from `navigator.geolocation`, which only
// exists in the renderer, so get_current_location asks the renderer (geo:locate-request)
// and awaits the correlated reply below. Registered once, module-scope, like the caches.
type LocateReply =
  | { id: string; ok: true; lat: number; lng: number; accuracy: number }
  | { id: string; ok: false; error: string };
const pendingLocates = new Map<string, (reply: LocateReply) => void>();
let locateSeq = 0;
ipcMain.on("geo:locate-reply", (_event, reply: LocateReply) => {
  const resolve = pendingLocates.get(reply.id);
  if (resolve) {
    pendingLocates.delete(reply.id);
    resolve(reply);
  }
});

export function buildMaposSystemPrompt(vaultRoot: string): string {
  return `You are the AI agent powering MapOS, a map-first application where the map is the primary interface for a user's personal files, saved places, and spatial data. Help users organize, explore, and reason about their world through their files.

MapOS is a local-first Electron application. Everything runs on the user's machine. Files are the source of truth.

## Vault location (authoritative — use exactly this path)
The MapOS vault root on this machine is: ${vaultRoot}
Read, browse, and search it with the built-in tools: \`read_vault_file\`, \`list_vault_files\` (optionally by subfolder/extension), and \`search_vault_files\` (by filename or contents). Prefer these over generic shell/filesystem tools; if you do use \`find\`/\`grep\`/\`read\`/\`bash\`, confine them to the vault root (e.g. ${vaultRoot}${sep}**${sep}*.md) — never guess home-directory layouts.

## Place files and frontmatter

Place files use Markdown with YAML frontmatter. Required frontmatter: \`geometry\` (WKT string). \`geometry\`, \`color\`, \`icon\`, and \`cover\` have special meaning to the map renderer — do not reuse those key names for other purposes. \`icon\` is a **single** emoji (e.g. \`icon: 🍜\`) shown in place of the file-type glyph and drawn as the map pin for a point; anything else — a word, two emoji — is ignored and the place keeps its plain marker, so don't use it as a category field. \`color\` is a 6-digit hex string in quotes (e.g. \`color: "#ef4444"\`), applied to the place's marker, line, or fill. Prefer one of the seven colours the app's own picker offers, so a file set by you looks like one set by hand: \`#3b82f6\` blue, \`#a855f7\` purple, \`#ec4899\` pink, \`#ef4444\` red, \`#f97316\` orange, \`#eab308\` yellow, \`#22c55e\` green. Omit \`color\` (or delete the key) to fall back to the user's accent colour — that is the default and is usually the right answer for a place with nothing to distinguish. \`cover\` is a vault-relative path to an image file (e.g. \`cover: attachments/tower.jpg\`) shown as the place's hero photo; the body can also embed vault images with standard Markdown (\`![](attachments/tower.jpg)\`).

In a file's body, \`[[Title]]\` is a wikilink to another vault file. \`Title\` must exactly match the target's filename without \`.md\` (case-sensitive; the folder doesn't matter): a file saved as \`tokyo/kinka-izakaya.md\` is linked as \`[[kinka-izakaya]]\`. If two files share a filename, qualify the link with the vault-relative path — \`[[tokyo/kinka-izakaya]]\` — which always takes precedence over a bare filename match. When the user opens a file, the places it wikilinks to are rendered on the map alongside it — so when writing notes that reference saved places (itineraries, trip plans, comparisons), link them with \`[[...]]\` rather than plain text. Wikilinks inside code fences or inline code are ignored.

Write frontmatter values using the correct YAML type so they round-trip properly:

- **number** — bare numeric literal: \`rating: 4\`
- **boolean** — bare literal: \`visited: true\`
- **date** — unquoted ISO string: \`date: 2026-01-15\` or \`date: 2026-01-15T14:00\`
- **array** (tag-style fields like \`tags\`, \`cuisine\`) — YAML array: \`tags: [ramen, tokyo]\`
- **text** — anything else

\`query_spatial_index\` can filter by any array or text property via \`filters.properties\`.

Always ground responses in the user's actual files. Be concise and spatial — when discussing places, think about the map. When creating files, use human-readable kebab-case filenames.

Have a neutral tone. Don't be too friendly or too formal.

## What the user is looking at

You can see and drive the app's open files and ephemeral feature lists:
- \`get_active_file\` — what the user is viewing in the active tab: a vault place/folder (\`kind: "place"\` / \`"folder"\`, with \`path\`) OR an ephemeral feature list (\`kind: "feature_list"\`, with \`layerId\` and \`features\`). Call it to ground "this place", "this list", "remove the third one", "add a note to…".
- \`get_open_tabs\` — every open tab plus which is active. Feature-list tabs include \`layerId\` and \`features\` so you can modify a list the user already has open.
- \`open_file\` — open a vault file in a tab so the user actually sees it. After you create or find something the user will want to look at (e.g. a note from \`write_vault_file\` or a place from \`save_features_to_vault\`), open it rather than only describing it. Don't open files the user didn't ask to see.

Where the user is looking is not where they are. For the map viewport (the visible area/center) use \`get_viewport\`; for the user's real physical position use \`get_current_location\` (device GPS). Ground "near me", "how far am I", or "route me home" in \`get_current_location\`, not the viewport — the map may be panned somewhere else entirely. For "where am I" or "take me to my location", call it with \`reveal_on_map: true\` — that single call shows the location on the map (marker + fly), so you don't need a separate \`pan_to\`; leave it false when you only need the coordinates for a calculation. It triggers a fresh fix and may prompt for OS permission the first time; if it returns null, fall back to asking the user or using the viewport, and say which you used.

## Map services (search, routing, reachability)

For spatial queries beyond the user's own files, use these tools (powered by downloaded region packs — see Offline region packs below):

- \`geocode_search\` — forward geocode a query ("kinka izakaya toronto", "shinjuku station") to one or more points.
- \`reverse_geocode\` — given a lat/lng, return the nearest named feature(s).
- \`get_directions\` — road/walk/bike route between two or more locations. Returns summary distance/duration, turn-by-turn maneuvers, and a \`route_id\` handle. Walking and cycling routes also carry total climb/descent, so "which of these loops is flattest" is answerable.
- \`get_isochrone\` — reachable-area polygon(s) from a location for one or more time contours (minutes); each contour returns an \`isochrone_id\` handle.
- \`get_matrix\` — pairwise travel distance/time between sources and targets. Keep N small (≤ 10 each side; cost grows with the product).
- \`compute_bbox\` — bounding box for a set of points; useful for framing a viewport.

Routes, isochrones, and geo_compute outputs cross the boundary only as opaque handles (\`route_id\` / \`isochrone_id\` / \`geometry_id\`). Pass them straight to \`present_features\`, \`save_features_to_vault\`, \`query_within_polygon\`, or \`geo_compute\` — never retrieve, decode, downsample, or re-emit their coordinates; the geometry is huge and must not re-cross the LLM boundary.

To search the user's own indexed places spatially:

- \`query_spatial_index\` — optional \`bounds\` rectangle (omit to scan the whole vault; it can't take a non-rectangular area).
- \`find_near\` — places nearest a point, nearest-first with \`distance_m\`; pass \`radius_m\` to cap to a circle ("cafes within 500 m"), combine with \`filters\` (tags/category/folder) for "nearest ramen".
- \`query_within_polygon\` — the user's places inside a polygon; pass the region by handle as \`region_id\` (an isochrone_id or geo_compute geometry_id) when you have one, else \`coordinates\` for a hand-built polygon.

find_near and query_within_polygon return the same records as \`query_spatial_index\` — file paths to feed \`present_features\`. To find a place BY NAME ("Home", "Adrian's"), pass \`filters.name\` to any of them: a place's name is its **file basename**, not a \`name\` property, and the match is fuzzy (case, accents, apostrophes, small typos), ranked best-first — don't scan for a \`name\` property or shell out to \`find\`. To find things INSIDE an isochrone: the user's own places → \`query_within_polygon\` (region_id); external POIs (cafes, gas stations) → \`geocode_search\` with \`within_id\`, not a plain \`bbox\` (which only biases ranking and leaks in points outside the shape).

For analytics \`query_spatial_index\` can't express (counts, \`GROUP BY\`, sorting, joins), use \`spatial_sql\` — one read-only SELECT against the index. Tables: \`features(file_path, geometry_type, geometry, color, icon, indexed_at)\`; \`feature_properties(feature_id, key, value, type)\` where \`feature_id\` = \`features.file_path\` and every value is TEXT (\`CAST(value AS REAL)\` for numbers); \`features_rtree(id, min_lat, max_lat, min_lng, max_lng)\` where \`id\` = \`features.rowid\`. \`geometry\` is a GeoJSON string and there are no ST_* functions — don't select it unless you need raw coordinates. List explicit columns, never \`SELECT *\`. To show places on the map, use \`query_spatial_index\`, not this.

To COMPUTE geometry, use \`geo_compute\` — one offline op: \`buffer\` (radius_m), \`area\`, \`length\`, \`centroid\`, \`bbox\`, \`convex_hull\`, \`simplify\`, \`union\`, \`intersect\`, \`clusters_dbscan\` (max_distance_m). Input by handle (\`geometry_id\`/\`geometry_b_id\`), \`feature_paths\` from the index, or inline GeoJSON; geometry-producing ops return a new \`geometry_id\` (measurements return values inline). E.g. "what's within a 10-min walk of both spots" → two \`get_isochrone\` → \`geo_compute\` intersect on the two isochrone_ids → \`query_within_polygon\` with the result.

Display whatever you get back with \`present_features\` (see Presenting places and features below).

## Offline region packs

The map services above are powered by downloaded **region packs** (per-area bundles of geocoding, routing, and map-tile data). Manage them when the user asks what maps they have offline, or to add/remove offline coverage for an area:

- \`list_region_packs\` — what's installed, what's downloading (with percent), and — with a \`query\` — matching packs available to download and their size. The catalog is large, so always pass a \`query\` to browse it.
- \`download_region_pack\` — downloads can be LARGE (tens to hundreds of MB). Always look up the size with \`list_region_packs\` first, tell the user the size, and get their OK before downloading. You must pass \`acknowledge_size_mb\` (the size you told them) and it must match the real size, or the call is rejected. The download runs in the background — progress shows in the app's Offline tab; call \`list_region_packs\` again to see when it's installed.
- \`cancel_region_download\` / \`delete_region_pack\` — stop an in-flight download, or remove an installed pack to reclaim space (re-downloadable).

**Coverage is not automatic** — a map-services query only works for areas the user has actually downloaded. Don't assume a place is covered. Before substantial spatial work for a specific area (planning a trip, building a collection of places, routing across a city), verify coverage first with \`list_region_packs\` for that region; for a one-off lookup you can instead react when a result comes back empty or clearly wrong. Either way, when the region's pack is missing, tell the user its size and offer \`download_region_pack\` rather than repeating a failing lookup or presenting bad results as if they were real.

## Writing to the vault

For any vault write or delete, use the tracked tools (\`write_vault_file\`, \`delete_vault_file\`, \`rename_vault_file\`) — never raw bash redirects or other file tools; they handle undo snapshots and index updates. Don't call index_file after write_vault_file. To rename or move, use rename_vault_file, not write+delete.

To change PART of a file, prefer a targeted edit over rewriting it whole (smaller blast radius, won't clobber other content or a concurrent user edit):
- \`write_frontmatter_property\` / \`write_frontmatter_properties\` — set or delete one or several frontmatter keys (omit the value to delete).
- \`write_place_body\` — replace the markdown body, leaving frontmatter untouched.
Pair these with \`get_active_file\` for "add a note to this place" → get_active_file, then write_place_body on that path.

To SAVE places or routes, use \`save_features_to_vault\`, not hand-written write_vault_file content — it writes the app's exact place format (\`geometry\` WKT, canonical properties from the geocoder source, cover photo). Reference looked-up places by \`result_id\`, a route by its \`route_id\` plus a title, ad-hoc points by title + lat/lng. Reserve write_vault_file for non-place notes, edits, and non-point geometry you authored.

## Show vs. save

- Find / show / search / explore / preview → present results ephemerally with \`present_features\`; write nothing.
- Save / create / add / update / organize → write vault files: \`save_features_to_vault\` for places and routes, \`write_vault_file\` for everything else.

## Presenting places and features

\`present_features\` is the one tool for putting transient (unsaved) features on the map — points, routes, polygons. Use it, not a Markdown list or table, whenever you show located places the user might pick from (search results, recommendations, matching saved places), draw a route, or draw an area. It renders the map markers AND a clickable, map-synced list in the chat from the same data, and takes an ordered \`features\` array (order preserved; kinds can be mixed).

To **change** a feature list the user already has open (add/remove/reorder places, edit \`preview_markdown\`, rename the tab), call \`get_active_file\` or \`get_open_tabs\` first to read \`layerId\` and the current \`features\`, then call \`present_features\` again with \`layer_id\` set to that \`layerId\` and a full replacement \`features\` array — do NOT omit \`layer_id\`; that opens a duplicate tab. Each tool response also returns \`layer_id\` for the list it created.

Reference each feature by handle, never by transcribed content — the exact field to set is on the tool's own schema:
- a looked-up geocode/POI result → \`result_id\` (the app fills in marker, title, and properties; transcribing them yourself causes drift like "fast_food" → "fast food"). Add only optional \`preview_markdown\`.
- a saved vault place → \`path\`; a route → \`route_id\`; an area → \`isochrone_id\`/\`geometry_id\`.
- only a genuinely un-lookup-able point → \`lat\`/\`lng\`/\`title\` (+ optional \`properties\` with canonical keys \`category\`/\`address\`/\`source_url\`). Never supply \`osm_id\`/\`wikidata_id\` yourself. Reserve \`preview_markdown\` for free prose.

The rendered list IS the user's view of the results. Once you've called present_features, do NOT re-list the places in your reply in any form (numbered, bulleted, table, one-per-line), and don't explain the map UI (clicking markers, saving, "Add all") — those are visible in the app. Reply with a one-or-two-sentence synthesis, naming at most a standout or two.

For directions the user will read step-by-step or re-route, use \`present_directions\` instead — it opens an interactive Directions tab and computes the route itself, so you needn't call get_directions first.

## Staying connected

These tools are served by the MapOS desktop app, and nothing launches it for you. If calls start failing because the connection dropped, the app was likely closed: reopen it (on macOS, \`open -a MapOS\`), then retry.`;
}

/** Representative point for a place's GeoJSON-geometry-JSON string (as stored on
 *  {@link PlaceRecord}): a Point's coordinate, a LineString's midpoint, or a Polygon's
 *  first-ring centroid. Null when the geometry is missing or unparseable. */
function representativePoint(
  geometryJson: string | undefined
): { lat: number; lng: number } | null {
  if (!geometryJson) return null;
  try {
    const geo = JSON.parse(geometryJson) as { type: string; coordinates: unknown };
    if (geo.type === "Point") {
      const [lng, lat] = geo.coordinates as number[];
      if (typeof lng === "number" && typeof lat === "number") return { lat, lng };
    } else if (geo.type === "LineString") {
      const coords = geo.coordinates as [number, number][];
      if (coords.length > 0) {
        const [lng, lat] = coords[Math.floor(coords.length / 2)];
        return { lat, lng };
      }
    } else if (geo.type === "Polygon") {
      const ring = (geo.coordinates as [number, number][][])[0];
      if (ring?.length) {
        const sum = ring.reduce((a, [lng, lat]) => [a[0] + lng, a[1] + lat], [0, 0]);
        return { lat: sum[1] / ring.length, lng: sum[0] / ring.length };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** One directions endpoint: a looked-up geocode result, a saved vault place, or an ad-hoc point. */
const directionsEndpointSchema = Type.Object({
  result_id: Type.Optional(
    Type.String({
      description:
        "The `id` of a geocode_search/reverse_geocode result to use as this endpoint. PREFERRED — the app takes the coordinates and name from the cached result."
    })
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Vault file path of a saved place (from query_spatial_index) to use as this endpoint; its geometry supplies the point and its title the label."
    })
  ),
  lat: Type.Optional(
    Type.Number({
      description: "Latitude of an ad-hoc endpoint (set with lng when you have no result_id/path)."
    })
  ),
  lng: Type.Optional(
    Type.Number({ description: "Longitude of an ad-hoc endpoint (set with lat)." })
  ),
  label: Type.Optional(
    Type.String({
      description:
        "Display name for an ad-hoc endpoint (lat/lng). Ignored when result_id/path is set."
    })
  )
});

type ResolvedDirectionsStop = {
  lat: number;
  lng: number;
  label: string;
  vaultPath?: string;
  resultId?: string;
};

/** Match coordinates at ~10cm — same precision as route frontmatter round-trips. */
function coordsNear(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  precision = 6
): boolean {
  return (
    a.lat.toFixed(precision) === b.lat.toFixed(precision) &&
    a.lng.toFixed(precision) === b.lng.toFixed(precision)
  );
}

export function buildMaposCustomTools(
  places: Map<string, PlaceRecord>,
  maposDir: string,
  /** Electron userData dir — where region packs live (app-scoped, not vault-scoped). */
  appStateDir: string,
  onVaultWrite: (op: VaultOperation) => void,
  /** Conversation-scoped cache of geocoder results, keyed by `GeocodeResult.id`. Owned by
   *  the caller so it outlives this tool set (which is rebuilt when the session is). */
  geocodeStore: Map<string, GeocodeResult>,
  /** Conversation-scoped geometry stash (routes, isochrones, geo_compute output), keyed by
   *  opaque handle. Owned + persisted by the caller so handles survive session re-creation
   *  and app restart. See {@link StashedGeometry}. */
  geometryStore: Map<string, StashedGeometry>,
  /** Called after the stash mutates so the caller can persist it. */
  onGeometryUpdate: () => void
): ToolDefinition[] {
  // Pass-by-reference store for large geometries returned to the agent, so coordinates
  // never cross the LLM boundary. Route entries carry summary facts too, so saving a
  // route derives them from the source rather than round-tripping through the model.
  const nextGeometryId = (prefix: string): string => {
    // Monotonic across rehydration: 1 + the max numeric suffix already present, over ALL
    // prefixes, so ids never collide even after eviction or a reload from disk.
    let max = 0;
    for (const key of geometryStore.keys()) {
      const n = Number.parseInt(key.slice(key.indexOf("_") + 1), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}_${max + 1}`;
  };
  const stashGeometry = (entry: StashedGeometry, prefix: string): string => {
    const id = nextGeometryId(prefix);
    geometryStore.set(id, entry);
    if (geometryStore.size > 50) {
      const oldest = geometryStore.keys().next().value;
      if (oldest != null && oldest !== id) geometryStore.delete(oldest);
    }
    onGeometryUpdate();
    return id;
  };
  const stashRoute = (route: {
    geometry: Geometry;
    distanceMeters: number;
    durationSeconds: number;
    mode: string;
    stops: StashedRouteStop[];
  }): string => stashGeometry({ kind: "route", ...route }, "route");
  /** Resolve an opaque handle to its geometry, or throw a clear, tool-naming miss error. */
  const resolveGeometryId = (id: string): StashedGeometry => {
    const stored = geometryStore.get(id);
    if (!stored) {
      throw new Error(
        `Unknown geometry id "${id}". Geometry handles are cached per conversation; if it was evicted or predates this feature, recompute it (get_directions / get_isochrone / geo_compute) and use the new id.`
      );
    }
    return stored;
  };
  // Ensure a polygon ring is explicitly closed (first point repeated at the end).
  const closeRing = (ring: [number, number][]): [number, number][] => {
    if (ring.length < 2) return ring;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last) return ring;
    const isClosed = first[0] === last[0] && first[1] === last[1];
    return isClosed ? ring : [...ring, first];
  };

  // `geocodeStore` (passed in, conversation-scoped) caches geocoder results so
  // present_features can reference a result by its `id`: the structured details are derived
  // HERE from the cached result — identical to the search UI — so facts never round-trip
  // through (and get reformatted or fabricated by) the model. Keyed by the stable
  // GeocodeResult.id.
  const stashGeocodeResults = (results: GeocodeResult[]): void => {
    for (const r of results) {
      geocodeStore.set(r.id, r);
      if (geocodeStore.size > 500) {
        const oldest = geocodeStore.keys().next().value;
        if (oldest != null) geocodeStore.delete(oldest);
      }
    }
  };

  // The spatial query tools tell the agent to pass file_path to present_features, which
  // re-resolves geometry itself — so the raw `geometry` GeoJSON per row is dead weight in
  // the model's context. Omit it, and cap the row count so a large bbox can't blow up context.
  const stripGeometry = (
    rows: Array<{
      file_path: string;
      geometry_type: string;
      color: string | null;
      icon: string | null;
      distance_m?: number;
    }>,
    limit: number
  ) => {
    const truncated = rows.length > limit;
    const features = rows.slice(0, limit).map((r) => ({
      file_path: r.file_path,
      geometry_type: r.geometry_type,
      ...(r.color != null ? { color: r.color } : {}),
      ...(r.icon != null ? { icon: r.icon } : {}),
      ...(r.distance_m != null ? { distance_m: r.distance_m } : {})
    }));
    return { features, count: features.length, truncated };
  };

  // Confine a caller-supplied path to the vault, returning the canonical absolute path (or
  // null if it escapes via `..`/absolute/symlink). Callers MUST use the returned path for
  // every filesystem call afterward — Node's fs functions resolve a relative input (e.g. a
  // vault-relative path handed back by get_active_file/list_vault_files) against the process's
  // cwd, not the vault root, so re-using the raw input here would silently defeat the check.
  const resolveUnderVault = (p: string): string | null => resolveInVault(maposDir, p);
  // Writes additionally may not touch the protected `.mapos/` config + index subtree.
  const resolveWritablePath = (p: string): string | null => {
    const resolved = resolveInVault(maposDir, p);
    if (resolved === null || isProtectedVaultPath(maposDir, p)) return null;
    return resolved;
  };

  const resolveDirectionsEndpoint = (ep: {
    result_id?: string;
    path?: string;
    lat?: number;
    lng?: number;
    label?: string;
  }): ResolvedDirectionsStop | { error: string } => {
    if (ep.result_id) {
      const cached = geocodeStore.get(ep.result_id);
      if (!cached) {
        return {
          error: `result_id "${ep.result_id}" is no longer cached (cleared on app restart or provider/model change). Re-run geocode_search and use the fresh id.`
        };
      }
      return {
        lat: cached.lat,
        lng: cached.lng,
        label: cached.primaryLabel,
        resultId: ep.result_id
      };
    }
    if (ep.path) {
      const abs = isAbsolute(ep.path) ? ep.path : join(maposDir, ep.path);
      const place = places.get(abs) ?? places.get(ep.path);
      if (!place) return { error: `No indexed place at path "${ep.path}".` };
      const pt = representativePoint(place.geometry);
      if (!pt) return { error: `Place "${ep.path}" has no location to route to.` };
      return {
        lat: pt.lat,
        lng: pt.lng,
        label: place.title || "Saved place",
        vaultPath: place.filePath
      };
    }
    if (typeof ep.lat === "number" && typeof ep.lng === "number") {
      return { lat: ep.lat, lng: ep.lng, label: ep.label || "Point" };
    }
    return { error: "Each endpoint needs a result_id, a path, or lat+lng." };
  };

  const vaultFilePaths = (): Iterable<string> => places.keys();

  const findVaultPathForStop = (
    stop: StashedRouteStop,
    savedByResultId: ReadonlyMap<string, string>
  ): string | undefined => {
    if (stop.vaultPath) return stop.vaultPath;
    if (stop.resultId) {
      const fromBatch = savedByResultId.get(stop.resultId);
      if (fromBatch) return fromBatch;
    }
    for (const place of places.values()) {
      const pt = representativePoint(place.geometry);
      if (pt && coordsNear(pt, stop)) return place.filePath;
    }
    return undefined;
  };

  const routeFrontmatterFromStash = (
    stored: StashedGeometry,
    savedByResultId: ReadonlyMap<string, string>
  ): RouteFrontmatter | null => {
    if (!stored.stops || stored.stops.length < 2) return null;
    const mode =
      stored.mode === "auto" || stored.mode === "pedestrian" || stored.mode === "bicycle"
        ? stored.mode
        : "auto";
    const paths = vaultFilePaths();
    const stops: RouteStop[] = stored.stops.map((stop, index) => {
      const vaultPath = findVaultPathForStop(stop, savedByResultId);
      return {
        label: stop.label.trim() || `Stop ${index + 1}`,
        lat: stop.lat,
        lng: stop.lng,
        ...(vaultPath ? { file: wikilinkForFile(vaultPath, maposDir, paths) } : {})
      };
    });
    return { mode, stops };
  };

  // Shared attribute-filter shape for the spatial query tools (query_spatial_index,
  // find_near, query_within_polygon). Mirrors db.ts `SpatialFilters`.
  const spatialFilters = Type.Object({
    folderPath: Type.Optional(Type.String()),
    name: Type.Optional(
      Type.String({
        description:
          "Find places by name: fuzzy match on the file basename (a place's name IS its filename — 'Adrian' matches Friends/Adrian.md), results ranked best-first. Tolerates case, accents, apostrophes, and small typos ('adrian's', 'cafe', 'adrain' all work)."
      })
    ),
    properties: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String())))
  });

  const presentFeatures = defineTool({
    name: "present_features",
    label: "Present features",
    description:
      "Show the user transient features on the map AND, for places, a clickable map-connected list in the chat, kept in sync. This is the ONE tool for putting features on the map without saving them — points, lines, and polygons. Use it — NOT a Markdown list or table — whenever you present located places the user might pick from (search results, recommendations, saved places matching a query), and use it to draw routes and areas. Each feature is ONE of: a geocode/POI result you just looked up (set `result_id` — STRONGLY PREFERRED, the app fills in its name/category/address from the source), a saved vault place (set `path`), a genuinely ad-hoc point you couldn't look up (set `lat`, `lng`, `title`), a route line (set `route_id` from get_directions), or a polygon/area (set `isochrone_id` from get_isochrone or `geometry_id` from geo_compute). Pass geometry by handle, NEVER by coordinates — re-emitting coordinates costs tens of thousands of tokens. Order is preserved. To UPDATE an open feature list (add/remove/reorder/edit notes), pass `layer_id` from get_active_file/get_open_tabs with a full replacement `features` array — omitting `layer_id` opens a new tab. For a route the user will read turn-by-turn or re-route, use present_directions; to keep anything, use save_features_to_vault.",
    parameters: Type.Object({
      features: jsonArrayParam(
        Type.Object({
          result_id: Type.Optional(
            Type.String({
              description:
                "The `id` of a result returned by geocode_search/reverse_geocode. PREFER this for anything you looked up: the app derives the marker, title, and properties (category, address, …) from the cached result — identical to the search UI. When set, leave title/lat/lng/properties unset; only `preview_markdown` is additive."
            })
          ),
          title: Type.Optional(
            Type.String({
              description:
                "Display name. Required ONLY for an ad-hoc place (no result_id and no path). Ignored when result_id or path is set."
            })
          ),
          path: Type.Optional(
            Type.String({
              description:
                "Vault file path of a saved place (as returned by query_spatial_index). Set this for a place already in the vault — its marker already exists on the map. Leave lat/lng unset in this case."
            })
          ),
          lat: Type.Optional(
            Type.Number({
              description:
                "Latitude — set together with lng ONLY for an ad-hoc result (no result_id)"
            })
          ),
          lng: Type.Optional(
            Type.Number({
              description:
                "Longitude — set together with lat ONLY for an ad-hoc result (no result_id)"
            })
          ),
          preview_markdown: Type.Optional(
            Type.String({
              description:
                "Optional free-prose note shown as the place card's body before save (e.g. why it's relevant, a recommendation). Put structured facts in `properties`, NOT here. Allowed alongside result_id."
            })
          ),
          properties: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description:
                'Structured details for an AD-HOC feature only (with result_id the app supplies these from the source). Use canonical keys when you genuinely know them: `category` (lowercase token, e.g. "restaurant", "fast_food"), `address` (street line), `source_url` (full URL). You may add extra keys (e.g. `cuisine`). Do NOT provide `osm_id`/`wikidata_id` — you have no reliable source for them and they will be dropped.'
            })
          ),
          route_id: Type.Optional(
            Type.String({
              description:
                "Opaque id returned by get_directions — draws that route as a line. The server resolves it to the full geometry without re-transmitting it through the LLM. Set only this (plus optional title/preview_markdown); it is not a browsable place."
            })
          ),
          geometry_id: Type.Optional(
            Type.String({
              description:
                "Opaque id of a stashed polygon (a geometry_id from geo_compute, or an isochrone_id from get_isochrone) — draws that area as a polygon. A MultiPolygon is expanded to several shapes automatically. Set only this (plus optional title/preview_markdown)."
            })
          ),
          isochrone_id: Type.Optional(
            Type.String({ description: "Alias for geometry_id when the handle is an isochrone." })
          )
        }),
        {
          minItems: 1,
          description: "Ordered features to show; order is preserved in the rendered list."
        }
      ),
      layer_name: Type.Optional(
        Type.String({ default: "search-results", description: "Name for the overlay layer" })
      ),
      layer_id: Type.Optional(
        Type.String({
          description:
            "Update an existing feature-list tab instead of opening a new one. Set to the `layerId` from get_active_file/get_open_tabs (or the `layer_id` returned by a prior present_features). Requires a full replacement `features` array."
        })
      )
    }),
    execute: async (toolCallId, args) => {
      const requestedLayerId =
        args.layer_id != null && args.layer_id.length > 0 ? args.layer_id : undefined;
      const updateExisting = requestedLayerId != null;
      const layerId = requestedLayerId ?? toolCallId;
      const features = coerceJsonArray(args.features);
      if (features.length === 0) {
        return TEXT_RESULT(
          JSON.stringify({
            error:
              "No features to present — `features` was empty or could not be parsed. Pass a non-empty JSON array of feature objects, each with a result_id, a path, or title+lat+lng."
          })
        );
      }
      const refs: string[] = [];
      const points: MapOverlayLayer["points"] = [];
      const lines: MapOverlayLayer["lines"] = [];
      const polygons: MapOverlayLayer["polygons"] = [];
      const vaultPaths: string[] = [];
      // result_ids the model referenced that aren't in the cache (and had no coord
      // fallback), so they were dropped. Reported back so the agent re-searches instead
      // of silently showing a short list. Happens mainly after a restart clears the cache.
      const unresolvedResultIds: string[] = [];
      features.forEach((f, i) => {
        if (f.path != null && f.path.length > 0) {
          refs.push(`vault:${f.path}`);
          vaultPaths.push(f.path);
          return;
        }

        // A route line, referenced by an opaque get_directions handle. Geometry is
        // resolved HERE from the stash so it never round-trips through the model.
        if (f.route_id) {
          const geom = resolveGeometryId(f.route_id).geometry;
          if (geom.type !== "LineString") {
            throw new Error(
              `Geometry id "${f.route_id}" is a ${geom.type}, not a line. Pass a route_id from get_directions.`
            );
          }
          const lineId = `${layerId}:line-${i}`;
          lines.push({
            id: lineId,
            coordinates: geom.coordinates as [number, number][],
            routeId: f.route_id,
            title: f.title,
            ...(f.preview_markdown != null ? { preview_markdown: f.preview_markdown } : {})
          });
          refs.push(`overlay:${lineId}`);
          return;
        }

        // A polygon/area, referenced by an isochrone_id or geo_compute geometry_id. A
        // MultiPolygon expands to several shapes.
        const polyHandle = f.geometry_id ?? f.isochrone_id;
        if (polyHandle) {
          const geom = resolveGeometryId(polyHandle).geometry;
          let ringSets: [number, number][][][];
          if (geom.type === "Polygon") {
            ringSets = [geom.coordinates as [number, number][][]];
          } else if (geom.type === "MultiPolygon") {
            ringSets = geom.coordinates as [number, number][][][];
          } else {
            throw new Error(
              `Geometry id "${polyHandle}" is a ${geom.type}, not a polygon. Pass an isochrone_id or a polygon geometry_id.`
            );
          }
          ringSets.forEach((rings, j) => {
            const polyId = `${layerId}:polygon-${i}${ringSets.length > 1 ? `-${j}` : ""}`;
            polygons.push({
              id: polyId,
              coordinates: rings.map(closeRing),
              geometryId: polyHandle,
              title: f.title,
              ...(f.preview_markdown != null ? { preview_markdown: f.preview_markdown } : {})
            });
            refs.push(`overlay:${polyId}`);
          });
          return;
        }

        // Namespace with the layer id so ids stay unique across accumulated layers.
        const id = `${layerId}:feature-${i}`;

        // Preferred path: a geocoder result referenced by id. Title + properties are
        // derived HERE from the cached result via the same code the search UI uses, so
        // the model can't reformat facts or fabricate ids. Any extra keys it passed are
        // kept (sanitized), but source-derived category/address win.
        if (f.result_id) {
          const cached = geocodeStore.get(f.result_id);
          if (cached) {
            const properties = {
              ...sanitizeAdHocProperties(f.properties),
              ...detailPropertiesFromGeocodeResult(cached)
            };
            points.push({
              id,
              lat: cached.lat,
              lng: cached.lng,
              title: cached.primaryLabel,
              resultId: f.result_id,
              ...(f.preview_markdown != null ? { preview_markdown: f.preview_markdown } : {}),
              ...(Object.keys(properties).length > 0 ? { properties } : {})
            });
            refs.push(`overlay:${id}`);
            return;
          }
          // Cache miss (e.g. referenced after a restart cleared the cache): fall through
          // to ad-hoc coords if the model also supplied them, otherwise record it as
          // unresolved below so the agent knows to re-search.
        }

        if (typeof f.lat === "number" && typeof f.lng === "number" && f.title) {
          const properties = sanitizeAdHocProperties(f.properties);
          points.push({
            id,
            lat: f.lat,
            lng: f.lng,
            title: f.title,
            ...(f.preview_markdown != null ? { preview_markdown: f.preview_markdown } : {}),
            ...(Object.keys(properties).length > 0 ? { properties } : {})
          });
          refs.push(`overlay:${id}`);
          return;
        }

        // Nothing resolved this feature. If it named a result_id, surface it so the
        // agent re-searches; a feature with no result_id/path/coords is a malformed
        // call and is simply skipped.
        if (f.result_id) unresolvedResultIds.push(f.result_id);
      });

      // Vault paths ride along on the layer: the renderer resolves them against the
      // places index and draws their markers, since a presented place may lie outside
      // the selected folder and would otherwise have no marker on the map.
      const existingListTab =
        updateExisting && lastNavState
          ? lastNavState.tabs.find((t) => t.kind === "feature_list" && t.layerId === layerId)
          : undefined;
      const layer: MapOverlayLayer = {
        id: layerId,
        layerName: args.layer_name ?? existingListTab?.title ?? "search-results",
        points,
        lines,
        polygons,
        ...(vaultPaths.length > 0 ? { vaultPaths } : {})
      };
      const hasContent =
        points.length > 0 || lines.length > 0 || polygons.length > 0 || vaultPaths.length > 0;
      if (updateExisting) {
        if (!existingListTab) {
          return TEXT_RESULT(
            JSON.stringify({
              error: `No open feature list with layer_id "${layerId}". Call get_active_file or get_open_tabs for the current list, or omit layer_id to open a new one.`
            })
          );
        }
        sendToRenderer("map:overlay-update", layer);
      } else if (hasContent) {
        sendToRenderer("map:overlay-add", layer);
      }

      return TEXT_RESULT(
        JSON.stringify({
          kind: "feature_list",
          layer_id: layerId,
          updated: updateExisting,
          count: refs.length,
          refs: refs.join(","),
          ...(unresolvedResultIds.length > 0
            ? {
                unresolved_result_ids: unresolvedResultIds,
                warning: `${unresolvedResultIds.length} feature(s) referenced a result_id that is no longer cached (the cache is cleared on app restart or provider/model change) and were NOT shown. Re-run geocode_search/reverse_geocode for those places, then call present_features again with the fresh ids — do not give the user a short list that silently omits them.`
              }
            : {}),
          assistant_instructions:
            "This list is now displayed to the user as an interactive, map-linked card showing each feature's title and preview note. Do NOT repeat or enumerate these places in your text reply — no list, no per-place lines, no addresses already in the card. The user can already see and click them. Reply with at most one or two sentences (a standout, a pattern, or a brief confirmation), or nothing."
        })
      );
    }
  });

  const querySpatialIndexTool = defineTool({
    name: "query_spatial_index",
    label: "Query spatial index",
    description:
      "Query the spatial index for features, optionally within a bounding box. Returns saved places, notes, and any indexed files (file_path, geometry_type, color, icon — pass file_path to present_features, which re-resolves the geometry itself). `bounds` is optional: omit it to search the whole vault (e.g. when filtering by folder or property rather than location), or pass it to restrict to a rectangle. Use filters.properties to filter by any frontmatter multi-select or text field — e.g. { tags: ['ramen'], cuisine: ['japanese'] } requires the place to have ALL listed values under each key. Use filters.name to find a place BY NAME ('Home', 'Adrian's') — it matches the file basename, which is the place's name.",
    parameters: Type.Object({
      bounds: Type.Optional(
        Type.Object(
          {
            north: Type.Number(),
            south: Type.Number(),
            east: Type.Number(),
            west: Type.Number()
          },
          {
            description:
              "Optional bounding box. Omit to search the whole vault; provide to restrict results to a rectangle."
          }
        )
      ),
      filters: Type.Optional(spatialFilters),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1000, default: 200, description: "Max rows to return" })
      )
    }),
    execute: async (_id, args) => {
      const results = querySpatialIndex(args.bounds ?? null, args.filters);
      return TEXT_RESULT(JSON.stringify(stripGeometry(results, args.limit ?? 200)));
    }
  });

  const findNear = defineTool({
    name: "find_near",
    label: "Find nearby places",
    description:
      "Find indexed places near a point, sorted nearest-first. Returns the same records as " +
      "query_spatial_index plus `distance_m` (geodesic meters). Pass `radius_m` to cap results " +
      "to a circle (e.g. 'cafes within 500 m'), or omit it for the K nearest overall. Combine " +
      "with `filters` for 'nearest ramen' etc. Distance is to each feature's representative " +
      "point (exact for point places). Returned file paths can be passed to present_features.",
    parameters: Type.Object({
      lat: Type.Number(),
      lng: Type.Number(),
      radius_m: Type.Optional(
        Type.Number({ exclusiveMinimum: 0, description: "Optional cap, in meters" })
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
      filters: Type.Optional(spatialFilters)
    }),
    execute: async (_id, args) => {
      try {
        const results = queryNear(
          { lat: args.lat, lng: args.lng, radiusM: args.radius_m, limit: args.limit ?? 20 },
          args.filters
        );
        // queryNear already applies `limit`, so nothing is truncated here — pass it through
        // as the cap so stripGeometry never re-truncates.
        return TEXT_RESULT(JSON.stringify(stripGeometry(results, results.length)));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const queryWithinPolygonTool = defineTool({
    name: "query_within_polygon",
    label: "Query within polygon",
    description:
      "Find indexed places that fall inside a polygon region (e.g. a neighborhood the user drew " +
      "or an isochrone). Returns the same records as query_spatial_index (file_path, geometry_type, " +
      "color, icon). A place is included if any part of it intersects the region. Use this instead of " +
      "query_spatial_index when the area is not a rectangle. Pass the region by handle whenever you " +
      "have one — `region_id` (an isochrone_id from get_isochrone or a polygon geometry_id from " +
      "geo_compute) — so its coordinates never cross the LLM boundary; only pass `coordinates` for a " +
      "hand-built polygon. Returned file paths can be passed to present_features.",
    parameters: Type.Object({
      region_id: Type.Optional(
        Type.String({
          description:
            "Opaque id of a stashed polygon (an isochrone_id or a geo_compute geometry_id — any of region_id/isochrone_id/geometry_id is accepted). Preferred over coordinates."
        })
      ),
      isochrone_id: Type.Optional(Type.String({ description: "Alias for region_id." })),
      geometry_id: Type.Optional(Type.String({ description: "Alias for region_id." })),
      coordinates: Type.Optional(
        Type.Array(Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })), {
          description:
            "Array of rings; each ring is [[lng, lat], ...]. First ring is the outer boundary (auto-closed). Use only when you don't have a region_id."
        })
      ),
      filters: Type.Optional(spatialFilters),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1000, default: 200, description: "Max rows to return" })
      )
    }),
    execute: async (_id, args) => {
      try {
        // Resolve the region to one or more coordinate ring-sets. A region_id may be a
        // MultiPolygon (run each sub-polygon and dedupe); coordinates are a single polygon.
        const regionHandle = args.region_id ?? args.isochrone_id ?? args.geometry_id;
        let ringSets: number[][][][];
        if (regionHandle) {
          const geom = resolveGeometryId(regionHandle).geometry;
          if (geom.type === "Polygon") {
            ringSets = [geom.coordinates as number[][][]];
          } else if (geom.type === "MultiPolygon") {
            ringSets = geom.coordinates as number[][][][];
          } else {
            throw new Error(
              `Geometry id "${regionHandle}" is a ${geom.type}, not a polygon region.`
            );
          }
        } else if (args.coordinates) {
          ringSets = [args.coordinates as number[][][]];
        } else {
          throw new Error("Provide either region_id or coordinates.");
        }

        const byPath = new Map<string, ReturnType<typeof queryWithinPolygon>[number]>();
        for (const rings of ringSets) {
          for (const r of queryWithinPolygon(rings, args.filters)) {
            byPath.set(r.file_path, r);
          }
        }
        return TEXT_RESULT(JSON.stringify(stripGeometry([...byPath.values()], args.limit ?? 200)));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const spatialSql = defineTool({
    name: "spatial_sql",
    label: "Spatial SQL",
    description:
      "Run a single read-only SELECT against the local spatial index (SQLite) for analytical " +
      "questions query_spatial_index can't express — counts, GROUP BY, faceting, sorting, joins. " +
      "For placing markers on the map, prefer query_spatial_index.\n\n" +
      "Tables:\n" +
      "- features(rowid, file_path UNIQUE, geometry_type, geometry, color, icon, indexed_at). " +
      "`geometry` is a GeoJSON STRING — there are NO ST_* spatial functions; don't select it " +
      "unless you need raw coordinates (it can be large/costly). `geometry_type` is a lowercased " +
      "GeoJSON type (point, polygon, …).\n" +
      "- feature_properties(feature_id, key, value, type) — EAV, one row per value (multi-select " +
      "fields produce several rows). `feature_id` = features.file_path (NOT rowid). All values are " +
      "TEXT: use CAST(value AS REAL) to compare numbers.\n" +
      "- features_rtree(id, min_lat, max_lat, min_lng, max_lng) — bounding boxes; `id` = features.rowid.\n\n" +
      "Rules: exactly one SELECT statement (no writes, PRAGMA, ATTACH, or multiple statements — " +
      "all are rejected). List explicit columns, never SELECT *. Results are capped at 1000 rows " +
      "and large cells are truncated. Runs synchronously, so avoid unindexed cross joins.",
    parameters: Type.Object({
      query: Type.String({ description: "A single read-only SELECT statement." })
    }),
    execute: async (_id, args) => {
      try {
        return TEXT_RESULT(JSON.stringify(runReadonlyQuery(args.query)));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const geoCompute = defineTool({
    name: "geo_compute",
    label: "Compute geometry",
    description:
      "Run a single offline geometry operation (Turf). Provide the input as `geometry_id` (a " +
      "handle from get_directions/get_isochrone/a prior geo_compute — PREFERRED, keeps coordinates " +
      "off the LLM boundary), or `feature_paths` to pull geometry from the index by vault file path, " +
      "or inline `geometry` (a GeoJSON geometry, Feature, or FeatureCollection) for hand-built input. " +
      "For a second operand (union/intersect) use `geometry_b_id` or `geometry_b`. Geometry-producing " +
      "ops (buffer, centroid, convex_hull, simplify, union, intersect) DON'T return raw coordinates — " +
      "they stash the result and return a new `geometry_id` (plus type/pointCount/bbox) you pass " +
      "straight to present_features, query_within_polygon, or save_features_to_vault. Measurement " +
      "ops (area, length, bbox) and clusters_dbscan return their values inline. Operations:\n" +
      "- buffer — expand a shape by `params.radius_m` meters → Polygon.\n" +
      "- area — square meters of a polygon (returns { area_m2 }).\n" +
      "- length — meters of a line (returns { length_m }).\n" +
      "- centroid — center point → Feature<Point>.\n" +
      "- bbox — bounding box (returns { bbox, bounds }).\n" +
      "- convex_hull — tightest polygon around the input points/features.\n" +
      "- simplify — reduce vertices (`params.tolerance` in degrees, default 0.001).\n" +
      "- union / intersect — merge or intersect polygons; needs ≥2 polygons (via feature_paths, " +
      "or `geometry` + `geometry_b`).\n" +
      "- clusters_dbscan — cluster points within `params.max_distance_m` meters (adds a `cluster` property to each point).\n" +
      "Use find_near / query_within_polygon to SELECT places; use this to COMPUTE geometry.",
    parameters: Type.Object({
      operation: Type.Union(
        [
          Type.Literal("buffer"),
          Type.Literal("area"),
          Type.Literal("length"),
          Type.Literal("centroid"),
          Type.Literal("bbox"),
          Type.Literal("convex_hull"),
          Type.Literal("simplify"),
          Type.Literal("union"),
          Type.Literal("intersect"),
          Type.Literal("clusters_dbscan")
        ],
        { description: "The geometry operation to run" }
      ),
      geometry_id: Type.Optional(
        Type.String({
          description:
            "Opaque handle for the primary input (a route_id, isochrone_id, or prior geo_compute geometry_id — any of these key names is accepted). Preferred over inline geometry."
        })
      ),
      isochrone_id: Type.Optional(Type.String({ description: "Alias for geometry_id." })),
      route_id: Type.Optional(Type.String({ description: "Alias for geometry_id." })),
      geometry_b_id: Type.Optional(
        Type.String({ description: "Opaque handle for the second operand (union/intersect)." })
      ),
      isochrone_b_id: Type.Optional(Type.String({ description: "Alias for geometry_b_id." })),
      geometry: Type.Optional(
        Type.Unknown({ description: "Inline GeoJSON geometry, Feature, or FeatureCollection" })
      ),
      geometry_b: Type.Optional(
        Type.Unknown({
          description: "Second GeoJSON operand (e.g. the other polygon for intersect)"
        })
      ),
      feature_paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Vault file paths to resolve geometry from the index instead of inlining it"
        })
      ),
      params: Type.Optional(
        Type.Object({
          radius_m: Type.Optional(Type.Number({ description: "buffer distance, meters" })),
          tolerance: Type.Optional(Type.Number({ description: "simplify tolerance, degrees" })),
          max_distance_m: Type.Optional(
            Type.Number({ description: "clusters_dbscan neighbor distance, meters" })
          )
        })
      )
    }),
    execute: async (_id, args) => {
      try {
        const operation = args.operation as GeoOperation;
        const primaryId = args.geometry_id ?? args.isochrone_id ?? args.route_id;
        const secondId = args.geometry_b_id ?? args.isochrone_b_id;
        const geometry = primaryId ? resolveGeometryId(primaryId).geometry : args.geometry;
        const geometryB = secondId ? resolveGeometryId(secondId).geometry : args.geometry_b;
        const result = runGeoCompute({
          operation,
          geometry,
          geometryB,
          featurePaths: args.feature_paths,
          params: args.params
        });

        // Measurement ops and clusters_dbscan return small/inspectable data — inline it.
        // clusters_dbscan's value is the per-point cluster labels, which a handle would hide.
        const inlineOps = new Set<GeoOperation>(["area", "length", "bbox", "clusters_dbscan"]);
        if (inlineOps.has(operation)) {
          return TEXT_RESULT(JSON.stringify(result));
        }

        // Geometry-producing ops: stash and return a handle instead of raw coordinates.
        const geom = extractGeometry(result);
        if (!geom) return TEXT_RESULT(JSON.stringify(result));
        const geometry_id = stashGeometry({ kind: "geometry", geometry: geom }, "geom");
        const b = turfBbox(geom);
        const summary: Record<string, unknown> = {
          geometry_id,
          geometry_type: geom.type,
          pointCount: countPositions(geom),
          bbox: b,
          bounds: { west: b[0], south: b[1], east: b[2], north: b[3] }
        };
        if (geom.type === "Point") {
          const [lng, lat] = geom.coordinates as number[];
          summary.lng = lng;
          summary.lat = lat;
        }
        return TEXT_RESULT(JSON.stringify(summary));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const indexFile = defineTool({
    name: "index_file",
    label: "Index file",
    description:
      "Re-index a specific file into the spatial index after writing it. Call this after creating or editing a place file so the map updates immediately.",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to the place file (must be under the MapOS vault)"
      })
    }),
    execute: async (_id, args) => {
      const path = resolveUnderVault(args.path);
      if (!path) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, reason: `Path must be under vault (${maposDir})` })
        );
      }
      const record = await parsePlaceFile(path);
      syncFeatureForFile(path, record);
      if (record) return TEXT_RESULT(JSON.stringify({ success: true }));
      return TEXT_RESULT(JSON.stringify({ success: false, reason: "Could not parse file" }));
    }
  });

  const rebuildIndex = defineTool({
    name: "rebuild_index",
    label: "Rebuild spatial index",
    description:
      "Clear and rebuild the entire spatial index by re-scanning all place files. Use if the index seems stale or corrupt.",
    parameters: Type.Object({}),
    execute: async () => {
      const count = rebuildIndexFromPlaces(places);
      return TEXT_RESULT(JSON.stringify({ count }));
    }
  });

  const getViewport = defineTool({
    name: "get_viewport",
    label: "Get viewport",
    description:
      "Returns the current map viewport: bounding box, center coordinates, and zoom level.",
    parameters: Type.Object({}),
    execute: async () => {
      if (!lastViewport) {
        return TEXT_RESULT(JSON.stringify({ error: "Viewport not yet available" }));
      }
      return TEXT_RESULT(JSON.stringify(lastViewport));
    }
  });

  const panTo = defineTool({
    name: "pan_to",
    label: "Pan map",
    description:
      "Move the map camera to a location. Use after rendering search results or creating a new place.",
    parameters: Type.Object({
      lat: Type.Number({ description: "Latitude" }),
      lng: Type.Number({ description: "Longitude" }),
      zoom: Type.Optional(Type.Number({ description: "Zoom level 0-20, default 14" }))
    }),
    execute: async (_id, args) => {
      sendToRenderer("map:pan-to", {
        lat: args.lat,
        lng: args.lng,
        zoom: args.zoom
      });
      return TEXT_RESULT(`Map panning to ${args.lat}, ${args.lng}`);
    }
  });

  // Absolute vault path → vault-relative POSIX (matching read/list/search output); falls
  // back to the absolute path if it somehow isn't under the vault.
  const toVaultRelative = (abs: string): string => {
    const rel = relative(maposDir, abs);
    return rel === "" || rel.startsWith("..") ? abs : rel.split(sep).join("/");
  };

  const formatNavTabForAgent = (tab: NavTabInfo) => {
    if (tab.kind === "feature_list") {
      return {
        kind: tab.kind,
        layerId: tab.layerId,
        title: tab.title,
        featureCount: tab.features.length,
        features: tab.features
      };
    }
    return {
      kind: tab.kind,
      path: toVaultRelative(tab.path),
      title: tab.title
    };
  };

  const getActiveFile = defineTool({
    name: "get_active_file",
    label: "Get active file",
    description:
      'Returns what the user is viewing in the active tab: a vault place/folder (`kind: "place"` or `"folder"`, with `path`) or an ephemeral feature list (`kind: "feature_list"`, with `layerId` and `features`). Use for "this place", "this list", "remove the third one", "add a note here". Returns { activeFile: null } when nothing is open.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!lastNavState) {
        return TEXT_RESULT(JSON.stringify({ error: "App navigation state not yet available" }));
      }
      const a = lastNavState.active;
      if (!a) return TEXT_RESULT(JSON.stringify({ activeFile: null }));
      return TEXT_RESULT(JSON.stringify({ activeFile: formatNavTabForAgent(a) }));
    }
  });

  const getOpenTabs = defineTool({
    name: "get_open_tabs",
    label: "Get open tabs",
    description:
      "Returns the user's open tabs (workspace): vault places/folders and ephemeral feature lists. Feature-list tabs include `layerId` and `features` for modifying an existing list via present_features with `layer_id`. Also returns activeIndex.",
    parameters: Type.Object({}),
    execute: async () => {
      if (!lastNavState) {
        return TEXT_RESULT(JSON.stringify({ error: "App navigation state not yet available" }));
      }
      const tabs = lastNavState.tabs.map((t) => formatNavTabForAgent(t));
      return TEXT_RESULT(
        JSON.stringify({ tabs, activeIndex: lastNavState.activeIndex, count: tabs.length })
      );
    }
  });

  const openFile = defineTool({
    name: "open_file",
    label: "Open file",
    description:
      "Open a vault place file in a tab in the app so the user sees it (and its location on the map). Use this to SHOW the user a note or place you just created or found — e.g. after save_features_to_vault or write_vault_file. Takes an absolute or vault-relative path.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or vault-relative path to the file to open" })
    }),
    execute: async (_id, args) => {
      const abs = isAbsolute(args.path) ? args.path : join(maposDir, args.path);
      if (!resolveInVault(maposDir, abs)) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: `Path must be within vault (${maposDir})` })
        );
      }
      if (!existsSync(abs)) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "File not found" }));
      }
      sendToRenderer("nav:open-file", { path: abs });
      return TEXT_RESULT(JSON.stringify({ success: true, path: toVaultRelative(abs) }));
    }
  });

  const getCurrentLocation = defineTool({
    name: "get_current_location",
    label: "Get current location",
    description:
      "Get the user's current physical location (device GPS/Wi-Fi) as { lat, lng, accuracy (meters) }. Triggers a fresh fix each call — use it to ground 'near me', 'how far am I from…', or 'route me home' in where the user actually is, rather than the map viewport (where they're looking). Set `reveal_on_map: true` to also drop the location marker and fly the map there in the same call (identical to the app's 'My location' button) — do this for 'where am I' or 'take me to my location'; leave it false when you just need the coordinates for a calculation. The first call may prompt the OS for location permission; returns { location: null, error } if permission is denied, times out, or is unavailable.",
    parameters: Type.Object({
      reveal_on_map: Type.Optional(
        Type.Boolean({
          description:
            "When true, also show the location on the map (drop the marker and fly to it), like clicking 'My location'. Default false — just return the coordinates without moving the map."
        })
      )
    }),
    execute: async (_id, args) => {
      if (!getMainWindow()) {
        return TEXT_RESULT(JSON.stringify({ location: null, error: "App window not available" }));
      }
      const id = `loc_${++locateSeq}`;
      const reveal = args.reveal_on_map ?? false;
      const reply = await new Promise<LocateReply>((resolve) => {
        // 12s ceiling — just over the renderer's 10s getCurrentPosition timeout, so a
        // hung fix still resolves the tool rather than blocking the client forever.
        const timer = setTimeout(() => {
          if (pendingLocates.delete(id)) {
            resolve({ id, ok: false, error: "Location request timed out" });
          }
        }, 12_000);
        pendingLocates.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        sendToRenderer("geo:locate-request", { id, reveal });
      });
      if (!reply.ok) {
        return TEXT_RESULT(JSON.stringify({ location: null, error: reply.error }));
      }
      return TEXT_RESULT(
        JSON.stringify({
          location: { lat: reply.lat, lng: reply.lng, accuracy: reply.accuracy }
        })
      );
    }
  });

  const geocodeSearch = defineTool({
    name: "geocode_search",
    label: "Geocode search",
    description:
      "Forward geocode a free-text query (place name, address, or category words like 'restaurants') using downloaded offline region packs. Returns up to `limit` points, each with a stable `id`. Good for turning 'kinka izakaya toronto' into lat/lng, or for offline POI search — pass `categories` (with or without `query`) to filter, e.g. all cafes in the viewport bbox. For \"POIs within an isochrone/area\", pass `within_id` (an isochrone_id or a geo_compute polygon geometry_id): results are kept only if they fall INSIDE that polygon — a plain `bbox` is just a rectangular ranking bias and lets in POIs outside the shape. To show any of these results to the user, pass its `id` to present_features as `result_id` — do NOT re-type its name, category, or address; the app fills those from the result.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Search query, e.g. place name or address. Also matches category words ('restaurants', 'coffee') offline. Omit for a pure category filter."
        })
      ),
      categories: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Restrict to normalized category ids, e.g. ['restaurant','cafe','hotel','supermarket','park']. Offline region packs only."
        })
      ),
      kinds: Type.Optional(
        Type.Array(
          Type.Union([Type.Literal("place"), Type.Literal("poi"), Type.Literal("street")]),
          { description: "Restrict to feature kinds, e.g. ['poi']. Offline region packs only." }
        )
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description:
            "Max results (default 8; 50 when restricting to within_id / a restrict_bbox, since those mean 'give me everything in the area'). Raise it for a dense category in a large area."
        })
      ),
      lang: Type.Optional(
        Type.String({ description: "ISO 639-1 language code for labels, e.g. 'en', 'fr'" })
      ),
      bbox: Type.Optional(
        Type.Object(
          {
            north: Type.Number(),
            south: Type.Number(),
            east: Type.Number(),
            west: Type.Number()
          },
          { description: "Optional bias rectangle; results near this box score higher" }
        )
      ),
      within_id: Type.Optional(
        Type.String({
          description:
            'Opaque id of a stashed polygon (an isochrone_id or a geo_compute geometry_id). Results are hard-filtered to those inside this polygon, and it also biases ranking toward the polygon\'s area. Use this for "within an isochrone/area" queries — unlike bbox it excludes POIs outside the shape.'
        })
      ),
      isochrone_id: Type.Optional(Type.String({ description: "Alias for within_id." })),
      geometry_id: Type.Optional(Type.String({ description: "Alias for within_id." })),
      restrict_bbox: Type.Optional(
        Type.Boolean({
          description:
            "When true and a `bbox` is given, hard-filter results to inside the box (offline packs) rather than only biasing ranking toward it — e.g. 'every cafe in this rectangle'. `within_id` already implies this for its polygon's bounding box."
        })
      )
    }),
    execute: async (_id, args) => {
      try {
        // Resolve an optional containment polygon. When present it both restricts the
        // geocoder to the polygon's bounding box (hard, via the offline R-tree) and then
        // point-in-polygon filters the results to the exact shape. Restricting at the SQL
        // level first means the candidate set is everything in the box, not just the
        // top-ranked few — so the shape filter isn't starved of in-polygon candidates.
        const withinHandle = args.within_id ?? args.isochrone_id ?? args.geometry_id;
        let withinPolygon: Geometry | null = null;
        let bbox = args.bbox;
        if (withinHandle) {
          withinPolygon = resolveGeometryId(withinHandle).geometry;
          if (withinPolygon.type !== "Polygon" && withinPolygon.type !== "MultiPolygon") {
            throw new Error(
              `within_id "${withinHandle}" is a ${withinPolygon.type}, not a polygon.`
            );
          }
          if (!bbox) {
            const [west, south, east, north] = turfBbox(withinPolygon);
            bbox = { north, south, east, west };
          }
        }
        // Restrict at the source when containing a polygon, or when the caller asked to
        // hard-clip a plain bbox. Otherwise bbox stays a ranking bias (the default).
        const bboxMode =
          bbox && (withinPolygon || args.restrict_bbox) ? ("restrict" as const) : undefined;
        // "Within an area" means "give me all of them", so default higher when restricting;
        // a plain lookup still defaults to 8. Either way the caller can override.
        const limit = args.limit ?? (bboxMode === "restrict" ? 50 : 8);
        const results = await getServiceClient().geocoding.forward({
          query: args.query,
          categories: args.categories,
          kinds: args.kinds,
          limit,
          lang: args.lang,
          bbox,
          bboxMode
        });
        const poly = withinPolygon as Polygon | MultiPolygon | null;
        const filtered = poly
          ? results.filter((r) => booleanPointInPolygon([r.lng, r.lat], poly))
          : results;
        stashGeocodeResults(filtered);
        return TEXT_RESULT(JSON.stringify({ results: filtered }));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const reverseGeocodeTool = defineTool({
    name: "reverse_geocode",
    label: "Reverse geocode",
    description:
      "Reverse geocode a point (lat/lng) using downloaded offline region packs. Returns nearby named feature(s), each with a stable `id`. Pass `categories` to ask 'what restaurants/cafes are near here' (offline packs only). To show a result, pass its `id` to present_features as `result_id` — do NOT re-type its name, category, or address.",
    parameters: Type.Object({
      lat: Type.Number(),
      lng: Type.Number(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 1 })),
      lang: Type.Optional(Type.String()),
      categories: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Restrict to normalized category ids, e.g. ['restaurant','cafe']. Offline region packs only."
        })
      )
    }),
    execute: async (_id, args) => {
      try {
        const results = await getServiceClient().geocoding.reverse({
          point: { lat: args.lat, lng: args.lng },
          limit: args.limit ?? 1,
          lang: args.lang,
          categories: args.categories
        });
        stashGeocodeResults(results);
        return TEXT_RESULT(JSON.stringify({ results }));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const getDirectionsTool = defineTool({
    name: "get_directions",
    label: "Get directions",
    description:
      "Compute a route between two or more locations via Valhalla. Returns: distanceMeters, durationSeconds, a `route_id` (opaque handle), pointCount, and turn-by-turn `maneuvers`. Use 'pedestrian' for walking, 'bicycle' for cycling, 'auto' for driving. For 'pedestrian' and 'bicycle' it also returns elevationGainMeters, elevationLossMeters, minElevationMeters and maxElevationMeters — total climb and descent, noise-filtered — which is how to compare two loops for how hilly they are. These are omitted when the region pack predates elevation support; say so rather than guessing at climb. The route shape is stored server-side; to draw it, pass the `route_id` to `present_features` as a feature with `route_id`; to save it as a vault file, pass it to `save_features_to_vault` with a title. Each location is ONE of: a geocode result (`result_id`, preferred), a saved vault place (`path`), or an ad-hoc point (`lat`+`lng`, optional `label`). Prefer `result_id`/`path` over bare coordinates so saved routes reopen in the directions panel with linked stops. Do NOT attempt to retrieve, decode, downsample, or re-emit the route geometry yourself — there is no need.",
    parameters: Type.Object({
      locations: Type.Array(directionsEndpointSchema, {
        minItems: 2,
        description:
          "Ordered waypoints (2 or more). Each is a result_id, path, or lat+lng — same shape as present_directions locations."
      }),
      costing: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")], {
          default: "pedestrian"
        })
      )
    }),
    execute: async (_id, args) => {
      try {
        const costing = args.costing ?? "pedestrian";
        const resolved: ResolvedDirectionsStop[] = [];
        for (const loc of args.locations) {
          const r = resolveDirectionsEndpoint(loc);
          if ("error" in r) {
            return TEXT_RESULT(JSON.stringify({ success: false, error: r.error }));
          }
          resolved.push(r);
        }
        const route = await getServiceClient().routing.directions({
          locations: resolved.map((s) => ({ lat: s.lat, lng: s.lng })),
          costing,
          // Climb is part of the answer on foot or by bike, dead weight on a drive. The samples
          // themselves stay in the main process — only the aggregates below cross the boundary.
          elevation: costing !== "auto"
        });
        const elevation = hasElevationData(route.elevation)
          ? elevationStats(route.elevation ?? [])
          : null;
        const route_id = stashRoute({
          geometry: route.geometry,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          mode: costing,
          stops: resolved.map((s) => ({
            label: s.label,
            lat: s.lat,
            lng: s.lng,
            ...(s.vaultPath ? { vaultPath: s.vaultPath } : {}),
            ...(s.resultId ? { resultId: s.resultId } : {})
          }))
        });
        // Long routes can carry hundreds of maneuvers; cap what crosses the boundary.
        const MANEUVER_CAP = 60;
        const visible = {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          route_id,
          pointCount: route.geometry.coordinates.length,
          maneuvers: route.maneuvers.slice(0, MANEUVER_CAP),
          ...(route.maneuvers.length > MANEUVER_CAP
            ? { maneuvers_truncated_total: route.maneuvers.length }
            : {}),
          ...(elevation
            ? {
                elevationGainMeters: elevation.gainMeters,
                elevationLossMeters: elevation.lossMeters,
                minElevationMeters: elevation.minMeters,
                maxElevationMeters: elevation.maxMeters
              }
            : {})
        };
        return TEXT_RESULT(JSON.stringify(visible));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const presentDirections = defineTool({
    name: "present_directions",
    label: "Present directions",
    description:
      "Show the user turn-by-turn directions in a dedicated Directions tab (Google-Maps-style: an ordered list of stop inputs, a walk/bike/drive toggle, route summary, and the step list) and draw the route on the map. Use this — NOT present_features — when the user wants directions somewhere and will read the steps or adjust the stops. The tab computes and renders the route itself (and shows a download prompt if an offline region pack is missing), so you do NOT need to call get_directions first. For a simple A→B route, set `destination` (required) and optionally `origin` (omit it to default to the user's current location, exactly like the app's own Get-directions button). For a multi-stop route, pass `locations` — an ordered array of 2+ stops (first is the origin, last the destination, any in between are waypoints). Each endpoint/stop is ONE of: a geocode result you looked up (`result_id`, preferred), a saved vault place (`path`), or an ad-hoc point (`lat`+`lng`, optional `label`). Reserve get_directions for when you only need the distance/duration/steps as data to reason about.",
    parameters: Type.Object({
      destination: Type.Optional(directionsEndpointSchema),
      origin: Type.Optional(directionsEndpointSchema),
      locations: Type.Optional(
        Type.Array(directionsEndpointSchema, {
          description:
            "Ordered stops for a multi-stop route (2 or more): stops[0] is the origin, the last is the destination, any in between are waypoints. Use this INSTEAD of origin/destination when there are more than two stops."
        })
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")], {
          default: "auto",
          description:
            "Travel mode: 'auto' (drive), 'pedestrian' (walk), or 'bicycle'. Default 'auto'."
        })
      )
    }),
    execute: async (_id, args) => {
      const mode = args.mode ?? "auto";
      // Ordered stops sent to the renderer; a null entry is a blank input (only stops[0]
      // may be null → the renderer fills the user's current location).
      let stops: (ResolvedDirectionsStop | null)[];

      if (args.locations && args.locations.length > 0) {
        if (args.locations.length < 2) {
          return TEXT_RESULT(
            JSON.stringify({ success: false, error: "`locations` needs at least 2 stops." })
          );
        }
        const resolved: ResolvedDirectionsStop[] = [];
        for (const loc of args.locations) {
          const r = resolveDirectionsEndpoint(loc);
          if ("error" in r) {
            return TEXT_RESULT(JSON.stringify({ success: false, error: r.error }));
          }
          resolved.push(r);
        }
        stops = resolved;
      } else {
        if (!args.destination) {
          return TEXT_RESULT(
            JSON.stringify({
              success: false,
              error: "Provide `destination` (with optional `origin`), or `locations` for 2+ stops."
            })
          );
        }
        const destination = resolveDirectionsEndpoint(args.destination);
        if ("error" in destination) {
          return TEXT_RESULT(JSON.stringify({ success: false, error: destination.error }));
        }
        let origin: ResolvedDirectionsStop | null = null;
        if (args.origin) {
          const resolved = resolveDirectionsEndpoint(args.origin);
          if ("error" in resolved) {
            return TEXT_RESULT(JSON.stringify({ success: false, error: resolved.error }));
          }
          origin = resolved;
        }
        stops = [origin, destination];
      }

      sendToRenderer("nav:open-directions", { stops, mode });
      const originLabel = stops[0]?.label ?? "current location";
      const destinationLabel = stops[stops.length - 1]?.label ?? "destination";
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          kind: "directions",
          origin: originLabel,
          destination: destinationLabel,
          stops: stops.length,
          mode,
          assistant_instructions:
            "A Directions tab is now open with the route summary + turn-by-turn steps, and the route is drawn on the map. Do NOT re-list the steps or restate the distance/duration in your reply — the user can see them. Reply with at most one sentence (a caveat or standout), or nothing. If a needed offline map isn't downloaded, the tab shows a download prompt; only mention that if the user asked about offline availability."
        })
      );
    }
  });

  const getIsochroneTool = defineTool({
    name: "get_isochrone",
    label: "Get isochrone",
    description:
      "Compute reachable-area polygon(s) from a location for one or more time contours (in minutes). Returns contours sorted ascending by minutes; each has an `isochrone_id` (opaque handle to the polygon, kept off the LLM boundary) plus pointCount and bbox. To draw a contour, pass its `isochrone_id` to `present_features` as a feature with `isochrone_id`; to find places inside it, pass it as `query_within_polygon`'s `region_id`; to intersect two isochrones, pass their ids to geo_compute. Do not try to retrieve or re-emit the polygon coordinates yourself.",
    parameters: Type.Object({
      lat: Type.Number(),
      lng: Type.Number(),
      minutes_contours: Type.Array(Type.Number({ exclusiveMinimum: 0, maximum: 120 }), {
        minItems: 1,
        maxItems: 4,
        description: "Time contours in minutes, e.g. [5, 10, 15]"
      }),
      costing: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")], {
          default: "pedestrian"
        })
      )
    }),
    execute: async (_id, args) => {
      try {
        const iso = await getServiceClient().isochrones.contours({
          location: { lat: args.lat, lng: args.lng },
          minutesContours: args.minutes_contours,
          costing: args.costing ?? "pedestrian"
        });
        const contours = iso.contours.map((c) => {
          const isochrone_id = stashGeometry(
            { kind: "isochrone", geometry: c.polygon, minutes: c.minutes },
            "iso"
          );
          const b = turfBbox(c.polygon);
          return {
            minutes: c.minutes,
            isochrone_id,
            pointCount: c.polygon.coordinates[0]?.length ?? 0,
            bbox: b,
            bounds: { west: b[0], south: b[1], east: b[2], north: b[3] }
          };
        });
        return TEXT_RESULT(JSON.stringify({ contours }));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const getMatrixTool = defineTool({
    name: "get_matrix",
    label: "Get distance/time matrix",
    description:
      "Pairwise travel distance/time between sources and targets via Valhalla. Returns cells[sourceIdx][targetIdx] with distanceMeters/durationSeconds (null where unreachable). Keep N modest — prefer ≤ 10 sources × 10 targets.",
    parameters: Type.Object({
      sources: Type.Array(Type.Object({ lat: Type.Number(), lng: Type.Number() }), {
        minItems: 1,
        maxItems: 25
      }),
      targets: Type.Array(Type.Object({ lat: Type.Number(), lng: Type.Number() }), {
        minItems: 1,
        maxItems: 25
      }),
      costing: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")], {
          default: "pedestrian"
        })
      )
    }),
    execute: async (_id, args) => {
      try {
        const matrix = await getServiceClient().routing.matrix({
          sources: args.sources,
          targets: args.targets,
          costing: args.costing ?? "pedestrian"
        });
        return TEXT_RESULT(JSON.stringify(matrix));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const computeBboxTool = defineTool({
    name: "compute_bbox",
    label: "Compute bounding box",
    description:
      "Compute the bounding box that contains a set of lat/lng points. Useful for framing a viewport around search results or a route. Returns { north, south, east, west } or null for an empty list.",
    parameters: Type.Object({
      points: Type.Array(Type.Object({ lat: Type.Number(), lng: Type.Number() }))
    }),
    execute: async (_id, args) => {
      const b = computeBbox(args.points);
      return TEXT_RESULT(JSON.stringify(b));
    }
  });

  const readVaultFile = defineTool({
    name: "read_vault_file",
    label: "Read vault file",
    description:
      "Read a vault file's full text — markdown with its YAML frontmatter, or any UTF-8 text file. Use this to read a note before editing it, or to inspect a place file's frontmatter and body. Returns the raw contents. Binary files (images, etc.) return an error — reference those by path instead.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the file within the MapOS vault" })
    }),
    execute: async (_id, args) => {
      const resolved = resolveInVault(maposDir, args.path);
      if (!resolved) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: `Path must be within vault (${maposDir})` })
        );
      }
      if (!existsSync(resolved)) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "File not found" }));
      }
      let content: string;
      try {
        content = readFileSync(resolved, "utf-8");
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
      if (content.includes("\u0000")) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error:
              "File is not UTF-8 text (looks binary). Reference it by path instead of reading it."
          })
        );
      }
      const MAX_CHARS = 200_000;
      const truncated = content.length > MAX_CHARS;
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          path: args.path,
          content: truncated ? content.slice(0, MAX_CHARS) : content,
          ...(truncated ? { truncated: true } : {})
        })
      );
    }
  });

  const listVaultFiles = defineTool({
    name: "list_vault_files",
    label: "List vault files",
    description:
      "List files in the vault as vault-relative paths (forward slashes), for browsing or discovery. Optionally scope to a subfolder and/or filter by extension. Dot-directories like .mapos are skipped. Returns a flat, sorted list. Read one with read_vault_file, or find by content with search_vault_files.",
    parameters: Type.Object({
      folder: Type.Optional(
        Type.String({
          description:
            "Absolute path to a subfolder within the vault to list. Defaults to the whole vault."
        })
      ),
      extension: Type.Optional(
        Type.String({
          description: 'Filter to a single extension, e.g. "md" or "geojson" (no leading dot).'
        })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max paths to return (default 500, max 2000)." })
      )
    }),
    execute: async (_id, args) => {
      const base = resolveInVault(maposDir, args.folder ?? maposDir);
      if (!base) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: `Folder must be within vault (${maposDir})` })
        );
      }
      const limit = Math.min(Math.max(args.limit ?? 500, 1), 2000);
      const ext = args.extension?.replace(/^\./, "").toLowerCase();
      const all: string[] = [];
      collectVaultFiles(base, maposDir, all, 20_000);
      let files = ext ? all.filter((p) => p.toLowerCase().endsWith(`.${ext}`)) : all;
      files.sort();
      const truncated = files.length > limit;
      if (truncated) files = files.slice(0, limit);
      return TEXT_RESULT(JSON.stringify({ success: true, files, count: files.length, truncated }));
    }
  });

  const searchVaultFiles = defineTool({
    name: "search_vault_files",
    label: "Search vault files",
    description:
      "Search vault files for a query string, matching both file CONTENTS (case-insensitive by default; returns line numbers and matching lines) and FILENAMES (fuzzy: tolerates case, accents, apostrophes, and small typos; flagged `name_match` and ranked best-first, so 'adrian's' or 'adrain' finds Friends/Adrian.md even if its body never says it). Content matching is exact-substring — there is no full-text index. To find places spatially or by name WITH their geometry, prefer query_spatial_index (filters.name) / find_near.",
    parameters: Type.Object({
      query: Type.String({ description: "Text to search for within file contents." }),
      folder: Type.Optional(
        Type.String({
          description:
            "Absolute path to a subfolder to limit the search to. Defaults to the whole vault."
        })
      ),
      extension: Type.Optional(
        Type.String({ description: 'Extension to search, no leading dot. Defaults to "md".' })
      ),
      case_sensitive: Type.Optional(
        Type.Boolean({ description: "Match case exactly. Default false." })
      ),
      max_results: Type.Optional(
        Type.Number({ description: "Max matching files to return (default 30, max 100)." })
      )
    }),
    execute: async (_id, args) => {
      if (!args.query) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "query is required" }));
      }
      const base = resolveInVault(maposDir, args.folder ?? maposDir);
      if (!base) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: `Folder must be within vault (${maposDir})` })
        );
      }
      const ext = (args.extension?.replace(/^\./, "") ?? "md").toLowerCase();
      const maxFiles = Math.min(Math.max(args.max_results ?? 30, 1), 100);
      const needle = args.case_sensitive ? args.query : args.query.toLowerCase();
      const PER_FILE = 5;
      const SNIPPET = 240;
      const MAX_BYTES = 512_000;

      const all: string[] = [];
      collectVaultFiles(base, maposDir, all, 20_000);
      const candidates = all.filter((p) => p.toLowerCase().endsWith(`.${ext}`));

      // Filename matching is fuzzy and ranked, so score every candidate up front (cheap
      // string ops); only the content scan below is capped. The basename is the place's
      // name; the damped full-path score keeps folder-qualified queries working.
      const nameScores = new Map<string, number>();
      for (const rel of candidates) {
        const score = Math.max(
          scoreNameMatch(args.query, placeNameFromPath(rel)),
          0.95 * scoreNameMatch(args.query, rel)
        );
        if (score > 0) nameScores.set(rel, score);
      }

      const contentMatches = new Map<string, Array<{ line: number; text: string }>>();
      let scanned = 0;
      for (const rel of candidates) {
        if (contentMatches.size >= maxFiles) break;
        scanned++;
        try {
          const abs = join(maposDir, rel);
          if (statSync(abs).size > MAX_BYTES) continue;
          const text = readFileSync(abs, "utf-8");
          const hay = args.case_sensitive ? text : text.toLowerCase();
          if (!hay.includes(needle)) continue;
          const lines = text.split(/\r?\n/);
          const matches: Array<{ line: number; text: string }> = [];
          for (let i = 0; i < lines.length && matches.length < PER_FILE; i++) {
            const cmp = args.case_sensitive ? lines[i] : lines[i].toLowerCase();
            if (cmp.includes(needle)) {
              matches.push({ line: i + 1, text: lines[i].trim().slice(0, SNIPPET) });
            }
          }
          if (matches.length) contentMatches.set(rel, matches);
        } catch {
          // an unreadable body still allows a filename match
        }
      }

      // Filename hits first (best score first), then content-only hits in walk order.
      const ordered = [
        ...[...nameScores.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel),
        ...candidates.filter((rel) => contentMatches.has(rel) && !nameScores.has(rel))
      ];
      const results = ordered.slice(0, maxFiles).map((rel) => ({
        path: rel,
        ...(nameScores.has(rel) ? { name_match: true } : {}),
        matches: contentMatches.get(rel) ?? []
      }));
      const truncated =
        ordered.length > maxFiles ||
        (contentMatches.size >= maxFiles && scanned < candidates.length);
      return TEXT_RESULT(
        JSON.stringify({ success: true, results, count: results.length, truncated })
      );
    }
  });

  const writeVaultFile = defineTool({
    name: "write_vault_file",
    label: "Write vault file",
    description:
      "Write a vault file. Use this for ALL vault file writes — never use bash redirects or other file tools. Handles undo tracking and spatial index updates automatically. Do not call index_file after this. To save geocoded or ad-hoc places as NEW place files, use save_features_to_vault instead — it writes the app's canonical place format for you. Creating a new file is allowed by default; overwriting an EXISTING file requires `overwrite: true` (so an unintended clobber fails loudly) — set it only when you intend to replace the file's entire contents.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path within the MapOS vault" }),
      content: Type.String({ description: "Full file content to write" }),
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            "Required to replace an existing file. Omit or set false to create-only: the call fails if the path already exists instead of clobbering it."
        })
      )
    }),
    execute: async (_id, args) => {
      const path = resolveWritablePath(args.path);
      if (!path) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `Path must be within the vault and outside .mapos/ (${maposDir})`
          })
        );
      }
      const exists = existsSync(path);
      if (exists && args.overwrite !== true) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error:
              "File already exists. Pass overwrite: true to replace its entire contents, or use a targeted edit instead of a full rewrite."
          })
        );
      }
      const previousContent = exists ? readFileSync(path, "utf-8") : null;
      onVaultWrite({ path, previousContent });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, args.content, "utf-8");
      try {
        const record = await parsePlaceFile(path);
        syncFeatureForFile(path, record);
      } catch {
        // Not a place file — skip indexing
      }
      // Catch the classic mistake of writing coordinates as plain properties:
      // such a file silently never renders on the map.
      let warning: string | undefined;
      try {
        const fm = matter(args.content).data as Record<string, unknown>;
        const coordKeys = ["lat", "lng", "latitude", "longitude"].filter((k) => k in fm);
        if (!("geometry" in fm) && coordKeys.length > 0) {
          warning = `Frontmatter has ${coordKeys.join("/")} but no \`geometry\` key, so this file will NOT appear on the map. Place files need WKT geometry, e.g. \`geometry: POINT(lng lat)\`. To save looked-up places, use save_features_to_vault instead.`;
        }
      } catch {
        // Unparseable frontmatter — not this tool's problem
      }
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          path,
          action: previousContent === null ? "created" : "modified",
          previousContent,
          newContent: args.content,
          ...(warning ? { warning } : {})
        })
      );
    }
  });

  const saveFeaturesToVault = defineTool({
    name: "save_features_to_vault",
    label: "Save places to vault",
    description:
      "Save one or more places to the vault as place files, in the exact same format as the app's own save affordance: `geometry` WKT frontmatter, structured properties derived from the geocoder source (category, address, osm_id, wikidata_id), and the place's Wikimedia cover photo when one exists. STRONGLY PREFERRED over write_vault_file for saving places and routes. Each feature is ONE of: a geocode/POI result you looked up (set `result_id` — the app derives the filename, geometry, and properties from the cached result, so never re-type its facts), a route from get_directions (set `route_id` plus a `title` — saves as a directions trip with `route` frontmatter so it reopens in the directions panel; pass stop result_ids to get_directions so wikilinks resolve), a stashed geometry like an isochrone or a geo_compute result (set `geometry_id` plus a `title` — the app expands the id to the polygon/line geometry), or a genuinely ad-hoc point you could not look up (set `title`, `lat`, `lng`). Filenames are derived from titles automatically.",
    parameters: Type.Object({
      features: jsonArrayParam(
        Type.Object({
          result_id: Type.Optional(
            Type.String({
              description:
                "The `id` of a result returned by geocode_search/reverse_geocode. PREFER this for anything you looked up. When set, leave title/lat/lng unset; `properties` and `body_markdown` are additive."
            })
          ),
          route_id: Type.Optional(
            Type.String({
              description:
                'The `route_id` returned by get_directions. Saves as a directions trip (`route` frontmatter + LINESTRING geometry) that reopens in the directions panel — never re-emit coordinates yourself. Requires `title` (e.g. "Day 1 route"); leave lat/lng unset. Pass the same stop result_ids to get_directions so saved stops wikilink correctly.'
            })
          ),
          geometry_id: Type.Optional(
            Type.String({
              description:
                "A stashed geometry handle (a geometry_id from geo_compute or an isochrone_id from get_isochrone — either key works). Saves it as a place file; the app resolves the WKT geometry — never re-emit coordinates yourself. Requires `title`; leave lat/lng unset. Only Point/LineString/Polygon geometry is supported (a MultiPolygon must be unioned/simplified first)."
            })
          ),
          isochrone_id: Type.Optional(
            Type.String({ description: "Alias for geometry_id when the handle is an isochrone." })
          ),
          title: Type.Optional(
            Type.String({
              description:
                "Display name, used for the filename. Required for an ad-hoc place or a route (not with result_id)."
            })
          ),
          lat: Type.Optional(
            Type.Number({
              description: "Latitude — set together with lng ONLY for an ad-hoc place"
            })
          ),
          lng: Type.Optional(
            Type.Number({
              description: "Longitude — set together with lat ONLY for an ad-hoc place"
            })
          ),
          properties: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description:
                'Extra frontmatter properties. Use canonical keys when you genuinely know them: `category` (lowercase token, e.g. "restaurant"), `address`, `source_url`, plus extra keys like `cuisine`. Do NOT provide `osm_id`/`wikidata_id` — with result_id the app supplies them from the source; without one you have no reliable source and they are dropped.'
            })
          ),
          body_markdown: Type.Optional(
            Type.String({
              description:
                "Markdown body for the file — free prose like why it's saved or a recommendation (same prose you may have shown as preview_markdown). Structured facts go in `properties`, not here."
            })
          )
        }),
        { minItems: 1, description: "Places to save." }
      ),
      folder: Type.Optional(
        Type.String({
          description:
            "Absolute folder path within the vault to save into. Created if missing. Defaults to the vault root."
        })
      )
    }),
    execute: async (_id, args) => {
      const folder = resolveWritablePath(args.folder ?? maposDir);
      if (!folder) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `Folder must be within the vault and outside .mapos/ (${maposDir})`
          })
        );
      }
      const features = coerceJsonArray(args.features);
      if (features.length === 0) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error:
              "No features to save — `features` was empty or could not be parsed. Pass a non-empty JSON array of feature objects, each with a result_id, route_id, geometry_id, or title+lat+lng."
          })
        );
      }

      type ResolvedFeature = {
        title: string;
        geometry: string;
        properties: Record<string, string>;
        wikidataId?: string;
        body?: string;
        sourceResultId?: string;
      };
      const resolved: ResolvedFeature[] = [];
      const pendingRoutes: Array<{
        title: string;
        geometry: string;
        body?: string;
        stored: StashedGeometry;
      }> = [];
      const unresolvedResultIds: string[] = [];
      const unresolvedRouteIds: string[] = [];
      const untitledRouteIds: string[] = [];
      const unresolvedGeometryIds: string[] = [];
      const untitledGeometryIds: string[] = [];
      const unsupportedGeometryIds: string[] = [];
      for (const f of features) {
        // Preferred path: derive everything from the cached geocoder result, exactly
        // like the search UI's save — the model never re-types facts. Extra keys it
        // passed are kept (sanitized) but source-derived properties win.
        if (f.result_id) {
          const cached = geocodeStore.get(f.result_id);
          if (cached) {
            resolved.push({
              title: cached.primaryLabel,
              geometry: `POINT(${cached.lng} ${cached.lat})`,
              properties: orderDetailProperties({
                ...sanitizeAdHocProperties(f.properties),
                ...detailPropertiesFromGeocodeResult(cached)
              }),
              wikidataId: cached.wikidataId,
              body: f.body_markdown,
              sourceResultId: f.result_id
            });
            continue;
          }
          // Cache miss: fall through to ad-hoc coords if supplied, else report it.
        }
        if (f.route_id) {
          const stored = geometryStore.get(f.route_id);
          if (!stored) {
            unresolvedRouteIds.push(f.route_id);
            continue;
          }
          if (!f.title) {
            untitledRouteIds.push(f.route_id);
            continue;
          }
          // Same principle as result_id: geometry and summary facts come from the
          // stashed source, never from the model.
          const wkt = geometryToWkt(stored.geometry);
          if (!wkt) {
            unsupportedGeometryIds.push(f.route_id);
            continue;
          }
          pendingRoutes.push({
            title: f.title,
            geometry: wkt,
            body: f.body_markdown,
            stored
          });
          continue;
        }
        const geomHandle = f.geometry_id ?? f.isochrone_id;
        if (geomHandle) {
          const stored = geometryStore.get(geomHandle);
          if (!stored) {
            unresolvedGeometryIds.push(geomHandle);
            continue;
          }
          if (!f.title) {
            untitledGeometryIds.push(geomHandle);
            continue;
          }
          const wkt = geometryToWkt(stored.geometry);
          if (!wkt) {
            unsupportedGeometryIds.push(geomHandle);
            continue;
          }
          resolved.push({
            title: f.title,
            geometry: wkt,
            properties: orderDetailProperties(sanitizeAdHocProperties(f.properties)),
            body: f.body_markdown
          });
          continue;
        }
        if (typeof f.lat === "number" && typeof f.lng === "number" && f.title) {
          resolved.push({
            title: f.title,
            geometry: `POINT(${f.lng} ${f.lat})`,
            properties: sanitizeAdHocProperties(f.properties),
            body: f.body_markdown
          });
          continue;
        }
        if (f.result_id) unresolvedResultIds.push(f.result_id);
      }

      if (resolved.length > 0 || pendingRoutes.length > 0) mkdirSync(folder, { recursive: true });

      // Prefetch covers concurrently; best-effort (offline or imageless QIDs skip).
      const covers = await Promise.all(
        resolved.map((r) => (r.wikidataId ? downloadWikidataImage(r.wikidataId) : null))
      );

      const saved: Array<{ path: string; title: string }> = [];
      const savedByResultId = new Map<string, string>();

      for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        const data: Record<string, unknown> = {
          geometry: r.geometry,
          ...r.properties
        };
        const downloaded = covers[i];
        if (downloaded) {
          const imported = await importAttachmentToVault(maposDir, {
            suggestedName: downloaded.fileName,
            bytes: downloaded.bytes
          });
          if (imported.success) {
            data.cover = imported.relPath;
            data.cover_source = downloaded.pageUrl;
          }
        }
        const base =
          r.title
            .trim()
            .replace(/[/\\:*?"<>|]/g, "")
            .trim() || "place";
        const path = uniquePathInDir(folder, `${base}.md`, false);
        const body = r.body?.trim();
        const content = stringifyPlaceFile(body ? `\n${body}\n` : "", data);
        onVaultWrite({ path, previousContent: null });
        writeFileSync(path, content, "utf-8");
        try {
          const record = await parsePlaceFile(path);
          syncFeatureForFile(path, record);
        } catch {
          // Indexing failure is non-fatal; the watcher will pick the file up
        }
        saved.push({ path, title: r.title });
        if (r.sourceResultId) savedByResultId.set(r.sourceResultId, path);
      }

      for (const pending of pendingRoutes) {
        const route = routeFrontmatterFromStash(pending.stored, savedByResultId);
        const data: Record<string, unknown> = {
          geometry: pending.geometry,
          ...(route ? { route } : {})
        };
        const base =
          pending.title
            .trim()
            .replace(/[/\\:*?"<>|]/g, "")
            .trim() || "route";
        const path = uniquePathInDir(folder, `${base}.md`, false);
        const body = pending.body?.trim();
        const content = stringifyPlaceFile(body ? `\n${body}\n` : "", data);
        onVaultWrite({ path, previousContent: null });
        writeFileSync(path, content, "utf-8");
        try {
          const record = await parsePlaceFile(path);
          syncFeatureForFile(path, record);
        } catch {
          // Indexing failure is non-fatal; the watcher will pick the file up
        }
        saved.push({ path, title: pending.title });
      }

      const warnings: string[] = [];
      if (unresolvedResultIds.length > 0) {
        warnings.push(
          `${unresolvedResultIds.length} feature(s) referenced a result_id that is no longer cached (the cache is cleared on app restart or provider/model change) and were NOT saved. Re-run geocode_search/reverse_geocode for those places, then call save_features_to_vault again with the fresh ids.`
        );
      }
      if (unresolvedRouteIds.length > 0) {
        warnings.push(
          `${unresolvedRouteIds.length} route(s) referenced a route_id that is no longer cached (routes are cached in-memory and evicted on restart) and were NOT saved. Re-run get_directions, then call save_features_to_vault again with the fresh route_id.`
        );
      }
      if (untitledRouteIds.length > 0) {
        warnings.push(
          `${untitledRouteIds.length} route(s) were NOT saved because they had no \`title\`. Routes require a title (used for the filename) — retry those features with a title set.`
        );
      }
      if (unresolvedGeometryIds.length > 0) {
        warnings.push(
          `${unresolvedGeometryIds.length} geometry(ies) referenced a geometry_id that is no longer cached (evicted or predates the current session) and were NOT saved. Recompute it (get_isochrone / geo_compute) and call save_features_to_vault again with the fresh id.`
        );
      }
      if (untitledGeometryIds.length > 0) {
        warnings.push(
          `${untitledGeometryIds.length} geometry(ies) were NOT saved because they had no \`title\`. A geometry_id requires a title (used for the filename) — retry those features with a title set.`
        );
      }
      if (unsupportedGeometryIds.length > 0) {
        warnings.push(
          `${unsupportedGeometryIds.length} geometry(ies) were NOT saved because their type isn't supported in a place file (only Point/LineString/Polygon). Union or simplify a MultiPolygon into a single polygon first.`
        );
      }
      return TEXT_RESULT(
        JSON.stringify({
          success: warnings.length === 0,
          saved,
          ...(unresolvedResultIds.length > 0 ? { unresolved_result_ids: unresolvedResultIds } : {}),
          ...(unresolvedRouteIds.length > 0 ? { unresolved_route_ids: unresolvedRouteIds } : {}),
          ...(untitledRouteIds.length > 0 ? { untitled_route_ids: untitledRouteIds } : {}),
          ...(unresolvedGeometryIds.length > 0
            ? { unresolved_geometry_ids: unresolvedGeometryIds }
            : {}),
          ...(untitledGeometryIds.length > 0 ? { untitled_geometry_ids: untitledGeometryIds } : {}),
          ...(unsupportedGeometryIds.length > 0
            ? { unsupported_geometry_ids: unsupportedGeometryIds }
            : {}),
          ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          assistant_instructions:
            "The files are saved and indexed. Confirm briefly — do not enumerate every saved place in your reply."
        })
      );
    }
  });

  // Shared path for targeted edits: confine + require-exists, snapshot for undo, let the
  // caller transform the content, then write and re-index — mirroring write_vault_file so
  // the index and undo trail stay consistent. `transform` receives a CLONE of the parsed
  // frontmatter data (safe to mutate), the body, and the raw file text.
  const applyVaultEdit = async (
    rawPath: string,
    transform: (data: Record<string, unknown>, body: string, raw: string) => string
  ) => {
    const filePath = resolveWritablePath(rawPath);
    if (!filePath) {
      return TEXT_RESULT(
        JSON.stringify({
          success: false,
          error: `Path must be within the vault and outside .mapos/ (${maposDir})`
        })
      );
    }
    if (!existsSync(filePath)) {
      return TEXT_RESULT(JSON.stringify({ success: false, error: "File not found" }));
    }
    const previousContent = readFileSync(filePath, "utf-8");
    let newContent: string;
    try {
      const parsed = matter(previousContent);
      newContent = transform(
        { ...(parsed.data as Record<string, unknown>) },
        parsed.content,
        previousContent
      );
    } catch (err) {
      return TEXT_RESULT(errorPayload(err));
    }
    onVaultWrite({ path: filePath, previousContent });
    writeFileSync(filePath, newContent, "utf-8");
    try {
      const record = await parsePlaceFile(filePath);
      syncFeatureForFile(filePath, record);
    } catch {
      // Not a place file — skip indexing
    }
    return TEXT_RESULT(
      JSON.stringify({
        success: true,
        path: filePath,
        action: "modified",
        previousContent,
        newContent
      })
    );
  };

  const writeFrontmatterProperty = defineTool({
    name: "write_frontmatter_property",
    label: "Write frontmatter property",
    description:
      "Set or delete ONE YAML frontmatter key on an existing file, preserving the rest of the frontmatter and the body. Prefer this over rewriting the whole file with write_vault_file. Pass the value using the correct type (number/boolean/array/string); omit the value (or pass null) to delete the key. Setting `geometry` (WKT) moves the place; setting `color` to a 6-digit hex string ('#ef4444') recolors its marker; setting `icon` to a single emoji draws it as the marker (a word or several emoji is ignored). Deleting `color` or `icon` restores the default marker.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path within the MapOS vault" }),
      key: Type.String({ description: "Frontmatter key to set or delete" }),
      value: Type.Optional(
        Type.Unknown({
          description:
            "New value (number, boolean, array, or string). Omit or pass null to delete the key."
        })
      )
    }),
    execute: async (_id, args) =>
      applyVaultEdit(args.path, (data, body) => {
        if (args.value === null || args.value === undefined) delete data[args.key];
        else data[args.key] = args.value;
        return stringifyPlaceFile(body, data);
      })
  });

  const writeFrontmatterProperties = defineTool({
    name: "write_frontmatter_properties",
    label: "Write frontmatter properties",
    description:
      "Set or delete SEVERAL frontmatter keys in one write, preserving other keys and the body. Each value: correct YAML type to set; empty string is skipped; null deletes the key. Prefer this over a full-file rewrite when changing multiple properties.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path within the MapOS vault" }),
      properties: Type.Record(Type.String(), Type.Unknown(), {
        description: "Map of frontmatter key → value. null deletes a key; empty string is skipped."
      })
    }),
    execute: async (_id, args) =>
      applyVaultEdit(args.path, (data, body) => {
        for (const [key, value] of Object.entries(args.properties)) {
          if (value === "") continue;
          if (value === null || value === undefined) delete data[key];
          else data[key] = value;
        }
        return stringifyPlaceFile(body, data);
      })
  });

  const writePlaceBody = defineTool({
    name: "write_place_body",
    label: "Write place body",
    description:
      "Replace the markdown body BELOW the frontmatter of an existing file, leaving the frontmatter (geometry, properties) exactly as-is. Use this to write or edit a note's prose without touching its structured fields. To reference saved places in the body, link them with [[Title]] wikilinks.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path within the MapOS vault" }),
      body: Type.String({ description: "New markdown body (frontmatter is preserved separately)" })
    }),
    execute: async (_id, args) =>
      applyVaultEdit(args.path, (_data, _body, raw) => {
        // Preserve the exact frontmatter block byte-for-byte; only swap the body.
        const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const fm = fmMatch ? fmMatch[0] : "";
        return fm + (args.body.trim() ? `\n${args.body.trim()}\n` : "");
      })
  });

  const deleteVaultFile = defineTool({
    name: "delete_vault_file",
    label: "Delete vault file",
    description:
      "Delete a vault file. Use this instead of bash rm. Handles undo tracking and spatial index cleanup automatically.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path within the MapOS vault to delete" })
    }),
    execute: async (_id, args) => {
      const path = resolveWritablePath(args.path);
      if (!path) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `Path must be within the vault and outside .mapos/ (${maposDir})`
          })
        );
      }
      if (!existsSync(path)) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "File not found" }));
      }
      const previousContent = readFileSync(path, "utf-8");
      onVaultWrite({ path, previousContent });
      removeFeatures([path]);
      removeFeaturePropertiesForFile(path);
      rmSync(path);
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          path,
          action: "deleted",
          previousContent,
          newContent: null
        })
      );
    }
  });

  const renameVaultFile = defineTool({
    name: "rename_vault_file",
    label: "Rename vault file",
    description:
      "Rename or move a vault file. Use this instead of write+delete when only the path is changing. Handles undo tracking and spatial index updates automatically. Fails if a file already exists at toPath unless `overwrite: true` is set, so a move never silently clobbers an existing file.",
    parameters: Type.Object({
      fromPath: Type.String({ description: "Current absolute path of the file within the vault" }),
      toPath: Type.String({ description: "New absolute path within the vault" }),
      overwrite: Type.Optional(
        Type.Boolean({
          description:
            "Required when a file already exists at toPath. Omit or set false to fail instead of overwriting the destination."
        })
      )
    }),
    execute: async (_id, args) => {
      const fromPath = resolveWritablePath(args.fromPath);
      const toPath = resolveWritablePath(args.toPath);
      if (!fromPath || !toPath) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: "Both paths must be within the vault and outside .mapos/"
          })
        );
      }
      if (!existsSync(fromPath)) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "Source file not found" }));
      }
      if (existsSync(toPath) && args.overwrite !== true) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: "A file already exists at toPath. Pass overwrite: true to replace it."
          })
        );
      }
      const content = readFileSync(fromPath, "utf-8");
      onVaultWrite({ path: fromPath, previousContent: content });
      onVaultWrite({
        path: toPath,
        previousContent: existsSync(toPath) ? readFileSync(toPath, "utf-8") : null
      });
      mkdirSync(dirname(toPath), { recursive: true });
      renameSync(fromPath, toPath);
      removeFeatures([fromPath]);
      removeFeaturePropertiesForFile(fromPath);
      try {
        const record = await parsePlaceFile(toPath);
        syncFeatureForFile(toPath, record);
      } catch {
        // Not a place file
      }
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          path: toPath,
          fromPath,
          action: "renamed",
          previousContent: content,
          newContent: content
        })
      );
    }
  });

  // ── Region packs (offline map data) ─────────────────────────────────────────
  // Managing downloadable offline data. Packs live under appStateDir/regions and are
  // app-scoped (shared across vaults). Downloads can be large (tens to hundreds of MB),
  // so download_region_pack forces the agent to have looked up (and thus can state) the
  // size before starting, and the download runs in the background with progress shown in
  // the app's Offline tab rather than blocking the tool call.
  const regionsDir = join(appStateDir, "regions");
  const bytesToMb = (b: number): number => Math.round((b / 1_000_000) * 10) / 10;
  /** Total bytes of a region's version (defaults to `latest`), or null if unknown. */
  const regionVersionBytes = async (
    region: string,
    version?: string
  ): Promise<{ version: string; totalBytes: number; name?: string } | { error: string }> => {
    const manifest = await fetchManifest();
    const entry = manifest.regions[region];
    if (!entry) return { error: `Unknown region "${region}".` };
    const ver = version ?? entry.latest;
    const versionEntry = entry.versions[ver];
    if (!versionEntry) return { error: `Region "${region}" has no version "${ver}".` };
    return {
      version: ver,
      totalBytes: versionEntry.total_bytes,
      ...(entry.name ? { name: entry.name } : {})
    };
  };

  const listRegionPacks = defineTool({
    name: "list_region_packs",
    label: "List region packs",
    description:
      "List offline map-data region packs: which are installed on disk, which are currently downloading (with percent), and — when you pass `query` — matching packs available to download with their size in MB. Region packs enable offline geocoding, routing, and map tiles for an area. The full catalog is large (hundreds of regions), so `available` results are only returned when you provide a `query` (matched against region slug and name). Use this to answer 'what maps do I have offline?' and to look up a download's size before calling download_region_pack.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Case-insensitive substring to search available regions by slug or name (e.g. 'quebec', 'france'). Omit to just see installed + in-progress packs."
        })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max available-region matches to return (default 25)." })
      )
    }),
    execute: async (_id, args) => {
      const installed = listLocalRegions(regionsDir).map((p) => ({
        region: p.region,
        ...(p.name ? { name: p.name } : {}),
        version: p.version,
        sizeMb: bytesToMb(p.totalBytes)
      }));
      const downloading = getActiveDownloads().map((p) => ({
        region: p.region,
        phase: p.phase,
        percent: p.totalBytes > 0 ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0,
        sizeMb: bytesToMb(p.totalBytes)
      }));

      let manifest: Awaited<ReturnType<typeof fetchManifest>>;
      try {
        manifest = await fetchManifest();
      } catch (err) {
        // Catalog needs the network; installed/downloading are local and still useful.
        return TEXT_RESULT(
          JSON.stringify({ installed, downloading, catalogError: errorPayload(err) })
        );
      }

      const total = Object.keys(manifest.regions).length;
      if (!args.query) {
        return TEXT_RESULT(
          JSON.stringify({
            installed,
            downloading,
            availableCount: total,
            note: `Pass 'query' to search ${total} available regions by name.`
          })
        );
      }
      const q = args.query.toLowerCase();
      const limit = args.limit ?? 25;
      const matches = Object.entries(manifest.regions)
        .filter(
          ([slug, e]) => slug.toLowerCase().includes(q) || (e.name ?? "").toLowerCase().includes(q)
        )
        .slice(0, limit)
        .map(([slug, e]) => {
          const v = e.versions[e.latest];
          return {
            region: slug,
            ...(e.name ? { name: e.name } : {}),
            latestVersion: e.latest,
            sizeMb: v ? bytesToMb(v.total_bytes) : null,
            installed: installed.some((i) => i.region === slug)
          };
        });
      return TEXT_RESULT(JSON.stringify({ installed, downloading, available: matches }));
    }
  });

  const downloadRegionPack = defineTool({
    name: "download_region_pack",
    label: "Download region pack",
    description:
      "Download an offline map-data region pack (offline geocoding, routing, and map tiles for an area). Downloads can be LARGE — tens to hundreds of MB. Before calling this you MUST tell the user the download size (get it from list_region_packs) and get their confirmation. You must pass `acknowledge_size_mb` — the size in MB you told the user — and it must match the actual size, or the call is rejected. The download runs in the background; progress appears in the app's Offline tab. Use list_region_packs to check when it finishes. Reversible with delete_region_pack.",
    parameters: Type.Object({
      region: Type.String({
        description: "Region slug to download (from list_region_packs, e.g. 'canada-quebec')."
      }),
      acknowledge_size_mb: Type.Number({
        description:
          "The download size in MB you told the user and they confirmed. Must match the actual pack size (from list_region_packs) within tolerance, else the call is rejected."
      }),
      version: Type.Optional(
        Type.String({ description: "Specific version to download. Defaults to the latest." })
      )
    }),
    execute: async (_id, args) => {
      const info = await regionVersionBytes(args.region, args.version);
      if ("error" in info) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: info.error }));
      }
      if (getActiveDownloads().some((d) => d.region === args.region)) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `Region "${args.region}" is already downloading.`
          })
        );
      }
      const already = listLocalRegions(regionsDir).find(
        (p) => p.region === args.region && p.version === info.version
      );
      if (already) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `Region "${args.region}" (${info.version}) is already installed.`
          })
        );
      }

      const actualMb = bytesToMb(info.totalBytes);
      // Forcing function: the agent can't start a big download without having looked up
      // (and therefore being able to state) its size. Tolerance covers MB rounding.
      const tolerance = Math.max(1, actualMb * 0.1);
      if (Math.abs(args.acknowledge_size_mb - actualMb) > tolerance) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `acknowledge_size_mb (${args.acknowledge_size_mb}) does not match the actual size. This pack is ${actualMb} MB. Tell the user the correct size, confirm, then retry with acknowledge_size_mb: ${actualMb}.`,
            actualSizeMb: actualMb
          })
        );
      }

      // Fire-and-forget: the download streams progress to the app's Offline tab and can
      // take minutes — blocking the tool call would stall the client. Failures surface
      // there (and are swallowed here to avoid an unhandled rejection).
      void downloadRegion(appStateDir, args.region, args.version).catch((err) => {
        console.error(`[mcp] region download failed for ${args.region}:`, err);
      });
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          started: true,
          region: args.region,
          version: info.version,
          sizeMb: actualMb,
          note: "Download started in the background. Progress shows in the app's Offline tab; call list_region_packs to check when it's installed."
        })
      );
    }
  });

  const cancelRegionDownloadTool = defineTool({
    name: "cancel_region_download",
    label: "Cancel region download",
    description:
      "Cancel an in-flight region-pack download. Partially downloaded files are cleaned up; nothing is installed. No-op if the region isn't downloading.",
    parameters: Type.Object({
      region: Type.String({ description: "Region slug whose download to cancel." })
    }),
    execute: async (_id, args) => {
      const wasActive = getActiveDownloads().some((d) => d.region === args.region);
      cancelRegionDownload(args.region);
      return TEXT_RESULT(JSON.stringify({ success: true, region: args.region, wasActive }));
    }
  });

  const deleteRegionPack = defineTool({
    name: "delete_region_pack",
    label: "Delete region pack",
    description:
      "Delete an installed offline region pack from disk to reclaim space. Offline geocoding/routing/tiles for that area stop working until re-downloaded. Reversible by downloading it again.",
    parameters: Type.Object({
      region: Type.String({ description: "Region slug to delete (from list_region_packs)." })
    }),
    execute: async (_id, args) => {
      const installed = listLocalRegions(regionsDir).some((p) => p.region === args.region);
      if (!installed) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: `Region "${args.region}" is not installed.` })
        );
      }
      deleteRegion(appStateDir, args.region);
      sendToRenderer("regions:changed");
      return TEXT_RESULT(JSON.stringify({ success: true, region: args.region, action: "deleted" }));
    }
  });

  // MCP behavior hints. Advisory (clients treat them as untrusted) — defense-in-depth
  // over the vault sandbox + no-clobber guards, never the primary control. Categories:
  const READ_ONLY: ToolAnnotations = {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false
  };
  // read-only but hits an external service (geocoder/router/web)
  const READ_ONLY_EXTERNAL: ToolAnnotations = {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true
  };
  // read-only real-world sensor (device GPS) — not idempotent (the fix moves)
  const SENSOR_READ: ToolAnnotations = {
    readOnlyHint: true,
    idempotentHint: false,
    openWorldHint: true
  };
  // transient map/UI effect, no data or environment change
  const MAP_EFFECT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
  // idempotent transient effect (clearing the map, moving the camera)
  const MAP_EFFECT_IDEMPOTENT: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true
  };
  // rebuilds derived index only (never the vault); the index is a rebuildable cache
  const INDEX_MAINT: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true
  };
  // creates new vault files, never overwrites
  const CREATE_ONLY: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
  // can overwrite/delete existing vault content
  const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };
  // starts a background network download of offline data (adds data, reversible)
  const REGION_DOWNLOAD: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true
  };

  const annotationsByName: Record<string, ToolAnnotations> = {
    present_features: MAP_EFFECT,
    pan_to: MAP_EFFECT_IDEMPOTENT,
    open_file: MAP_EFFECT,
    get_viewport: READ_ONLY,
    get_active_file: READ_ONLY,
    get_open_tabs: READ_ONLY,
    get_current_location: SENSOR_READ,
    query_spatial_index: READ_ONLY,
    find_near: READ_ONLY,
    query_within_polygon: READ_ONLY,
    spatial_sql: READ_ONLY,
    geo_compute: READ_ONLY,
    compute_bbox: READ_ONLY,
    read_vault_file: READ_ONLY,
    list_vault_files: READ_ONLY,
    search_vault_files: READ_ONLY,
    geocode_search: READ_ONLY_EXTERNAL,
    reverse_geocode: READ_ONLY_EXTERNAL,
    get_directions: READ_ONLY_EXTERNAL,
    present_directions: MAP_EFFECT,
    get_isochrone: READ_ONLY_EXTERNAL,
    get_matrix: READ_ONLY_EXTERNAL,
    index_file: INDEX_MAINT,
    rebuild_index: INDEX_MAINT,
    save_features_to_vault: CREATE_ONLY,
    write_vault_file: DESTRUCTIVE,
    write_frontmatter_property: DESTRUCTIVE,
    write_frontmatter_properties: DESTRUCTIVE,
    write_place_body: DESTRUCTIVE,
    delete_vault_file: DESTRUCTIVE,
    rename_vault_file: DESTRUCTIVE,
    list_region_packs: READ_ONLY_EXTERNAL,
    download_region_pack: REGION_DOWNLOAD,
    cancel_region_download: MAP_EFFECT_IDEMPOTENT,
    delete_region_pack: DESTRUCTIVE
  };

  const tools: ToolDefinition[] = [
    presentFeatures,
    querySpatialIndexTool,
    findNear,
    queryWithinPolygonTool,
    spatialSql,
    geoCompute,
    indexFile,
    rebuildIndex,
    getViewport,
    panTo,
    getActiveFile,
    getOpenTabs,
    openFile,
    getCurrentLocation,
    geocodeSearch,
    reverseGeocodeTool,
    getDirectionsTool,
    presentDirections,
    getIsochroneTool,
    getMatrixTool,
    computeBboxTool,
    readVaultFile,
    listVaultFiles,
    searchVaultFiles,
    saveFeaturesToVault,
    writeVaultFile,
    writeFrontmatterProperty,
    writeFrontmatterProperties,
    writePlaceBody,
    deleteVaultFile,
    renameVaultFile,
    listRegionPacks,
    downloadRegionPack,
    cancelRegionDownloadTool,
    deleteRegionPack
  ];

  // Attach hints. Any tool missing an entry defaults to the most cautious (destructive)
  // classification so a newly added tool is never silently treated as safe.
  for (const t of tools) {
    t.annotations = annotationsByName[t.name] ?? DESTRUCTIVE;
  }
  return tools;
}
