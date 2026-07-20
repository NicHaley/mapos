import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import type { GeocodeResult } from "@mapos/contracts";
import { MapServiceError } from "@mapos/service-adapters";
import { bbox as turfBbox } from "@turf/bbox";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { type BrowserWindow, ipcMain } from "electron";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import matter from "gray-matter";
import { type TSchema, Type } from "typebox";
import {
  detailPropertiesFromGeocodeResult,
  sanitizeAdHocProperties
} from "../shared/geocode-detail";
import { type MapOverlayLayer, type PlaceRecord, orderDetailProperties } from "../shared/types";
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
import { type GeoOperation, runGeoCompute } from "./geo-compute";
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
export type StashedGeometry = {
  kind: "route" | "isochrone" | "geometry";
  /** GeoJSON geometry (Point | LineString | Polygon | MultiPolygon | …). */
  geometry: Geometry;
  /** route only: summary facts, so saving a route derives them from the source. */
  distanceMeters?: number;
  durationSeconds?: number;
  mode?: string;
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

export function buildMaposSystemPrompt(vaultRoot: string): string {
  // Only document web search when the active services mode can actually serve it
  // (cloud). In local mode there's no provider, and the tool is omitted from the
  // tool set entirely (see buildMaposCustomTools), so don't advertise it.
  // Web search temporarily disabled until the cloud API that powers it is stood up.
  // To re-enable, restore the gate:
  //   const webSearchSection = getServiceClient().isAvailable("webSearch")
  //     ? `## Web search\n\n- \`web_search\` — search the web for current information ...\n\n`
  //     : "";
  // (and restore the webSearchAvailable check in buildMaposCustomTools).
  const webSearchSection = "";
  return `You are the AI agent powering MapOS, a map-first application where the map is the primary interface for a user's personal files, saved places, and spatial data. Your job is to help users organize, explore, and reason about their world through their files.

MapOS is a local-first Electron application. Everything runs on the user's machine. Files are the source of truth.

## Vault location (authoritative — use exactly this path)
The MapOS vault root on this machine is: ${vaultRoot}
The agent working directory (cwd) for this session is set to that folder. The environment variable MAPOS_VAULT_ROOT is also set to this path (useful in bash). For find, grep, read, bash, and any file search or listing tools, search only under this path (e.g. ${vaultRoot}${sep}**${sep}*.md for Markdown notes). Do not guess home-directory layouts — always use the absolute path above.

## Place files and frontmatter

Place files use Markdown with YAML frontmatter. Required frontmatter: \`geometry\` (WKT string). \`geometry\`, \`color\`, and \`cover\` have special meaning to the map renderer — do not reuse those key names for other purposes. \`cover\` is a vault-relative path to an image file (e.g. \`cover: attachments/tower.jpg\`) shown as the place's hero photo; the body can also embed vault images with standard Markdown (\`![](attachments/tower.jpg)\`).

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

## Map services (search, routing, reachability)

For external spatial queries, use these tools — they are backed by OpenStreetMap data (Photon + Valhalla):

- \`geocode_search\` — forward geocode a query ("kinka izakaya toronto", "shinjuku station") to one or more points.
- \`reverse_geocode\` — given a lat/lng, return the nearest named feature(s).
- \`get_directions\` — road/walk/bike route between two or more locations. Returns summary distance/duration, a \`route_id\` (opaque handle to the server-side route geometry), \`pointCount\`, and turn-by-turn maneuvers. The route shape never crosses the LLM boundary; to render, pass the \`route_id\` to a \`render_overlay_on_map\` lines entry; to save it as a vault file, pass it to \`save_features_to_vault\` with a title. Do not try to retrieve, decode, or downsample route geometry yourself.
- \`get_isochrone\` — reachable-area polygon(s) from a location for one or more time contours (in minutes). Each contour comes back as an \`isochrone_id\` (opaque handle) plus pointCount/bbox — the polygon shape never crosses the LLM boundary. Pass the id to render (\`polygons\` entry), \`geo_compute\`, or \`save_features_to_vault\`; never re-emit its coordinates. To find things INSIDE the isochrone: the user's own saved places → \`query_within_polygon\` (\`region_id\`); external POIs like gas stations or cafes → \`geocode_search\` with \`within_id\` (a plain \`bbox\` is only a rectangular bias and leaks in POIs outside the shape).
- \`get_matrix\` — pairwise travel distance/time between sources and targets. Keep N small (≤ 10 each side) — cost grows with the product of both sides.
- \`compute_bbox\` — bounding box for a set of lat/lng points; useful for framing a viewport around results.

To search the user's own indexed places spatially (\`query_spatial_index\` takes an optional \`bounds\` — omit it to scan the whole vault, or pass a rectangle; it can't take a non-rectangular area):

- \`find_near\` — places nearest a point, sorted nearest-first with \`distance_m\` (geodesic meters). Pass \`radius_m\` to cap to a circle ("cafes within 500 m"), or omit it for the K nearest overall. Combine with \`filters\` (tags/category/folder) for "nearest ramen".
- \`query_within_polygon\` — the user's places that fall inside a polygon region (a drawn area, or an isochrone from \`get_isochrone\`). Pass the region by handle as \`region_id\` (an isochrone_id or a geo_compute geometry_id) whenever you have one; only pass \`coordinates\` (rings as \`[[[lng, lat], ...]]\`) for a hand-built polygon.

Both return the same records as \`query_spatial_index\` (file paths to feed \`present_features\`).

To find one of the user's places BY NAME (e.g. "Home", "the office"), a place's name is its **file basename**, not a \`name\` frontmatter property — many place files have only \`geometry\`. So look it up with \`spatial_sql\` \`SELECT file_path, geometry FROM features WHERE file_path LIKE '%home%'\` (this is exactly how the app's own search matches). Don't scan for a \`name\` property or shell out to \`find\` first.

For analytical questions about indexed files that \`query_spatial_index\` can't express — counts, \`GROUP BY\`, faceting, sorting, joins — use:

- \`spatial_sql\` — run a single read-only SELECT against the local spatial index. Tables: \`features(file_path, geometry_type, geometry, color, indexed_at)\`; \`feature_properties(feature_id, key, value, type)\` where \`feature_id\` = \`features.file_path\` and every value is TEXT (use \`CAST(value AS REAL)\` for numbers); \`features_rtree(id, min_lat, max_lat, min_lng, max_lng)\` where \`id\` = \`features.rowid\`. \`geometry\` is a GeoJSON string and there are no ST_* functions — don't select it unless you need raw coordinates. List explicit columns, never \`SELECT *\`. To show places on the map, use \`query_spatial_index\`, not this.

To COMPUTE geometry (as opposed to selecting places), use:

- \`geo_compute\` — one offline geometry operation: \`buffer\` (radius_m), \`area\`, \`length\`, \`centroid\`, \`bbox\`, \`convex_hull\`, \`simplify\`, \`union\`, \`intersect\`, \`clusters_dbscan\` (max_distance_m). Input is a handle (\`geometry_id\`/\`geometry_b_id\`, e.g. an isochrone_id), \`feature_paths\` resolved from the index, or inline GeoJSON (\`geometry\`/\`geometry_b\`) for hand-built input — prefer handles/paths so geometry doesn't re-cross the boundary. Geometry-producing ops return a new \`geometry_id\` (measurement ops return values inline); pass that id to \`render_overlay_on_map\`, \`query_within_polygon\`, or \`save_features_to_vault\`. E.g. "what's within a 10-min walk of both spots" → two \`get_isochrone\` calls → \`geo_compute\` intersect on their two isochrone_ids → \`query_within_polygon\` with the resulting geometry_id.

After calling any of these, display the results:
- points from \`geocode_search\` / \`reverse_geocode\` the user will browse or pick from → \`present_features\` (draws the markers AND renders a clickable list, kept in sync). See "Showing places and features in chat" below.
- a route from \`get_directions\` → \`render_overlay_on_map\` with a \`lines\` entry \`{ route_id }\`. The server resolves the id back to the geometry. Do NOT pass coordinates or polyline strings yourself for these routes — they cost tens of thousands of tokens and take minutes to generate.
- each contour's \`isochrone_id\` from \`get_isochrone\` → a \`render_overlay_on_map\` \`polygons\` entry as \`{ isochrone_id }\` (or \`{ geometry_id }\` for a geo_compute result). Never pass polygon coordinates yourself.

Result sets accumulate on the map across the conversation — each \`present_features\` / \`render_overlay_on_map\` call adds its own layer rather than replacing the last. Don't clear between searches. Only call \`clear_map_overlay\` when the user explicitly asks to clear the map.

After showing results on the map, do not explain how to interact with the UI (e.g. do not say to click markers, to say "save", or to use Add all — those affordances are visible in the app). Give a short substantive answer only: what you found, names, or next steps that are not redundant with the map.

${webSearchSection}## File operations

For any vault file write or delete, use write_vault_file or delete_vault_file — never the raw bash redirect or other file tools. These tracked tools handle undo snapshots and spatial index updates automatically. After writing a place file, do NOT call index_file separately — write_vault_file handles indexing. When only the file path is changing (rename or move), use rename_vault_file instead of write+delete.

To SAVE places or routes to the vault — the user says save/add/keep after a search, or asks you to build a folder or collection of places — use \`save_features_to_vault\`, NOT hand-written write_vault_file content. It writes the exact same file format as the app's own save button: \`geometry\` WKT frontmatter, canonical properties from the geocoder source (category, address, osm_id, wikidata_id), and the place's cover photo. Reference looked-up places by \`result_id\`, exactly as with present_features; save a route from get_directions by its \`route_id\` plus a title (the app expands it to the LINESTRING geometry and fills in distance/duration/mode); pass genuinely ad-hoc points as title + lat/lng. Reserve write_vault_file for non-place notes, edits to existing files, and other non-point geometry you authored yourself.

## Display vs. action intent

- If the user asks you to find, show, search, explore, or preview → display results ephemerally without writing files. Use present_features for a browsable list of places; use render_overlay_on_map for routes, areas, and bulk geometry.
- If the user asks you to save, create, add, update, mark, or organize → write actual vault files: save_features_to_vault for new places and routes, write_vault_file for everything else.

## Showing places and features in chat

When you present a set of located places the user might browse or pick from — search results, recommendations, saved places matching a query — call \`present_features\`. It draws the markers on the map AND renders a clickable list in the chat from the same data, so the list and the map never drift apart. This is the primary way to present places.

The list \`present_features\` renders IS the user's view of the results — every feature's title is shown and is clickable. So once you've called it, do NOT re-list the places in your reply in ANY form: no numbered or bulleted list, no one-place-per-line rundown, no emoji-prefixed lines, no table. That just duplicates what's already on screen and the duplicate isn't connected to the map. Keep your reply to a brief synthesis — one or two sentences — and call out at most one or two standouts by name if it helps.

\`present_features\` takes an ordered \`features\` array (order is preserved). Each entry is ONE of:
- a geocode/POI result you just looked up — set \`result_id\` to that result's \`id\`. This is STRONGLY PREFERRED: the app fills in the marker, title, and structured properties (category, address, …) from the cached result, so the card is identical to the search UI and you never have to (and must not) re-type or reformat its facts. Add only an optional \`preview_markdown\` note.
- a saved vault place — set \`path\` to its vault file path (from \`query_spatial_index\`). Its marker already exists on the map.
- a genuinely ad-hoc place you could NOT look up — set \`lat\`, \`lng\`, \`title\`, optional \`properties\`, optional \`preview_markdown\`.

Do not transcribe a geocoder result's name/category/address into the call — reference it by \`result_id\` and let the app derive them; transcribing causes drift (e.g. "fast_food" becoming "fast food"). For ad-hoc places, put structured facts in \`properties\` using canonical keys (\`category\` as a lowercase token, \`address\`, \`source_url\`, plus extra keys like \`cuisine\`), and reserve \`preview_markdown\` for free prose (why it's relevant, a recommendation). Never provide \`osm_id\`/\`wikidata_id\` yourself — you have no reliable source and they're dropped. Never write a per-row note as a prose list in your reply.

You can mix kinds in one call; the list interleaves them in the order given.

Example — the user asks for taco places near home. Call \`geocode_search\`, then ONE call referencing the results by id:
\`present_features({ features: [ { result_id: "offline:quebec:1023", preview_markdown: "Great al pastor, very close to home." }, { result_id: "offline:quebec:4471" }, ... ] })\`
Then a reply like: "Seven taco spots near your home — Mont Tacos and Maison du Tacos on Saint-Denis are the closest." No list of the seven; the card already shows them.

Use \`render_overlay_on_map\` instead when the result is NOT a browsable list:
- routes (lines), isochrones/areas (polygons), or other pure geometry
- a large dataset or layer the user views in aggregate rather than picking from row by row (e.g. "map every cafe in the city", an imported file)

When unsure: a couple dozen places the user might click → \`present_features\`; geometry or bulk layers → \`render_overlay_on_map\`.

(A \`<features refs="vault:<path>"/>\` tag is also still supported for referencing a single saved place inline within a sentence. Prefer \`present_features\` for any actual list.)`;
}

export function buildMaposCustomTools(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  maposDir: string,
  onVaultWrite: (op: VaultOperation) => void,
  onLayerUpdate: (layer: MapOverlayLayer) => void,
  onLayersClear: () => void,
  hasLayers: () => boolean,
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
      distance_m?: number;
    }>,
    limit: number
  ) => {
    const truncated = rows.length > limit;
    const features = rows.slice(0, limit).map((r) => ({
      file_path: r.file_path,
      geometry_type: r.geometry_type,
      ...(r.color != null ? { color: r.color } : {}),
      ...(r.distance_m != null ? { distance_m: r.distance_m } : {})
    }));
    return { features, count: features.length, truncated };
  };

  // Confine a caller-supplied path to the vault. resolveInVault canonicalizes
  // and rejects `..`/absolute/symlink escapes — a raw startsWith check does not.
  const isUnderVault = (p: string) => resolveInVault(maposDir, p) !== null;
  // Writes additionally may not touch the protected `.mapos/` config + index subtree.
  const isWritableVaultPath = (p: string) => isUnderVault(p) && !isProtectedVaultPath(maposDir, p);

  // Shared attribute-filter shape for the spatial query tools (query_spatial_index,
  // find_near, query_within_polygon). Mirrors db.ts `SpatialFilters`.
  const spatialFilters = Type.Object({
    folderPath: Type.Optional(Type.String()),
    properties: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String())))
  });

  const renderOverlayOnMap = defineTool({
    name: "render_overlay_on_map",
    label: "Render map overlay",
    description:
      "Display lines, polygons, or bulk points on the map as a temporary overlay without saving. Use for routes, isochrones/areas, and large datasets/layers the user views in aggregate. For a browsable list of places the user will pick from, use present_features instead (it renders a clickable, map-connected list). Lines: routes, boundaries. Polygons: isochrones, areas. Pass geometry by handle, never by coordinates: a route from get_directions → `route_id` on a `lines` entry; an isochrone or computed polygon → `isochrone_id`/`geometry_id` on a `polygons` entry. Re-emitting coordinates yourself costs tens of thousands of output tokens and takes minutes.",
    parameters: Type.Object({
      points: Type.Optional(
        Type.Array(
          Type.Object({
            lat: Type.Number({ description: "Latitude in decimal degrees" }),
            lng: Type.Number({ description: "Longitude in decimal degrees" }),
            title: Type.String({ description: "Display name for the marker" }),
            id: Type.Optional(Type.String({ description: "Unique identifier for the point" })),
            preview_markdown: Type.Optional(
              Type.String({
                description: "Optional markdown shown in the place preview card before save"
              })
            )
          })
        )
      ),
      lines: Type.Optional(
        Type.Array(
          Type.Object({
            route_id: Type.Optional(
              Type.String({
                description:
                  "Opaque id returned by get_directions. Preferred for routes — server resolves to the full geometry without re-transmitting it through the LLM."
              })
            ),
            coordinates: Type.Optional(
              Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), {
                description:
                  "Array of [longitude, latitude] pairs. Use only for short, hand-built lines."
              })
            ),
            title: Type.Optional(Type.String()),
            id: Type.Optional(Type.String()),
            preview_markdown: Type.Optional(
              Type.String({
                description: "Optional markdown shown in the place preview card before save"
              })
            )
          })
        )
      ),
      polygons: Type.Optional(
        Type.Array(
          Type.Object({
            geometry_id: Type.Optional(
              Type.String({
                description:
                  "Opaque id of a stashed polygon (a geometry_id from geo_compute, or an isochrone_id from get_isochrone — either key works here). Preferred — the server resolves it to the full polygon without re-transmitting coordinates through the LLM. A MultiPolygon is expanded to several polygon shapes automatically."
              })
            ),
            isochrone_id: Type.Optional(
              Type.String({ description: "Alias for geometry_id when the handle is an isochrone." })
            ),
            coordinates: Type.Optional(
              Type.Array(Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })), {
                description:
                  "Array of rings; each ring is [[lng, lat], ...]. First ring is outer boundary (must close). Use only for short, hand-built polygons — for isochrones or computed geometry, pass geometry_id."
              })
            ),
            title: Type.Optional(Type.String()),
            id: Type.Optional(Type.String()),
            preview_markdown: Type.Optional(
              Type.String({
                description: "Optional markdown shown in the place preview card before save"
              })
            )
          })
        )
      ),
      layer_name: Type.Optional(
        Type.String({
          default: "search-results",
          description: "Name for this overlay layer"
        })
      )
    }),
    execute: async (toolCallId, args) => {
      if (!mainWindow.isDestroyed()) {
        // Namespace every marker id with the layer id so ids stay unique once
        // layers accumulate on the map (two calls would otherwise both emit
        // `overlay-point-0`).
        const layerId = toolCallId;
        const points = (args.points ?? []).map((p, i) => ({
          id: `${layerId}:${p.id ?? `point-${i}`}`,
          lat: p.lat,
          lng: p.lng,
          title: p.title,
          ...(p.preview_markdown != null ? { preview_markdown: p.preview_markdown } : {})
        }));
        const lines = (args.lines ?? []).map((l, i) => {
          let coordinates: [number, number][];
          if (l.route_id) {
            const geom = resolveGeometryId(l.route_id).geometry;
            if (geom.type !== "LineString") {
              throw new Error(
                `Geometry id "${l.route_id}" is a ${geom.type}, not a line. Pass a route_id from get_directions to a lines entry.`
              );
            }
            coordinates = geom.coordinates as [number, number][];
          } else if (l.coordinates && l.coordinates.length > 0) {
            coordinates = l.coordinates as [number, number][];
          } else {
            // Neither a route_id nor inline coordinates — a malformed entry that would
            // otherwise render an invisible empty line and falsely report success.
            throw new Error("A lines entry needs route_id (preferred) or non-empty coordinates.");
          }
          return {
            id: `${layerId}:${l.id ?? `line-${i}`}`,
            coordinates,
            title: l.title,
            ...(l.preview_markdown != null ? { preview_markdown: l.preview_markdown } : {})
          };
        });
        const closeRing = (ring: [number, number][]): [number, number][] => {
          if (ring.length < 2) return ring;
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (!first || !last) return ring;
          const isClosed = first[0] === last[0] && first[1] === last[1];
          return isClosed ? ring : [...ring, first];
        };
        // A polygon entry may resolve to several shapes (a MultiPolygon), so build the
        // list imperatively rather than 1:1.
        const polygons: MapOverlayLayer["polygons"] = [];
        (args.polygons ?? []).forEach((p, i) => {
          const handle = p.geometry_id ?? p.isochrone_id;
          let ringSets: [number, number][][][];
          if (handle) {
            const geom = resolveGeometryId(handle).geometry;
            if (geom.type === "Polygon") {
              ringSets = [geom.coordinates as [number, number][][]];
            } else if (geom.type === "MultiPolygon") {
              ringSets = geom.coordinates as [number, number][][][];
            } else {
              throw new Error(
                `Geometry id "${handle}" is a ${geom.type}, not a polygon. Pass an isochrone_id or a polygon geometry_id to a polygons entry.`
              );
            }
          } else if (p.coordinates && p.coordinates.length > 0) {
            ringSets = [p.coordinates as [number, number][][]];
          } else {
            // Neither a handle nor inline rings — a malformed entry that would otherwise
            // render an invisible empty polygon and falsely report success.
            throw new Error(
              "A polygons entry needs geometry_id/isochrone_id (preferred) or non-empty coordinates."
            );
          }
          ringSets.forEach((rings, j) => {
            const base = p.id ?? `polygon-${i}`;
            polygons.push({
              id: `${layerId}:${base}${ringSets.length > 1 ? `-${j}` : ""}`,
              coordinates: rings.map(closeRing),
              title: p.title,
              ...(p.preview_markdown != null ? { preview_markdown: p.preview_markdown } : {})
            });
          });
        });
        const layer: MapOverlayLayer = {
          id: layerId,
          layerName: args.layer_name ?? "search-results",
          points,
          lines,
          polygons
        };
        mainWindow.webContents.send("map:overlay-add", layer);
        onLayerUpdate(layer);
      }
      const counts = {
        points: (args.points ?? []).length,
        lines: (args.lines ?? []).length,
        polygons: (args.polygons ?? []).length
      };
      const parts = [
        counts.points && `${counts.points} points`,
        counts.lines && `${counts.lines} lines`,
        counts.polygons && `${counts.polygons} polygons`
      ].filter(Boolean);
      return TEXT_RESULT(`Displayed ${parts.join(", ")} on map`);
    }
  });

  const presentFeatures = defineTool({
    name: "present_features",
    label: "Present features",
    description:
      "Show the user a browsable list of places/features: draws their markers on the map AND renders a clickable, map-connected list in the chat, kept in sync. Use this — NOT a Markdown list or table — whenever you present located places the user might pick from (search results, recommendations, saved places matching a query). Each feature is ONE of: a geocode/POI result you just looked up (set `result_id` — STRONGLY PREFERRED, the app fills in its name/category/address from the source), a saved vault place (set `path`), or a genuinely ad-hoc place you couldn't look up (set `lat`, `lng`, `title`). Order is preserved. For routes, isochrones/areas, or a large dataset viewed in aggregate, use render_overlay_on_map instead.",
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
          )
        }),
        {
          minItems: 1,
          description: "Ordered features to show; order is preserved in the rendered list."
        }
      ),
      layer_name: Type.Optional(
        Type.String({ default: "search-results", description: "Name for the overlay layer" })
      )
    }),
    execute: async (toolCallId, args) => {
      const layerId = toolCallId;
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
      if ((points.length > 0 || vaultPaths.length > 0) && !mainWindow.isDestroyed()) {
        const layer: MapOverlayLayer = {
          id: layerId,
          layerName: args.layer_name ?? "search-results",
          points,
          lines: [],
          polygons: [],
          ...(vaultPaths.length > 0 ? { vaultPaths } : {})
        };
        mainWindow.webContents.send("map:overlay-add", layer);
        onLayerUpdate(layer);
      }

      return TEXT_RESULT(
        JSON.stringify({
          kind: "feature_list",
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

  const clearMapOverlay = defineTool({
    name: "clear_map_overlay",
    label: "Clear map overlay",
    description:
      "Remove ALL temporary overlay layers from the map (every result set shown this conversation). Call only when the user explicitly asks to clear the map. Result sets otherwise stay on the map and accumulate, so you rarely need this.",
    parameters: Type.Object({}),
    execute: async () => {
      if (hasLayers()) {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send("map:overlay-clear");
        }
        onLayersClear();
      }
      return TEXT_RESULT("Cleared all overlay layers");
    }
  });

  const querySpatialIndexTool = defineTool({
    name: "query_spatial_index",
    label: "Query spatial index",
    description:
      "Query the spatial index for features, optionally within a bounding box. Returns saved places, notes, and any indexed files (file_path, geometry_type, color — pass file_path to present_features, which re-resolves the geometry itself). `bounds` is optional: omit it to search the whole vault (e.g. when filtering by folder or property rather than location), or pass it to restrict to a rectangle. Use filters.properties to filter by any frontmatter multi-select or text field — e.g. { tags: ['ramen'], cuisine: ['japanese'] } requires the place to have ALL listed values under each key. To find a place by name, don't scan here — use spatial_sql with `file_path LIKE '%name%'` (the file basename is the place's name).",
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
      "color). A place is included if any part of it intersects the region. Use this instead of " +
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
      "- features(rowid, file_path UNIQUE, geometry_type, geometry, color, indexed_at). " +
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
      "straight to render_overlay_on_map, query_within_polygon, or save_features_to_vault. Measurement " +
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
      if (!isUnderVault(args.path)) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, reason: `Path must be under vault (${maposDir})` })
        );
      }
      const record = await parsePlaceFile(args.path);
      syncFeatureForFile(args.path, record);
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
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("map:pan-to", {
          lat: args.lat,
          lng: args.lng,
          zoom: args.zoom
        });
      }
      return TEXT_RESULT(`Map panning to ${args.lat}, ${args.lng}`);
    }
  });

  const geocodeSearch = defineTool({
    name: "geocode_search",
    label: "Geocode search",
    description:
      "Forward geocode a free-text query (place name, address, or category words like 'restaurants') via Photon/OpenStreetMap or offline region packs. Returns up to `limit` points, each with a stable `id`. Good for turning 'kinka izakaya toronto' into lat/lng, or for offline POI search — pass `categories` (with or without `query`) to filter, e.g. all cafes in the viewport bbox. For \"POIs within an isochrone/area\", pass `within_id` (an isochrone_id or a geo_compute polygon geometry_id): results are kept only if they fall INSIDE that polygon — a plain `bbox` is just a rectangular ranking bias and lets in POIs outside the shape. To show any of these results to the user, pass its `id` to present_features as `result_id` — do NOT re-type its name, category, or address; the app fills those from the result.",
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
      "Reverse geocode a point (lat/lng) via Photon/OpenStreetMap or offline region packs. Returns nearby named feature(s), each with a stable `id`. Pass `categories` to ask 'what restaurants/cafes are near here' (offline packs only). To show a result, pass its `id` to present_features as `result_id` — do NOT re-type its name, category, or address.",
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
      "Compute a route between two or more locations via Valhalla. Returns: distanceMeters, durationSeconds, a `route_id` (opaque handle), pointCount, and turn-by-turn `maneuvers`. Use 'pedestrian' for walking, 'bicycle' for cycling, 'auto' for driving. The route shape is stored server-side; to render it, pass the `route_id` to a `render_overlay_on_map` lines entry; to save it as a vault file, pass it to `save_features_to_vault` with a title. Do NOT attempt to retrieve, decode, downsample, or re-emit the route geometry yourself — there is no need.",
    parameters: Type.Object({
      locations: Type.Array(Type.Object({ lat: Type.Number(), lng: Type.Number() }), {
        minItems: 2,
        description: "Ordered list of waypoints; must have at least two"
      }),
      costing: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")], {
          default: "pedestrian"
        })
      )
    }),
    execute: async (_id, args) => {
      try {
        const route = await getServiceClient().routing.directions({
          locations: args.locations,
          costing: args.costing ?? "pedestrian"
        });
        const route_id = stashRoute({
          geometry: route.geometry,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          mode: args.costing ?? "pedestrian"
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
            : {})
        };
        return TEXT_RESULT(JSON.stringify(visible));
      } catch (err) {
        return TEXT_RESULT(errorPayload(err));
      }
    }
  });

  const getIsochroneTool = defineTool({
    name: "get_isochrone",
    label: "Get isochrone",
    description:
      "Compute reachable-area polygon(s) from a location for one or more time contours (in minutes). Returns contours sorted ascending by minutes; each has an `isochrone_id` (opaque handle to the polygon, kept off the LLM boundary) plus pointCount and bbox. To render a contour, pass its `isochrone_id` to a render_overlay_on_map `polygons` entry; to find places inside it, pass it as `query_within_polygon`'s `region_id`; to intersect two isochrones, pass their ids to geo_compute. Do not try to retrieve or re-emit the polygon coordinates yourself.",
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

  const webSearchTool = defineTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web for current information, news, or external facts not in the vault. Returns results with title, url, and a snippet. Use for questions the user's files can't answer (opening hours, recent events, articles). Only available when MapOS is configured against a server — surfaces an error otherwise.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, default: 5, description: "Max results to return" })
      ),
      recency: Type.Optional(
        Type.Union(
          [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
          { description: "Restrict results to a recency window relative to now" }
        )
      )
    }),
    execute: async (_id, args) => {
      try {
        const response = await getServiceClient().webSearch.search({
          query: args.query,
          maxResults: args.maxResults ?? 5,
          recency: args.recency
        });
        return TEXT_RESULT(JSON.stringify(response));
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
      if (!isWritableVaultPath(args.path)) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `Path must be within the vault and outside .mapos/ (${maposDir})`
          })
        );
      }
      const exists = existsSync(args.path);
      if (exists && args.overwrite !== true) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error:
              "File already exists. Pass overwrite: true to replace its entire contents, or use a targeted edit instead of a full rewrite."
          })
        );
      }
      const previousContent = exists ? readFileSync(args.path, "utf-8") : null;
      onVaultWrite({ path: args.path, previousContent });
      mkdirSync(dirname(args.path), { recursive: true });
      writeFileSync(args.path, args.content, "utf-8");
      try {
        const record = await parsePlaceFile(args.path);
        syncFeatureForFile(args.path, record);
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
          path: args.path,
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
      "Save one or more places to the vault as place files, in the exact same format as the app's own save affordance: `geometry` WKT frontmatter, structured properties derived from the geocoder source (category, address, osm_id, wikidata_id), and the place's Wikimedia cover photo when one exists. STRONGLY PREFERRED over write_vault_file for saving places and routes. Each feature is ONE of: a geocode/POI result you looked up (set `result_id` — the app derives the filename, geometry, and properties from the cached result, so never re-type its facts), a route from get_directions (set `route_id` plus a `title` — the app expands the id to the full LINESTRING geometry and fills in distance/duration/mode), a stashed geometry like an isochrone or a geo_compute result (set `geometry_id` plus a `title` — the app expands the id to the polygon/line geometry), or a genuinely ad-hoc point you could not look up (set `title`, `lat`, `lng`). Filenames are derived from titles automatically.",
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
                'The `route_id` returned by get_directions. Saves the route as a LINESTRING place file; the app resolves the geometry and fills in distance/duration/mode — never re-emit coordinates yourself. Requires `title` (e.g. "Home to Café Olimpico"); leave lat/lng unset.'
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
      const folder = args.folder ?? maposDir;
      if (!isWritableVaultPath(folder)) {
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
      };
      const resolved: ResolvedFeature[] = [];
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
              body: f.body_markdown
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
          resolved.push({
            title: f.title,
            geometry: wkt,
            properties: orderDetailProperties({
              ...sanitizeAdHocProperties(f.properties),
              category: "route",
              ...(stored.mode != null ? { mode: stored.mode } : {}),
              ...(stored.distanceMeters != null
                ? { distance_m: String(Math.round(stored.distanceMeters)) }
                : {}),
              ...(stored.durationSeconds != null
                ? { duration_s: String(Math.round(stored.durationSeconds)) }
                : {})
            }),
            body: f.body_markdown
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

      if (resolved.length > 0) mkdirSync(folder, { recursive: true });

      // Prefetch covers concurrently; best-effort (offline or imageless QIDs skip).
      const covers = await Promise.all(
        resolved.map((r) => (r.wikidataId ? downloadWikidataImage(r.wikidataId) : null))
      );

      const saved: Array<{ path: string; title: string }> = [];
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
        const content = matter.stringify(body ? `\n${body}\n` : "", data);
        onVaultWrite({ path, previousContent: null });
        writeFileSync(path, content, "utf-8");
        try {
          const record = await parsePlaceFile(path);
          syncFeatureForFile(path, record);
        } catch {
          // Indexing failure is non-fatal; the watcher will pick the file up
        }
        saved.push({ path, title: r.title });
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

  const deleteVaultFile = defineTool({
    name: "delete_vault_file",
    label: "Delete vault file",
    description:
      "Delete a vault file. Use this instead of bash rm. Handles undo tracking and spatial index cleanup automatically.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path within the MapOS vault to delete" })
    }),
    execute: async (_id, args) => {
      if (!isWritableVaultPath(args.path)) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: `Path must be within the vault and outside .mapos/ (${maposDir})`
          })
        );
      }
      if (!existsSync(args.path)) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "File not found" }));
      }
      const previousContent = readFileSync(args.path, "utf-8");
      onVaultWrite({ path: args.path, previousContent });
      removeFeatures([args.path]);
      removeFeaturePropertiesForFile(args.path);
      rmSync(args.path);
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          path: args.path,
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
      if (!isWritableVaultPath(args.fromPath) || !isWritableVaultPath(args.toPath)) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: "Both paths must be within the vault and outside .mapos/"
          })
        );
      }
      if (!existsSync(args.fromPath)) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "Source file not found" }));
      }
      if (existsSync(args.toPath) && args.overwrite !== true) {
        return TEXT_RESULT(
          JSON.stringify({
            success: false,
            error: "A file already exists at toPath. Pass overwrite: true to replace it."
          })
        );
      }
      const content = readFileSync(args.fromPath, "utf-8");
      onVaultWrite({ path: args.fromPath, previousContent: content });
      onVaultWrite({
        path: args.toPath,
        previousContent: existsSync(args.toPath) ? readFileSync(args.toPath, "utf-8") : null
      });
      mkdirSync(dirname(args.toPath), { recursive: true });
      renameSync(args.fromPath, args.toPath);
      removeFeatures([args.fromPath]);
      removeFeaturePropertiesForFile(args.fromPath);
      try {
        const record = await parsePlaceFile(args.toPath);
        syncFeatureForFile(args.toPath, record);
      } catch {
        // Not a place file
      }
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          path: args.toPath,
          fromPath: args.fromPath,
          action: "renamed",
          previousContent: content,
          newContent: content
        })
      );
    }
  });

  // Web search is server-only — only expose the tool when the active services mode
  // can actually serve it (the cloud MapOS server). Omitting it
  // (rather than letting it error) keeps the agent from offering web search it
  // can't deliver. The services mode is stable per process, so build-time gating
  // is sufficient.
  // Temporarily disabled until the cloud API that powers web search is stood up.
  // Restore `getServiceClient().isAvailable("webSearch")` to re-enable.
  const webSearchAvailable = false;

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

  const annotationsByName: Record<string, ToolAnnotations> = {
    present_features: MAP_EFFECT,
    render_overlay_on_map: MAP_EFFECT,
    clear_map_overlay: MAP_EFFECT_IDEMPOTENT,
    pan_to: MAP_EFFECT_IDEMPOTENT,
    get_viewport: READ_ONLY,
    query_spatial_index: READ_ONLY,
    find_near: READ_ONLY,
    query_within_polygon: READ_ONLY,
    spatial_sql: READ_ONLY,
    geo_compute: READ_ONLY,
    compute_bbox: READ_ONLY,
    geocode_search: READ_ONLY_EXTERNAL,
    reverse_geocode: READ_ONLY_EXTERNAL,
    get_directions: READ_ONLY_EXTERNAL,
    get_isochrone: READ_ONLY_EXTERNAL,
    get_matrix: READ_ONLY_EXTERNAL,
    web_search: { readOnlyHint: true, openWorldHint: true },
    index_file: INDEX_MAINT,
    rebuild_index: INDEX_MAINT,
    save_features_to_vault: CREATE_ONLY,
    write_vault_file: DESTRUCTIVE,
    delete_vault_file: DESTRUCTIVE,
    rename_vault_file: DESTRUCTIVE
  };

  const tools: ToolDefinition[] = [
    presentFeatures,
    renderOverlayOnMap,
    clearMapOverlay,
    querySpatialIndexTool,
    findNear,
    queryWithinPolygonTool,
    spatialSql,
    geoCompute,
    indexFile,
    rebuildIndex,
    getViewport,
    panTo,
    geocodeSearch,
    reverseGeocodeTool,
    getDirectionsTool,
    getIsochroneTool,
    getMatrixTool,
    ...(webSearchAvailable ? [webSearchTool] : []),
    computeBboxTool,
    saveFeaturesToVault,
    writeVaultFile,
    deleteVaultFile,
    renameVaultFile
  ];

  // Attach hints. Any tool missing an entry defaults to the most cautious (destructive)
  // classification so a newly added tool is never silently treated as safe.
  for (const t of tools) {
    t.annotations = annotationsByName[t.name] ?? DESTRUCTIVE;
  }
  return tools;
}
