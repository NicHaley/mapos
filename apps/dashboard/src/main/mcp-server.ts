import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, sep } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { type BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import {
  computeBbox,
  forwardGeocode,
  getDirections,
  getIsochrone,
  getMatrix,
  MapServiceError,
  reverseGeocode
} from "../shared/map-services";
import type { MapOverlayPayload, PlaceRecord, VaultOperation } from "../shared/types";
import {
  querySpatialIndex,
  rebuildIndexFromPlaces,
  removeFeaturePropertiesForFile,
  removeFeatures,
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

export const ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "mcp__mapos__render_overlay_on_map",
  "mcp__mapos__clear_map_overlay",
  "mcp__mapos__query_spatial_index",
  "mcp__mapos__index_file",
  "mcp__mapos__rebuild_index",
  "mcp__mapos__get_viewport",
  "mcp__mapos__pan_to",
  "mcp__mapos__write_vault_file",
  "mcp__mapos__delete_vault_file",
  "mcp__mapos__rename_vault_file",
  "mcp__mapos__geocode_search",
  "mcp__mapos__reverse_geocode",
  "mcp__mapos__get_directions",
  "mcp__mapos__get_isochrone",
  "mcp__mapos__get_matrix",
  "mcp__mapos__compute_bbox"
] as const;

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
  return `You are the AI agent powering MapOS, a map-first application where the map is the primary interface for a user's personal files, saved places, and spatial data. Your job is to help users organize, explore, and reason about their world through their files.

MapOS is a local-first Electron application. Everything runs on the user's machine. Files are the source of truth.

## Vault location (authoritative — use exactly this path)
The MapOS vault root on this machine is: ${vaultRoot}
The agent working directory (cwd) for this session is set to that folder. The environment variable MAPOS_VAULT_ROOT is also set to this path (useful in Bash). For Glob, Grep, Read, Bash, and any file search or listing tools, search only under this path (e.g. ${vaultRoot}${sep}**${sep}*.md for Markdown notes). Do not guess home-directory layouts — always use the absolute path above.

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
- \`get_matrix\` — pairwise travel distance/time between sources and targets. Keep N small (≤ 10 each side) against the community Valhalla instance.
- \`compute_bbox\` — bounding box for a set of lat/lng points; useful for framing a viewport around results.

After calling any of these, display the results with \`render_overlay_on_map\`:
- points from \`geocode_search\` / \`reverse_geocode\` → the \`points\` array
- a route from \`get_directions\` → a \`lines\` entry with \`{ route_id }\`. The server resolves the id back to the geometry. Do NOT pass coordinates or polyline strings yourself for these routes — they cost tens of thousands of tokens and take minutes to generate.
- each \`contours[].polygon.coordinates\` from \`get_isochrone\` → a \`polygons\` entry

Call \`clear_map_overlay\` when starting a new search or when the user asks to clear.

After showing results on the map, do not explain how to interact with the UI (e.g. do not say to click markers, to say "save", or to use Add all — those affordances are visible in the app). Give a short substantive answer only: what you found, names, or next steps that are not redundant with the map.

## File operations

For any vault file write or delete, use write_vault_file or delete_vault_file — never the raw Bash redirect or other file tools. These tracked tools handle undo snapshots and spatial index updates automatically. After writing a place file, do NOT call index_file separately — write_vault_file handles indexing. When only the file path is changing (rename or move), use rename_vault_file instead of write+delete.

## Display vs. action intent

- If the user asks you to find, show, search, explore, or preview → use render_overlay_on_map for ephemeral display. Do not write files.
- If the user asks you to save, create, add, update, mark, or organize → write actual vault files with write_vault_file.

## Listing features in chat

When referencing features in a response, you may emit a \`<features>\` tag and the UI will render a clickable, interactive list connected to the map. Use it whenever a flat list of features would be more useful than prose mentions.

Syntax: \`<features refs="<entry>,<entry>,..."/>\` — a single self-closing tag with a comma-separated \`refs\` attribute. Each entry has the form \`<kind>:<id>\`:

- \`vault:<file-path>\` — a saved vault file (use the same path returned by \`query_spatial_index\`)
- \`overlay:<id>\` — a feature currently rendered on the map by \`render_overlay_on_map\`. The id must match the \`id\` you supplied to that tool.

Order is preserved in the rendered list.

**Hard rule:** any \`overlay:\` ref MUST be preceded by a \`render_overlay_on_map\` call earlier in the same response. The ids must match. Otherwise the ref will render as a stale row.

Example — after a geocode_search for ramen + render_overlay_on_map with ids \`r1\`, \`r2\`, plus two saved places:

\`\`\`
<features refs="vault:tokyo-2026/kinka-izakaya.md,overlay:r1,vault:tokyo-2026/ichiran.md,overlay:r2"/>
\`\`\``;
}

export function createMaposMcpServer(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  maposDir: string,
  onVaultWrite: (op: VaultOperation) => void,
  onOverlayUpdate: (overlay: MapOverlayPayload | null) => void,
  getOverlay: () => MapOverlayPayload | null | undefined
) {
  // Pass-by-reference store for large geometries returned to the agent.
  // The agent gets a short id and hands it back to render tools instead
  // of re-emitting tens of thousands of tokens of coordinates/polyline.
  const routeStore = new Map<string, [number, number][]>();
  let routeSeq = 0;
  const stashRoute = (coords: [number, number][]): string => {
    routeSeq++;
    const id = `route_${routeSeq}`;
    routeStore.set(id, coords);
    // Bound memory: keep last 50 routes.
    if (routeStore.size > 50) {
      const oldest = routeStore.keys().next().value;
      if (oldest != null) routeStore.delete(oldest);
    }
    return id;
  };

  return createSdkMcpServer({
    name: "mapos",
    version: "1.0.0",
    tools: [
      tool(
        "render_overlay_on_map",
        "Display points, lines, or polygons on the map as temporary overlay without saving. Use for search results, isochrones, routes, or any spatial data. Points: POIs, geocode results. Lines: routes, boundaries. Polygons: isochrones, areas. For routes from get_directions, pass the returned `route_id` to a `lines` entry — never re-emit coordinates or a polyline yourself; that costs tens of thousands of output tokens and takes minutes.",
        {
          points: z
            .array(
              z.object({
                lat: z.number().describe("Latitude in decimal degrees"),
                lng: z.number().describe("Longitude in decimal degrees"),
                title: z.string().describe("Display name for the marker"),
                id: z.string().optional().describe("Unique identifier for the point"),
                preview_markdown: z
                  .string()
                  .optional()
                  .describe("Optional markdown shown in the place preview card before save")
              })
            )
            .optional()
            .default([]),
          lines: z
            .array(
              z
                .object({
                  route_id: z
                    .string()
                    .optional()
                    .describe(
                      "Opaque id returned by get_directions. Preferred for routes — server resolves to the full geometry without re-transmitting it through the LLM."
                    ),
                  coordinates: z
                    .array(z.tuple([z.number(), z.number()]))
                    .optional()
                    .describe(
                      "Array of [longitude, latitude] pairs. Use only for short, hand-built lines."
                    ),
                  title: z.string().optional(),
                  id: z.string().optional(),
                  preview_markdown: z
                    .string()
                    .optional()
                    .describe("Optional markdown shown in the place preview card before save")
                })
                .refine((l) => !!l.route_id || !!l.coordinates, {
                  message: "Each line must include `route_id` or `coordinates`."
                })
            )
            .optional()
            .default([]),
          polygons: z
            .array(
              z.object({
                coordinates: z
                  .array(z.array(z.tuple([z.number(), z.number()])))
                  .describe(
                    "Array of rings; each ring is [[lng, lat], ...]. First ring is outer boundary (must close)."
                  ),
                title: z.string().optional(),
                id: z.string().optional(),
                preview_markdown: z
                  .string()
                  .optional()
                  .describe("Optional markdown shown in the place preview card before save")
              })
            )
            .optional()
            .default([]),
          layer_name: z
            .string()
            .optional()
            .default("search-results")
            .describe("Name for this overlay layer")
        },
        async (args) => {
          if (!mainWindow.isDestroyed()) {
            const points = (args.points ?? []).map((p, i) => ({
              id: p.id ?? `overlay-point-${i}`,
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
                coordinates = l.coordinates ?? [];
              }
              return {
                id: l.id ?? `overlay-line-${i}`,
                coordinates,
                title: l.title,
                ...(l.preview_markdown != null ? { preview_markdown: l.preview_markdown } : {})
              };
            });
            const polygons = (args.polygons ?? []).map((p, i) => ({
              id: p.id ?? `overlay-polygon-${i}`,
              coordinates: p.coordinates.map((ring) => {
                if (ring.length < 2) return ring;
                const [first, last] = [ring[0], ring[ring.length - 1]];
                const isClosed = first[0] === last[0] && first[1] === last[1];
                return isClosed ? ring : [...ring, ring[0]];
              }),
              title: p.title,
              ...(p.preview_markdown != null ? { preview_markdown: p.preview_markdown } : {})
            }));
            const payload: MapOverlayPayload = {
              layerName: args.layer_name,
              points,
              lines,
              polygons
            };
            mainWindow.webContents.send("map:overlay", payload);
            onOverlayUpdate(payload);
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
          return {
            content: [{ type: "text", text: `Displayed ${parts.join(", ")} on map` }]
          };
        }
      ),
      tool(
        "clear_map_overlay",
        "Remove temporary search results from the map. Call when starting a new search or when the user asks to clear the overlay.",
        {},
        async () => {
          if (getOverlay() != null) {
            if (!mainWindow.isDestroyed()) {
              mainWindow.webContents.send("map:overlay-clear");
            }
            onOverlayUpdate(null);
          }
          return {
            content: [{ type: "text", text: "Overlay cleared" }]
          };
        }
      ),
      tool(
        "query_spatial_index",
        "Query the spatial index for features within a bounding box. Returns saved places, notes, and any indexed files within the bounds. Use filters.properties to filter by any frontmatter multi-select or text field — e.g. { tags: ['ramen'], cuisine: ['japanese'] } requires the place to have ALL listed values under each key.",
        {
          bounds: z.object({
            north: z.number(),
            south: z.number(),
            east: z.number(),
            west: z.number()
          }),
          filters: z
            .object({
              folderPath: z.string().optional(),
              properties: z.record(z.string(), z.array(z.string())).optional()
            })
            .optional()
        },
        async (args) => {
          const results = querySpatialIndex(args.bounds, args.filters);
          return { content: [{ type: "text", text: JSON.stringify(results) }] };
        }
      ),
      tool(
        "index_file",
        "Re-index a specific file into the spatial index after writing it. Call this after creating or editing a place file so the map updates immediately.",
        {
          path: z
            .string()
            .describe("Absolute path to the place file (must be under the MapOS vault)")
        },
        async (args) => {
          const vaultPrefix = maposDir.endsWith(sep) ? maposDir : maposDir + sep;
          const underVault = args.path === maposDir || args.path.startsWith(vaultPrefix);
          if (!underVault) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    reason: `Path must be under vault (${maposDir})`
                  })
                }
              ]
            };
          }
          const record = await parsePlaceFile(args.path);
          syncFeatureForFile(args.path, record);
          if (record) {
            return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: false, reason: "Could not parse file" })
              }
            ]
          };
        }
      ),
      tool(
        "rebuild_index",
        "Clear and rebuild the entire spatial index by re-scanning all place files. Use if the index seems stale or corrupt.",
        {},
        async () => {
          const count = rebuildIndexFromPlaces(places);
          return { content: [{ type: "text", text: JSON.stringify({ count }) }] };
        }
      ),
      tool(
        "get_viewport",
        "Returns the current map viewport: bounding box, center coordinates, and zoom level.",
        {},
        async () => {
          if (!lastViewport) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ error: "Viewport not yet available" }) }
              ]
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(lastViewport) }] };
        }
      ),
      tool(
        "pan_to",
        "Move the map camera to a location. Use after rendering search results or creating a new place.",
        {
          lat: z.number().describe("Latitude"),
          lng: z.number().describe("Longitude"),
          zoom: z.number().optional().describe("Zoom level 0-20, default 14")
        },
        async (args) => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("map:pan-to", {
              lat: args.lat,
              lng: args.lng,
              zoom: args.zoom
            });
          }
          return { content: [{ type: "text", text: `Map panning to ${args.lat}, ${args.lng}` }] };
        }
      ),
      tool(
        "geocode_search",
        "Forward geocode a free-text query (place name or address) via Photon/OpenStreetMap. Returns up to `limit` points with labels. Good for turning 'kinka izakaya toronto' into lat/lng.",
        {
          query: z.string().describe("Search query, e.g. place name or address"),
          limit: z.number().int().min(1).max(20).optional().default(8),
          lang: z
            .string()
            .optional()
            .describe("ISO 639-1 language code for labels, e.g. 'en', 'fr'"),
          bbox: z
            .object({
              north: z.number(),
              south: z.number(),
              east: z.number(),
              west: z.number()
            })
            .optional()
            .describe("Optional bias rectangle; results near this box score higher")
        },
        async (args) => {
          try {
            const results = await forwardGeocode(args.query, {
              limit: args.limit,
              lang: args.lang,
              bbox: args.bbox
            });
            return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
          } catch (err) {
            return { content: [{ type: "text", text: errorPayload(err) }] };
          }
        }
      ),
      tool(
        "reverse_geocode",
        "Reverse geocode a point (lat/lng) via Photon/OpenStreetMap. Returns nearby named feature(s).",
        {
          lat: z.number(),
          lng: z.number(),
          limit: z.number().int().min(1).max(10).optional().default(1),
          lang: z.string().optional()
        },
        async (args) => {
          try {
            const results = await reverseGeocode(
              { lat: args.lat, lng: args.lng },
              { limit: args.limit, lang: args.lang }
            );
            return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
          } catch (err) {
            return { content: [{ type: "text", text: errorPayload(err) }] };
          }
        }
      ),
      tool(
        "get_directions",
        "Compute a route between two or more locations via Valhalla. Returns: distanceMeters, durationSeconds, a `route_id` (opaque handle), pointCount, and turn-by-turn `maneuvers`. Use 'pedestrian' for walking, 'bicycle' for cycling, 'auto' for driving. The route shape is stored server-side; to render it, pass the `route_id` to a `render_overlay_on_map` lines entry. Do NOT attempt to retrieve, decode, downsample, or re-emit the route geometry yourself — there is no need.",
        {
          locations: z
            .array(z.object({ lat: z.number(), lng: z.number() }))
            .min(2)
            .describe("Ordered list of waypoints; must have at least two"),
          costing: z.enum(["auto", "pedestrian", "bicycle"]).default("pedestrian")
        },
        async (args) => {
          try {
            const route = await getDirections({
              locations: args.locations,
              costing: args.costing
            });
            const route_id = stashRoute(route.geometry.coordinates);
            const visible = {
              distanceMeters: route.distanceMeters,
              durationSeconds: route.durationSeconds,
              route_id,
              pointCount: route.geometry.coordinates.length,
              maneuvers: route.maneuvers
            };
            return { content: [{ type: "text", text: JSON.stringify(visible) }] };
          } catch (err) {
            return { content: [{ type: "text", text: errorPayload(err) }] };
          }
        }
      ),
      tool(
        "get_isochrone",
        "Compute reachable-area polygon(s) from a location for one or more time contours (in minutes). Returns contours sorted ascending by minutes; each has a GeoJSON Polygon ready to render.",
        {
          lat: z.number(),
          lng: z.number(),
          minutes_contours: z
            .array(z.number().positive().max(120))
            .min(1)
            .max(4)
            .describe("Time contours in minutes, e.g. [5, 10, 15]"),
          costing: z.enum(["auto", "pedestrian", "bicycle"]).default("pedestrian")
        },
        async (args) => {
          try {
            const iso = await getIsochrone({
              location: { lat: args.lat, lng: args.lng },
              minutesContours: args.minutes_contours,
              costing: args.costing
            });
            return { content: [{ type: "text", text: JSON.stringify(iso) }] };
          } catch (err) {
            return { content: [{ type: "text", text: errorPayload(err) }] };
          }
        }
      ),
      tool(
        "get_matrix",
        "Pairwise travel distance/time between sources and targets via Valhalla. Returns cells[sourceIdx][targetIdx] with distanceMeters/durationSeconds (null where unreachable). Keep N small against the community Valhalla instance — prefer ≤ 10 sources × 10 targets.",
        {
          sources: z.array(z.object({ lat: z.number(), lng: z.number() })).min(1).max(25),
          targets: z.array(z.object({ lat: z.number(), lng: z.number() })).min(1).max(25),
          costing: z.enum(["auto", "pedestrian", "bicycle"]).default("pedestrian")
        },
        async (args) => {
          try {
            const matrix = await getMatrix({
              sources: args.sources,
              targets: args.targets,
              costing: args.costing
            });
            return { content: [{ type: "text", text: JSON.stringify(matrix) }] };
          } catch (err) {
            return { content: [{ type: "text", text: errorPayload(err) }] };
          }
        }
      ),
      tool(
        "compute_bbox",
        "Compute the bounding box that contains a set of lat/lng points. Useful for framing a viewport around search results or a route. Returns { north, south, east, west } or null for an empty list.",
        {
          points: z.array(z.object({ lat: z.number(), lng: z.number() }))
        },
        async (args) => {
          const b = computeBbox(args.points);
          return { content: [{ type: "text", text: JSON.stringify(b) }] };
        }
      ),
      tool(
        "write_vault_file",
        "Write or overwrite a vault file. Use this for ALL vault file writes — never use Bash redirects or other file tools. Handles undo tracking and spatial index updates automatically. Do not call index_file after this.",
        {
          path: z.string().describe("Absolute path within the MapOS vault"),
          content: z.string().describe("Full file content to write")
        },
        async (args) => {
          const vaultPrefix = maposDir.endsWith(sep) ? maposDir : maposDir + sep;
          const underVault = args.path === maposDir || args.path.startsWith(vaultPrefix);
          if (!underVault) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Path must be within vault (${maposDir})`
                  })
                }
              ]
            };
          }
          // Snapshot existing content for undo (only first write per path per turn)
          const previousContent = existsSync(args.path) ? readFileSync(args.path, "utf-8") : null;
          onVaultWrite({ path: args.path, previousContent });
          // Write file
          mkdirSync(dirname(args.path), { recursive: true });
          writeFileSync(args.path, args.content, "utf-8");
          // Index in spatial DB if it's a place file
          try {
            const record = await parsePlaceFile(args.path);
            syncFeatureForFile(args.path, record);
          } catch {
            // Not a place file — skip indexing
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  path: args.path,
                  action: previousContent === null ? "created" : "modified",
                  previousContent,
                  newContent: args.content
                })
              }
            ]
          };
        }
      ),
      tool(
        "delete_vault_file",
        "Delete a vault file. Use this instead of Bash rm. Handles undo tracking and spatial index cleanup automatically.",
        {
          path: z.string().describe("Absolute path within the MapOS vault to delete")
        },
        async (args) => {
          const vaultPrefix = maposDir.endsWith(sep) ? maposDir : maposDir + sep;
          const underVault = args.path === maposDir || args.path.startsWith(vaultPrefix);
          if (!underVault) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Path must be within vault (${maposDir})`
                  })
                }
              ]
            };
          }
          if (!existsSync(args.path)) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ success: false, error: "File not found" }) }
              ]
            };
          }
          // Snapshot for undo
          const previousContent = readFileSync(args.path, "utf-8");
          onVaultWrite({ path: args.path, previousContent });
          // Remove from spatial index and EAV, then delete
          removeFeatures([args.path]);
          removeFeaturePropertiesForFile(args.path);
          rmSync(args.path);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  path: args.path,
                  action: "deleted",
                  previousContent,
                  newContent: null
                })
              }
            ]
          };
        }
      ),
      tool(
        "rename_vault_file",
        "Rename or move a vault file. Use this instead of write+delete when only the path is changing. Handles undo tracking and spatial index updates automatically.",
        {
          fromPath: z.string().describe("Current absolute path of the file within the vault"),
          toPath: z.string().describe("New absolute path within the vault")
        },
        async (args) => {
          const vaultPrefix = maposDir.endsWith(sep) ? maposDir : maposDir + sep;
          const fromUnder = args.fromPath === maposDir || args.fromPath.startsWith(vaultPrefix);
          const toUnder = args.toPath === maposDir || args.toPath.startsWith(vaultPrefix);
          if (!fromUnder || !toUnder) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ success: false, error: "Both paths must be within vault" })
                }
              ]
            };
          }
          if (!existsSync(args.fromPath)) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ success: false, error: "Source file not found" })
                }
              ]
            };
          }
          const content = readFileSync(args.fromPath, "utf-8");
          // Track both sides for undo
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
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  path: args.toPath,
                  fromPath: args.fromPath,
                  action: "renamed",
                  previousContent: content,
                  newContent: content
                })
              }
            ]
          };
        }
      )
    ]
  });
}
