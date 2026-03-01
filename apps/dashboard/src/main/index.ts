import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import chokidar from "chokidar";
import { BrowserWindow, app, ipcMain, session, shell } from "electron";
import matter from "gray-matter";
import icon from "../../resources/icon.png?asset";

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

function setupPlacesWatcher(mainWindow: BrowserWindow): void {
  const MAPOS_DIR = join(homedir(), "Documents", "MapOS");
  if (!existsSync(MAPOS_DIR)) {
    mkdirSync(MAPOS_DIR, { recursive: true });
  }

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
      if (initialScanDone && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("places:updated", { event: "add", place });
      }
    }
  });

  watcher.on("change", async (filePath) => {
    const place = await parsePlaceFile(filePath);
    if (place) {
      places.set(filePath, place);
    } else {
      places.delete(filePath);
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
    if (initialScanDone && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("places:updated", {
        event: "unlink",
        filePath
      });
    }
  });

  watcher.on("ready", () => {
    initialScanDone = true;
    console.log("[main] watcher ready, places found:", places.size);
    const allPlaces = Array.from(places.values());
    for (const sender of pendingInitialSenders) {
      if (!sender.isDestroyed()) {
        sender.send("places:initial", allPlaces);
      }
    }
    pendingInitialSenders = [];
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

Always ground responses in the user's actual files. Be concise and spatial — when discussing places, think about the map. When creating files, use human-readable kebab-case filenames.`;

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
  "mcp__mapbox__*"
] as const;

function setupChat(mainWindow: BrowserWindow): void {
  const apiKey = import.meta.env.MAIN_VITE_ANTHROPIC_API_KEY;
  const conversationHistory: { role: "user" | "assistant"; content: string }[] = [];
  let currentQuery: { close: () => void } | null = null;

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
          // Add mapbox MCP server config for mcp__mapbox__* tools, e.g.:
          // mcpServers: { mapbox: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-mapbox"] } },
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
  setupPlacesWatcher(mainWindow);
  setupChat(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
