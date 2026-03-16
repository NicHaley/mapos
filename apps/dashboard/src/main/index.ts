import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import chokidar from "chokidar";
import { BrowserWindow, app, ipcMain, session, shell } from "electron";
import matter from "gray-matter";
import { z } from "zod";
import icon from "../../resources/icon.png?asset";
import {
  getFeatureCount,
  indexFeature,
  initDb,
  querySpatialIndex,
  rebuildIndexFromPlaces,
  reconcileIndexWithPlaces,
  removeFeature
} from "./db";

type PlaceRecord = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  status: string;
  type: string;
  category?: string;
  tags?: string[];
  filePath: string;
};

async function parsePlaceFile(filePath: string): Promise<PlaceRecord | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const { data, content } = matter(raw);
    if (typeof data.lat !== "number" || typeof data.lng !== "number") return null;
    if (data.type === "collection") return null;
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : (data.id ?? filePath);
    return {
      id: data.id ?? "",
      lat: data.lat,
      lng: data.lng,
      title,
      status: data.status ?? "",
      type: data.type ?? "place",
      category: data.category,
      tags: data.tags,
      filePath
    };
  } catch {
    return null;
  }
}

type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
};

function readDirTree(dirPath: string): FileNode[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((entry) => {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path: fullPath,
            type: "directory" as const,
            children: readDirTree(fullPath)
          };
        }
        return { name: entry.name, path: fullPath, type: "file" as const };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

function setupPlacesWatcher(mainWindow: BrowserWindow): Map<string, PlaceRecord> {
  const MAPOS_DIR = join(homedir(), "Documents", "MapOS");
  if (!existsSync(MAPOS_DIR)) {
    mkdirSync(MAPOS_DIR, { recursive: true });
  }

  initDb(MAPOS_DIR);

  const places = new Map<string, PlaceRecord>();
  let initialScanDone = false;
  let pendingInitialSenders: Electron.WebContents[] = [];

  const watcher = chokidar.watch(`${MAPOS_DIR}/**/*.md`, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 300 },
    ignored: /(^|[/\\])(\.|node_modules)/
  });

  watcher.on("add", async (filePath) => {
    console.log("[main] file added:", filePath);
    const place = await parsePlaceFile(filePath);
    console.log("[main] parsed:", place);
    if (place) {
      places.set(filePath, place);
      indexFeature(place);
      if (initialScanDone && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("places:updated", { event: "add", place });
      }
    }
    if (initialScanDone) notifyFsChanged();
  });

  watcher.on("change", async (filePath) => {
    const place = await parsePlaceFile(filePath);
    if (place) {
      places.set(filePath, place);
      indexFeature(place);
    } else {
      places.delete(filePath);
      removeFeature(filePath);
    }
    if (initialScanDone && !mainWindow.isDestroyed()) {
      if (place) {
        mainWindow.webContents.send("places:updated", {
          event: "change",
          place
        });
      } else {
        mainWindow.webContents.send("places:updated", {
          event: "unlink",
          filePath
        });
      }
    }
  });

  watcher.on("unlink", (filePath) => {
    places.delete(filePath);
    removeFeature(filePath);
    if (initialScanDone && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("places:updated", { event: "unlink", filePath });
      notifyFsChanged();
    }
  });

  const notifyFsChanged = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("fs:changed");
  };

  watcher.on("ready", () => {
    initialScanDone = true;
    const reconciled = reconcileIndexWithPlaces(places);
    if (reconciled > 0) console.log("[main] reconciled index, removed stale features:", reconciled);
    console.log("[main] watcher ready, places found:", places.size);
    console.log("[main] features indexed:", getFeatureCount());
    const allPlaces = Array.from(places.values());
    for (const sender of pendingInitialSenders) {
      if (!sender.isDestroyed()) {
        sender.send("places:initial", allPlaces);
      }
    }
    pendingInitialSenders = [];
  });

  ipcMain.handle("fs:list-dir", () => readDirTree(MAPOS_DIR));

  ipcMain.handle("places:get-by-path", (_event, filePath: string) => {
    return places.get(filePath) ?? null;
  });

  ipcMain.handle("places:query-bounds", (_event, bounds) => {
    return querySpatialIndex(bounds)
      .filter((r) => r.file_path.startsWith(MAPOS_DIR))
      .map((r) => {
      const geo = JSON.parse(r.geometry) as { coordinates: [number, number] };
      return {
        id: r.id,
        lat: geo.coordinates[1],
        lng: geo.coordinates[0],
        title: r.title ?? r.id,
        status: r.status ?? "",
        type: "place",
        tags: r.tags ?? undefined,
        filePath: r.file_path
      };
    });
  });

  ipcMain.on("places:request-initial", (event) => {
    console.log(
      "[main] places:request-initial received, scanDone:",
      initialScanDone,
      "places:",
      places.size
    );
    if (initialScanDone) {
      event.sender.send("places:initial", Array.from(places.values()));
    } else {
      pendingInitialSenders.push(event.sender);
    }
  });

  return places;
}

const MAPOS_SYSTEM_PROMPT = `You are the AI agent powering MapOS, a map-first application where the map is the primary interface for a user's personal files, saved places, photos, and spatial data. Your job is to help users organize, explore, and reason about their world through their files.

MapOS is a local-first Electron application. Everything runs on the user's machine. Files are the source of truth. All user data lives under ~/Documents/MapOS/ with this structure:
- places/want-to-go/    — saved places the user wants to visit
- places/visited/       — places the user has been
- places/collections/   — named lists (trips, projects, themes)
- notes/field-notes/    — notes created while at a location
- notes/area-research/  — research about a place or area
- media/imports/        — JSON sidecars for external photo library photos
- media/local/          — photos stored inside MapOS
- layers/               — saved map layer configurations (JSON)
- analysis/             — saved spatial query results (JSON/GeoJSON)

Place files use Markdown with YAML frontmatter. Required frontmatter: id (kebab-slug), lat, lng, type (place|note|collection-entry), status (want-to-go|visited|maybe). Optional: category, tags, source_url, created, visited_on, rating, collection.

Always ground responses in the user's actual files. Be concise and spatial — when discussing places, think about the map. When creating files, use human-readable kebab-case filenames.

When you get search or geocode results from Mapbox (e.g. geocoding an address, searching for POIs), use render_overlay_on_map to display them on the map as temporary overlay. Pass points for POIs, lines for routes/boundaries, polygons for isochrones or areas. Use clear_map_overlay when starting a new search or when the user asks to clear.`;

const MAPOS_DIR = join(homedir(), "Documents", "MapOS");

const ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "mcp__mapbox__*",
  "mcp__mapos__render_overlay_on_map",
  "mcp__mapos__clear_map_overlay",
  "mcp__mapos__query_spatial_index",
  "mcp__mapos__index_file",
  "mcp__mapos__rebuild_index"
] as const;

function createMaposMcpServer(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  maposDir: string
) {
  return createSdkMcpServer({
    name: "mapos",
    version: "1.0.0",
    tools: [
      tool(
        "render_overlay_on_map",
        "Display points, lines, or polygons on the map as temporary overlay without saving. Use for search results, isochrones, routes, or any spatial data. Points: POIs, geocode results. Lines: routes, boundaries. Polygons: isochrones, areas.",
        {
          points: z
            .array(
              z.object({
                lat: z.number().describe("Latitude in decimal degrees"),
                lng: z.number().describe("Longitude in decimal degrees"),
                title: z.string().describe("Display name for the marker"),
                id: z.string().optional().describe("Unique identifier for the point")
              })
            )
            .optional()
            .default([]),
          lines: z
            .array(
              z.object({
                coordinates: z
                  .array(z.tuple([z.number(), z.number()]))
                  .describe("Array of [longitude, latitude] pairs"),
                title: z.string().optional(),
                id: z.string().optional()
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
                id: z.string().optional()
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
              title: p.title
            }));
            const lines = (args.lines ?? []).map((l, i) => ({
              id: l.id ?? `overlay-line-${i}`,
              coordinates: l.coordinates,
              title: l.title
            }));
            const polygons = (args.polygons ?? []).map((p, i) => ({
              id: p.id ?? `overlay-polygon-${i}`,
              coordinates: p.coordinates.map((ring) => {
                if (ring.length < 2) return ring;
                const [first, last] = [ring[0], ring[ring.length - 1]];
                const isClosed = first[0] === last[0] && first[1] === last[1];
                return isClosed ? ring : [...ring, ring[0]];
              }),
              title: p.title
            }));
            mainWindow.webContents.send("map:overlay", {
              layerName: args.layer_name,
              points,
              lines,
              polygons
            });
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
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("map:overlay-clear");
          }
          return {
            content: [{ type: "text", text: "Overlay cleared" }]
          };
        }
      ),
      tool(
        "query_spatial_index",
        "Query the spatial index for features within a bounding box. Returns saved places, notes, and any indexed files within the bounds.",
        {
          bounds: z.object({
            north: z.number(),
            south: z.number(),
            east: z.number(),
            west: z.number()
          }),
          filters: z
            .object({
              status: z.string().optional(),
              tags: z.array(z.string()).optional()
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
        { path: z.string().describe("Absolute path to the place file (must be under the MapOS vault)") },
        async (args) => {
          const vaultPrefix = maposDir.endsWith(sep) ? maposDir : maposDir + sep;
          const underVault =
            args.path === maposDir || args.path.startsWith(vaultPrefix);
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
          if (record) {
            indexFeature(record);
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
      )
    ]
  });
}

function setupChat(mainWindow: BrowserWindow, places: Map<string, PlaceRecord>): void {
  const apiKey = import.meta.env.MAIN_VITE_ANTHROPIC_API_KEY;
  const mapboxAccessToken = import.meta.env.MAIN_VITE_MAPBOX_ACCESS_TOKEN;
  const conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
  let currentQuery: { close: () => void } | null = null;

  const maposServer = createMaposMcpServer(mainWindow, places, MAPOS_DIR);

  ipcMain.on("chat:send", async (_event, message: string) => {
    if (currentQuery) {
      currentQuery.close();
      currentQuery = null;
    }

    conversationHistory.push({ role: "user", content: message });

    const prompt =
      conversationHistory.length === 1
        ? message
        : conversationHistory
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n\n");

    const abortController = new AbortController();

    try {
      const q = query({
        prompt,
        options: {
          abortController,
          cwd: MAPOS_DIR,
          systemPrompt: MAPOS_SYSTEM_PROMPT,
          allowedTools: [...ALLOWED_TOOLS],
          tools: [...ALLOWED_TOOLS],
          includePartialMessages: true,
          thinking: { type: "adaptive" },
          mcpServers: {
            mapbox: {
              command: "npx",
              args: ["-y", "@mapbox/mcp-server"],
              env: {
                MAPBOX_ACCESS_TOKEN: mapboxAccessToken
              }
            },
            mapos: maposServer
          },
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: apiKey
          }
        }
      });

      currentQuery = q;

      let fullText = "";

      for await (const msg of q) {
        if (mainWindow.isDestroyed()) break;

        if (msg.type === "stream_event") {
          const event = (
            msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }
          ).event;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const text = event.delta.text ?? "";
            fullText += text;
            mainWindow.webContents.send("chat:chunk", text);
          } else if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
            const thinking = (event.delta as { thinking?: string }).thinking ?? "";
            mainWindow.webContents.send("chat:thinking_chunk", thinking);
          }
        } else if (msg.type === "assistant") {
          const content = (
            msg as { message?: { content?: Array<{ type?: string; text?: string }> } }
          ).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                fullText += block.text;
              }
            }
          }
        } else if (msg.type === "result" && (msg as { subtype?: string }).subtype === "success") {
          conversationHistory.push({ role: "assistant", content: fullText });
          if (!mainWindow.isDestroyed()) mainWindow.webContents.send("chat:done");
          break;
        } else if (msg.type === "result" && (msg as { subtype?: string }).subtype !== "success") {
          const errMsg = (msg as { errors?: string[] }).errors?.join("; ") ?? "Unknown error";
          if (!mainWindow.isDestroyed()) mainWindow.webContents.send("chat:error", errMsg);
          break;
        } else if (
          (msg as { type?: string }).type === "assistant" &&
          (msg as { error?: string }).error
        ) {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send("chat:error", (msg as { error: string }).error);
          }
          break;
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send("chat:error", msg);
    } finally {
      currentQuery = null;
    }
  });

  ipcMain.on("chat:abort", () => {
    if (currentQuery) {
      currentQuery.close();
      currentQuery = null;
    }
  });

  ipcMain.on("chat:reset", () => {
    conversationHistory.length = 0;
  });
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false
    }
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    if (is.dev) mainWindow.webContents.openDevTools();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.on("ping", () => console.log("pong"));

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' blob:",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://tiles.openfreemap.org https://*.openfreemap.org",
            "connect-src 'self' https://tiles.openfreemap.org https://*.openfreemap.org",
            "worker-src 'self' blob:",
            "font-src 'self' data:"
          ].join("; ")
        ]
      }
    });
  });

  const mainWindow = createWindow();
  const places = setupPlacesWatcher(mainWindow);
  setupChat(mainWindow, places);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
