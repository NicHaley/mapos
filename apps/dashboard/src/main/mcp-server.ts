import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type BrowserWindow, ipcMain } from "electron";
import { Type } from "typebox";
import type { GeocodeResult } from "@mapos/contracts";
import { MapServiceError } from "@mapos/service-adapters";
import { computeBbox } from "./bbox";
import { getServiceClient } from "./services/client";
import type { MapOverlayLayer, PlaceRecord, VaultOperation } from "../shared/types";
import {
  detailPropertiesFromGeocodeResult,
  sanitizeAdHocProperties
} from "../shared/geocode-detail";
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
import { parsePlaceFile } from "./watcher";

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

Place files use Markdown with YAML frontmatter. Required frontmatter: \`geometry\` (WKT string). \`geometry\` and \`color\` have special meaning to the map renderer — do not reuse those key names for other purposes.

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
- \`get_directions\` — road/walk/bike route between two or more locations. Returns summary distance/duration, a \`route_id\` (opaque handle to the server-side route geometry), \`pointCount\`, and turn-by-turn maneuvers. The route shape never crosses the LLM boundary; to render, pass the \`route_id\` to a \`render_overlay_on_map\` lines entry. Do not try to retrieve, decode, or downsample route geometry yourself.
- \`get_isochrone\` — reachable-area polygon(s) from a location for one or more time contours (in minutes).
- \`get_matrix\` — pairwise travel distance/time between sources and targets. Keep N small (≤ 10 each side) — cost grows with the product of both sides.
- \`compute_bbox\` — bounding box for a set of lat/lng points; useful for framing a viewport around results.

To search the user's own indexed places spatially (\`query_spatial_index\` only takes a rectangle):

- \`find_near\` — places nearest a point, sorted nearest-first with \`distance_m\` (geodesic meters). Pass \`radius_m\` to cap to a circle ("cafes within 500 m"), or omit it for the K nearest overall. Combine with \`filters\` (tags/category/folder) for "nearest ramen".
- \`query_within_polygon\` — the user's places that fall inside a polygon region (a drawn area, or an isochrone from \`get_isochrone\`). Pass rings as \`[[[lng, lat], ...]]\`.

Both return the same records as \`query_spatial_index\` (file paths to feed \`present_features\`).

For analytical questions about indexed files that \`query_spatial_index\` can't express — counts, \`GROUP BY\`, faceting, sorting, joins — use:

- \`spatial_sql\` — run a single read-only SELECT against the local spatial index. Tables: \`features(file_path, geometry_type, geometry, color, indexed_at)\`; \`feature_properties(feature_id, key, value, type)\` where \`feature_id\` = \`features.file_path\` and every value is TEXT (use \`CAST(value AS REAL)\` for numbers); \`features_rtree(id, min_lat, max_lat, min_lng, max_lng)\` where \`id\` = \`features.rowid\`. \`geometry\` is a GeoJSON string and there are no ST_* functions — don't select it unless you need raw coordinates. List explicit columns, never \`SELECT *\`. To show places on the map, use \`query_spatial_index\`, not this.

After calling any of these, display the results:
- points from \`geocode_search\` / \`reverse_geocode\` the user will browse or pick from → \`present_features\` (draws the markers AND renders a clickable list, kept in sync). See "Showing places and features in chat" below.
- a route from \`get_directions\` → \`render_overlay_on_map\` with a \`lines\` entry \`{ route_id }\`. The server resolves the id back to the geometry. Do NOT pass coordinates or polyline strings yourself for these routes — they cost tens of thousands of tokens and take minutes to generate.
- each \`contours[].polygon.coordinates\` from \`get_isochrone\` → a \`render_overlay_on_map\` \`polygons\` entry

Result sets accumulate on the map across the conversation — each \`present_features\` / \`render_overlay_on_map\` call adds its own layer rather than replacing the last. Don't clear between searches. Only call \`clear_map_overlay\` when the user explicitly asks to clear the map.

After showing results on the map, do not explain how to interact with the UI (e.g. do not say to click markers, to say "save", or to use Add all — those affordances are visible in the app). Give a short substantive answer only: what you found, names, or next steps that are not redundant with the map.

${webSearchSection}## File operations

For any vault file write or delete, use write_vault_file or delete_vault_file — never the raw bash redirect or other file tools. These tracked tools handle undo snapshots and spatial index updates automatically. After writing a place file, do NOT call index_file separately — write_vault_file handles indexing. When only the file path is changing (rename or move), use rename_vault_file instead of write+delete.

## Display vs. action intent

- If the user asks you to find, show, search, explore, or preview → display results ephemerally without writing files. Use present_features for a browsable list of places; use render_overlay_on_map for routes, areas, and bulk geometry.
- If the user asks you to save, create, add, update, mark, or organize → write actual vault files with write_vault_file.

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
  geocodeStore: Map<string, GeocodeResult>
): ToolDefinition[] {
  // Pass-by-reference store for large geometries returned to the agent.
  const routeStore = new Map<string, [number, number][]>();
  let routeSeq = 0;
  const stashRoute = (coords: [number, number][]): string => {
    routeSeq++;
    const id = `route_${routeSeq}`;
    routeStore.set(id, coords);
    if (routeStore.size > 50) {
      const oldest = routeStore.keys().next().value;
      if (oldest != null) routeStore.delete(oldest);
    }
    return id;
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

  const vaultPrefix = maposDir.endsWith(sep) ? maposDir : maposDir + sep;
  const isUnderVault = (p: string) => p === maposDir || p.startsWith(vaultPrefix);

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
      "Display lines, polygons, or bulk points on the map as a temporary overlay without saving. Use for routes, isochrones/areas, and large datasets/layers the user views in aggregate. For a browsable list of places the user will pick from, use present_features instead (it renders a clickable, map-connected list). Lines: routes, boundaries. Polygons: isochrones, areas. For routes from get_directions, pass the returned `route_id` to a `lines` entry — never re-emit coordinates or a polyline yourself; that costs tens of thousands of output tokens and takes minutes.",
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
            coordinates: Type.Array(
              Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
              {
                description:
                  "Array of rings; each ring is [[lng, lat], ...]. First ring is outer boundary (must close)."
              }
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
            const stored = routeStore.get(l.route_id);
            if (!stored) {
              throw new Error(
                `Unknown route_id "${l.route_id}". Routes are cached in-memory; if the server restarted or the route was evicted, call get_directions again.`
              );
            }
            coordinates = stored;
          } else {
            coordinates = (l.coordinates ?? []) as [number, number][];
          }
          return {
            id: `${layerId}:${l.id ?? `line-${i}`}`,
            coordinates,
            title: l.title,
            ...(l.preview_markdown != null ? { preview_markdown: l.preview_markdown } : {})
          };
        });
        const polygons = (args.polygons ?? []).map((p, i) => ({
          id: `${layerId}:${p.id ?? `polygon-${i}`}`,
          coordinates: (p.coordinates as [number, number][][]).map((ring) => {
            if (ring.length < 2) return ring;
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (!first || !last) return ring;
            const isClosed = first[0] === last[0] && first[1] === last[1];
            return isClosed ? ring : [...ring, first];
          }),
          title: p.title,
          ...(p.preview_markdown != null ? { preview_markdown: p.preview_markdown } : {})
        }));
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
      features: Type.Array(
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
            Type.Number({ description: "Latitude — set together with lng ONLY for an ad-hoc result (no result_id)" })
          ),
          lng: Type.Optional(
            Type.Number({ description: "Longitude — set together with lat ONLY for an ad-hoc result (no result_id)" })
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
                "Structured details for an AD-HOC feature only (with result_id the app supplies these from the source). Use canonical keys when you genuinely know them: `category` (lowercase token, e.g. \"restaurant\", \"fast_food\"), `address` (street line), `source_url` (full URL). You may add extra keys (e.g. `cuisine`). Do NOT provide `osm_id`/`wikidata_id` — you have no reliable source for them and they will be dropped."
            })
          )
        }),
        { minItems: 1, description: "Ordered features to show; order is preserved in the rendered list" }
      ),
      layer_name: Type.Optional(
        Type.String({ default: "search-results", description: "Name for the overlay layer" })
      )
    }),
    execute: async (toolCallId, args) => {
      const layerId = toolCallId;
      const refs: string[] = [];
      const points: MapOverlayLayer["points"] = [];
      // result_ids the model referenced that aren't in the cache (and had no coord
      // fallback), so they were dropped. Reported back so the agent re-searches instead
      // of silently showing a short list. Happens mainly after a restart clears the cache.
      const unresolvedResultIds: string[] = [];
      args.features.forEach((f, i) => {
        if (f.path != null && f.path.length > 0) {
          refs.push(`vault:${f.path}`);
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

      // Only emit a layer when there are ad-hoc points to draw. An all-vault list
      // references markers that already exist as persistent places, so there is
      // nothing new to add to the map.
      if (points.length > 0 && !mainWindow.isDestroyed()) {
        const layer: MapOverlayLayer = {
          id: layerId,
          layerName: args.layer_name ?? "search-results",
          points,
          lines: [],
          polygons: []
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
      "Query the spatial index for features within a bounding box. Returns saved places, notes, and any indexed files within the bounds. Use filters.properties to filter by any frontmatter multi-select or text field — e.g. { tags: ['ramen'], cuisine: ['japanese'] } requires the place to have ALL listed values under each key.",
    parameters: Type.Object({
      bounds: Type.Object({
        north: Type.Number(),
        south: Type.Number(),
        east: Type.Number(),
        west: Type.Number()
      }),
      filters: Type.Optional(spatialFilters)
    }),
    execute: async (_id, args) => {
      const results = querySpatialIndex(args.bounds, args.filters);
      return TEXT_RESULT(JSON.stringify(results));
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
        return TEXT_RESULT(JSON.stringify(results));
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
      "or an isochrone). Returns the same records as query_spatial_index. A place is included if " +
      "any part of it intersects the region. Use this instead of query_spatial_index when the " +
      "area is not a rectangle. Returned file paths can be passed to present_features.",
    parameters: Type.Object({
      coordinates: Type.Array(
        Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
        {
          description:
            "Array of rings; each ring is [[lng, lat], ...]. First ring is the outer boundary (auto-closed)."
        }
      ),
      filters: Type.Optional(spatialFilters)
    }),
    execute: async (_id, args) => {
      try {
        const results = queryWithinPolygon(args.coordinates as number[][][], args.filters);
        return TEXT_RESULT(JSON.stringify(results));
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
      "Forward geocode a free-text query (place name, address, or category words like 'restaurants') via Photon/OpenStreetMap or offline region packs. Returns up to `limit` points, each with a stable `id`. Good for turning 'kinka izakaya toronto' into lat/lng, or for offline POI search — pass `categories` (with or without `query`) to filter, e.g. all cafes in the viewport bbox. To show any of these results to the user, pass its `id` to present_features as `result_id` — do NOT re-type its name, category, or address; the app fills those from the result.",
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
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })),
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
      )
    }),
    execute: async (_id, args) => {
      try {
        const results = await getServiceClient().geocoding.forward({
          query: args.query,
          categories: args.categories,
          kinds: args.kinds,
          limit: args.limit ?? 8,
          lang: args.lang,
          bbox: args.bbox
        });
        stashGeocodeResults(results);
        return TEXT_RESULT(JSON.stringify({ results }));
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
      "Compute a route between two or more locations via Valhalla. Returns: distanceMeters, durationSeconds, a `route_id` (opaque handle), pointCount, and turn-by-turn `maneuvers`. Use 'pedestrian' for walking, 'bicycle' for cycling, 'auto' for driving. The route shape is stored server-side; to render it, pass the `route_id` to a `render_overlay_on_map` lines entry. Do NOT attempt to retrieve, decode, downsample, or re-emit the route geometry yourself — there is no need.",
    parameters: Type.Object({
      locations: Type.Array(
        Type.Object({ lat: Type.Number(), lng: Type.Number() }),
        {
          minItems: 2,
          description: "Ordered list of waypoints; must have at least two"
        }
      ),
      costing: Type.Optional(
        Type.Union(
          [Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")],
          { default: "pedestrian" }
        )
      )
    }),
    execute: async (_id, args) => {
      try {
        const route = await getServiceClient().routing.directions({
          locations: args.locations,
          costing: args.costing ?? "pedestrian"
        });
        const route_id = stashRoute(route.geometry.coordinates);
        const visible = {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          route_id,
          pointCount: route.geometry.coordinates.length,
          maneuvers: route.maneuvers
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
      "Compute reachable-area polygon(s) from a location for one or more time contours (in minutes). Returns contours sorted ascending by minutes; each has a GeoJSON Polygon ready to render.",
    parameters: Type.Object({
      lat: Type.Number(),
      lng: Type.Number(),
      minutes_contours: Type.Array(Type.Number({ exclusiveMinimum: 0, maximum: 120 }), {
        minItems: 1,
        maxItems: 4,
        description: "Time contours in minutes, e.g. [5, 10, 15]"
      }),
      costing: Type.Optional(
        Type.Union(
          [Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")],
          { default: "pedestrian" }
        )
      )
    }),
    execute: async (_id, args) => {
      try {
        const iso = await getServiceClient().isochrones.contours({
          location: { lat: args.lat, lng: args.lng },
          minutesContours: args.minutes_contours,
          costing: args.costing ?? "pedestrian"
        });
        return TEXT_RESULT(JSON.stringify(iso));
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
        Type.Union(
          [Type.Literal("auto"), Type.Literal("pedestrian"), Type.Literal("bicycle")],
          { default: "pedestrian" }
        )
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
          [
            Type.Literal("day"),
            Type.Literal("week"),
            Type.Literal("month"),
            Type.Literal("year")
          ],
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
      "Write or overwrite a vault file. Use this for ALL vault file writes — never use bash redirects or other file tools. Handles undo tracking and spatial index updates automatically. Do not call index_file after this.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path within the MapOS vault" }),
      content: Type.String({ description: "Full file content to write" })
    }),
    execute: async (_id, args) => {
      if (!isUnderVault(args.path)) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: `Path must be within vault (${maposDir})` })
        );
      }
      const previousContent = existsSync(args.path) ? readFileSync(args.path, "utf-8") : null;
      onVaultWrite({ path: args.path, previousContent });
      mkdirSync(dirname(args.path), { recursive: true });
      writeFileSync(args.path, args.content, "utf-8");
      try {
        const record = await parsePlaceFile(args.path);
        syncFeatureForFile(args.path, record);
      } catch {
        // Not a place file — skip indexing
      }
      return TEXT_RESULT(
        JSON.stringify({
          success: true,
          path: args.path,
          action: previousContent === null ? "created" : "modified",
          previousContent,
          newContent: args.content
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
      if (!isUnderVault(args.path)) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: `Path must be within vault (${maposDir})` })
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
      "Rename or move a vault file. Use this instead of write+delete when only the path is changing. Handles undo tracking and spatial index updates automatically.",
    parameters: Type.Object({
      fromPath: Type.String({ description: "Current absolute path of the file within the vault" }),
      toPath: Type.String({ description: "New absolute path within the vault" })
    }),
    execute: async (_id, args) => {
      if (!isUnderVault(args.fromPath) || !isUnderVault(args.toPath)) {
        return TEXT_RESULT(
          JSON.stringify({ success: false, error: "Both paths must be within vault" })
        );
      }
      if (!existsSync(args.fromPath)) {
        return TEXT_RESULT(JSON.stringify({ success: false, error: "Source file not found" }));
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

  return [
    presentFeatures,
    renderOverlayOnMap,
    clearMapOverlay,
    querySpatialIndexTool,
    findNear,
    queryWithinPolygonTool,
    spatialSql,
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
    writeVaultFile,
    deleteVaultFile,
    renameVaultFile
  ];
}
