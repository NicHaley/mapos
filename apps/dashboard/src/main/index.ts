import {
  type Stats,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import chokidar from "chokidar";
import { BrowserWindow, app, dialog, ipcMain, session, shell } from "electron";

// Electron `userData` is `appData` + app name; keep the on-disk folder as MapOS.
app.setName("MapOS");
import matter from "gray-matter";
import { z } from "zod";
import icon from "../../resources/icon.png?asset";
import type {
  MapOverlayPayload,
  PersistedMessage,
  PlaceRecord,
  UndoEntry,
  VaultOperation
} from "../shared/types";
import { RESERVED_PROPERTY_KEYS } from "../shared/types";
import {
  closeDb,
  getAllPropertyKeys,
  getFeatureCount,
  indexFeatures,
  initDb,
  queryDistinctValuesForKey,
  queryFolderAll,
  querySpatialIndex,
  rebuildIndexFromPlaces,
  reconcileFeatureProperties,
  reconcileIndexWithPlaces,
  removeFeaturePropertiesForFile,
  removeFeatures,
  replaceFeaturePropertiesForFile
} from "./db";
import {
  appendVaultToConfig,
  getPrimaryVaultRoot,
  loadOrInitMaposConfig,
  migrateLegacyVaultInternals,
  setActiveVaultInConfig,
  vaultDotDir as vaultDotDirPath
} from "./maposConfig";
import { parseWkt } from "./wkt";

/**
 * First available `join(dir, …)` using the same pattern as Obsidian-style naming:
 * directories: `name`, `name 1`, `name 2`, …
 * files: `stem.ext`, `stem 1.ext`, …
 *
 * If `skipPath` is set, that path counts as available (same-file rename).
 */
function uniquePathInDir(
  dir: string,
  finalName: string,
  isDirectory: boolean,
  skipPath?: string
): string {
  const available = (candidate: string) =>
    !existsSync(candidate) || (skipPath !== undefined && candidate === skipPath);
  const parseSuffix = (name: string): { base: string; start: number } => {
    const match = name.match(/^(.*?)(?: (\d+))?$/);
    const rawBase = match?.[1] ?? name;
    const base = rawBase.trimEnd();
    const suffix = match?.[2];
    return { base, start: suffix ? Number.parseInt(suffix, 10) : 0 };
  };

  if (isDirectory) {
    const { base, start } = parseSuffix(finalName);
    let n = start;
    let candidate = join(dir, n === 0 ? base : `${base} ${n}`);
    while (!available(candidate)) {
      n++;
      candidate = join(dir, `${base} ${n}`);
    }
    return candidate;
  }
  const ext = extname(finalName);
  const stem = ext ? finalName.slice(0, -ext.length) : finalName;
  const { base, start } = parseSuffix(stem);
  let n = start;
  let candidate = join(dir, `${n === 0 ? base : `${base} ${n}`}${ext}`);
  while (!available(candidate)) {
    n++;
    candidate = join(dir, `${base} ${n}${ext}`);
  }
  return candidate;
}

function collectPropertyKeysFromData(
  data: Record<string, unknown>,
  keyCollector: Set<string>
): void {
  for (const key of Object.keys(data)) {
    if (!(RESERVED_PROPERTY_KEYS as readonly string[]).includes(key)) {
      keyCollector.add(key);
    }
  }
}

function placeRecordFromMatterData(
  data: Record<string, unknown>,
  filePath: string
): PlaceRecord | null {
  if (data.type === "collection") return null;
  const geo = parseWkt(data.geometry);
  const base = filePath.split(sep).pop() ?? filePath;
  const title = base.replace(/\.md$/i, "");
  return {
    geometry: geo ? JSON.stringify(geo) : undefined,
    title,
    color: typeof data.color === "string" ? data.color : undefined,
    type: (data.type as string) ?? "place",
    filePath
  };
}

/** Read markdown once: update EAV + optional property-key catalog, return place or null. */
async function parsePlaceFile(
  filePath: string,
  keyCollector?: Set<string>
): Promise<PlaceRecord | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const { data } = matter(raw);
    const rec = data as Record<string, unknown>;
    if (keyCollector) collectPropertyKeysFromData(rec, keyCollector);
    replaceFeaturePropertiesForFile(filePath, rec);
    return placeRecordFromMatterData(rec, filePath);
  } catch {
    removeFeaturePropertiesForFile(filePath);
    return null;
  }
}

type FileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
};

/** Non-directory entries shown in the vault tree (ProjectSidebar / `fs:list-dir`). */
const VAULT_TREE_LISTED_EXTENSIONS = new Set([".md", ".geojson", ".png", ".jpg", ".jpeg", ".gif"]);

function isVaultTreeListedFile(filename: string): boolean {
  return VAULT_TREE_LISTED_EXTENSIONS.has(extname(filename).toLowerCase());
}

function readDirTree(dirPath: string): FileNode[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .flatMap((entry): FileNode[] => {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return [
            {
              name: entry.name,
              path: fullPath,
              type: "directory" as const,
              children: readDirTree(fullPath)
            }
          ];
        }
        if (!isVaultTreeListedFile(entry.name)) return [];
        return [{ name: entry.name, path: fullPath, type: "file" as const }];
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

/**
 * Ensures a vault folder and its `.mapos/` subdirectory exist, and opens (or creates) the
 * per-vault SQLite database. After this call the DB is open and ready for use.
 * Callers that are NOT activating the vault (e.g. creating/registering a background vault)
 * should call `closeDb()` immediately afterwards.
 */
function initVaultOnDisk(vaultRoot: string): void {
  const dotDir = vaultDotDirPath(vaultRoot);
  mkdirSync(dotDir, { recursive: true }); // also creates vaultRoot if missing
  initDb(dotDir);
}

function setupPlacesWatcher(
  mainWindow: BrowserWindow,
  vaultRoot: string,
  appStateDir: string
): { places: Map<string, PlaceRecord>; stop: () => Promise<void> } {
  migrateLegacyVaultInternals(vaultRoot, appStateDir);
  initVaultOnDisk(vaultRoot);

  const places = new Map<string, PlaceRecord>();
  const knownPropertyKeys = new Set<string>();
  let initialScanDone = false;
  let pendingInitialSenders: Electron.WebContents[] = [];

  const watcher = chokidar.watch(`${vaultRoot}/**/*.md`, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 300 },
    ignored: /(^|[/\\])(\.|node_modules)/
  });

  watcher.on("add", async (filePath) => {
    console.log("[main] file added:", filePath);
    const place = await parsePlaceFile(filePath, knownPropertyKeys);
    console.log("[main] parsed:", place);
    if (place) {
      places.set(filePath, place);
      if (place.geometry) indexFeatures([place]);
      if (initialScanDone && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("places:updated", { event: "add", place });
      }
    }
    if (initialScanDone) notifyFsChanged();
  });

  watcher.on("change", async (filePath) => {
    const place = await parsePlaceFile(filePath, knownPropertyKeys);
    if (place) {
      places.set(filePath, place);
      if (place.geometry) {
        indexFeatures([place]);
      } else {
        removeFeatures([filePath]);
      }
    } else {
      places.delete(filePath);
      removeFeatures([filePath]);
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
    removeFeatures([filePath]);
    removeFeaturePropertiesForFile(filePath);
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
    const propReconciled = reconcileFeatureProperties();
    if (propReconciled > 0) {
      console.log("[main] reconciled feature_properties, removed stale rows:", propReconciled);
    }
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

  ipcMain.handle("fs:list-dir", () => readDirTree(vaultRoot));

  ipcMain.handle("places:get-by-path", (_event, filePath: string) => {
    return places.get(filePath) ?? null;
  });

  ipcMain.handle("fs:read-file", async (_event, filePath: string) => {
    const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
    if (filePath !== vaultRoot && !filePath.startsWith(vaultPrefix))
      return { error: "Path outside vault" };
    try {
      const raw = await readFile(filePath, "utf-8");
      const { content, data } = matter(raw);
      const frontmatter: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(data)) {
        if (!(RESERVED_PROPERTY_KEYS as readonly string[]).includes(key)) {
          frontmatter[key] = val;
        }
      }
      return { raw, body: content.trimStart(), frontmatter };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle("fs:write-file", async (_event, filePath: string, content: string) => {
    const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
    if (filePath !== vaultRoot && !filePath.startsWith(vaultPrefix))
      return { success: false, error: "Path outside vault" };
    try {
      writeFileSync(filePath, content, "utf-8");
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Write only the body of a place file, preserving the frontmatter exactly.
  // Reads the current file, regex-extracts the frontmatter block, then writes
  // frontmatter + new body — so the renderer never has to round-trip YAML.
  ipcMain.handle("fs:write-place-body", async (_event, filePath: string, body: string) => {
    const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
    if (filePath !== vaultRoot && !filePath.startsWith(vaultPrefix))
      return { success: false, error: "Path outside vault" };
    try {
      const raw = await readFile(filePath, "utf-8");
      // Match the YAML front-matter block including the trailing newline after ---
      const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const fm = fmMatch ? fmMatch[0] : "";
      // Ensure a blank line between front matter and body (standard Obsidian format)
      const newContent = fm + (body.trim() ? `\n${body.trim()}\n` : "");
      writeFileSync(filePath, newContent, "utf-8");
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Update or delete a single frontmatter property, preserving the rest.
  // Uses matter.stringify for clean round-trip serialization.
  ipcMain.handle(
    "fs:write-frontmatter-property",
    async (_event, filePath: string, key: string, value: unknown) => {
      const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
      if (filePath !== vaultRoot && !filePath.startsWith(vaultPrefix))
        return { success: false, error: "Path outside vault" };
      try {
        const raw = await readFile(filePath, "utf-8");
        const parsed = matter(raw);
        if (value === null || value === undefined) {
          delete parsed.data[key];
        } else {
          parsed.data[key] = value;
        }
        writeFileSync(filePath, matter.stringify(parsed.content, parsed.data), "utf-8");
        // Immediately update the in-memory places map so getByPath returns fresh data
        // before the file watcher fires (which has a 300ms awaitWriteFinish delay).
        void parsePlaceFile(filePath, knownPropertyKeys).then((place) => {
          if (place) {
            places.set(filePath, place);
            if (place.geometry) indexFeatures([place]);
            else removeFeatures([filePath]);
          } else {
            places.delete(filePath);
            removeFeatures([filePath]);
          }
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  // Rewrite frontmatter with keys in the given order, preserving all values and the body.
  ipcMain.handle("fs:reorder-frontmatter", async (_event, filePath: string, keyOrder: string[]) => {
    const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
    if (filePath !== vaultRoot && !filePath.startsWith(vaultPrefix))
      return { success: false, error: "Path outside vault" };
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = matter(raw);
      const reordered: Record<string, unknown> = {};
      for (const key of keyOrder) {
        if (Object.hasOwn(parsed.data, key)) reordered[key] = parsed.data[key];
      }
      // Append any keys not in keyOrder (shouldn't happen, but be safe)
      for (const key of Object.keys(parsed.data)) {
        if (!Object.hasOwn(reordered, key)) reordered[key] = parsed.data[key];
      }
      writeFileSync(filePath, matter.stringify(parsed.content, reordered), "utf-8");
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("properties:list-all-keys", () => getAllPropertyKeys());

  ipcMain.handle("properties:values-for-key", (_event, key: string) => {
    if (typeof key !== "string" || !key.trim()) return [] as string[];
    return queryDistinctValuesForKey(key.trim());
  });

  ipcMain.handle("fs:rename-file", async (_event, oldPath: string, newName: string) => {
    // Ensure we only get files within the vault.
    const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;

    if (!oldPath.startsWith(vaultPrefix)) return { success: false, error: "Path outside vault" };

    const safeName = newName.replace(/[/\\]/g, "").trim();

    if (!safeName) return { success: false, error: "Empty name" };

    const dir = oldPath.split(sep).slice(0, -1).join(sep);
    const isDir = statSync(oldPath).isDirectory();
    const finalName = isDir || safeName.endsWith(".md") ? safeName : `${safeName}.md`;
    const newPath = uniquePathInDir(dir, finalName, isDir, oldPath);

    if (!newPath.startsWith(vaultPrefix)) return { success: false, error: "Path outside vault" };

    try {
      renameSync(oldPath, newPath);

      if (isDir) {
        const oldPrefix = oldPath + sep;
        const newPrefix = newPath + sep;
        const oldKeys: string[] = [];
        const newPlaces: PlaceRecord[] = [];
        for (const [key, place] of places) {
          if (key.startsWith(oldPrefix)) {
            places.delete(key);
            oldKeys.push(key);
            newPlaces.push({ ...place, filePath: newPrefix + key.slice(oldPrefix.length) });
          }
        }
        removeFeatures(oldKeys);
        indexFeatures(newPlaces);
        for (const place of newPlaces) {
          places.set(place.filePath, place);
        }
      } else {
        const place = places.get(oldPath);
        if (place) {
          places.delete(oldPath);
          removeFeatures([oldPath]);
          const moved = { ...place, filePath: newPath };
          places.set(newPath, moved);
          if (moved.geometry) indexFeatures([moved]);
        }
      }

      notifyFsChanged();
      return { success: true, newPath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "fs:move-into",
    async (_event, sourcePath: string, destinationFolderPath: string) => {
      const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;

      if (sourcePath !== vaultRoot && !sourcePath.startsWith(vaultPrefix)) {
        return { success: false as const, error: "Path outside vault" };
      }
      if (destinationFolderPath !== vaultRoot && !destinationFolderPath.startsWith(vaultPrefix)) {
        return { success: false as const, error: "Path outside vault" };
      }

      let destStat: Stats;
      try {
        destStat = statSync(destinationFolderPath);
      } catch {
        return { success: false as const, error: "Destination folder does not exist" };
      }
      if (!destStat.isDirectory()) {
        return { success: false as const, error: "Destination is not a folder" };
      }

      const sourceDir = dirname(sourcePath);
      if (sourceDir === destinationFolderPath) {
        return { success: true as const, newPath: sourcePath };
      }

      let sourceStat: Stats;
      try {
        sourceStat = statSync(sourcePath);
      } catch {
        return { success: false as const, error: "Source does not exist" };
      }
      const sourceIsDir = sourceStat.isDirectory();

      if (sourceIsDir) {
        if (destinationFolderPath === sourcePath) {
          return { success: false as const, error: "Cannot move a folder into itself" };
        }
        const sourcePrefix = sourcePath + sep;
        if (
          destinationFolderPath === sourcePath ||
          destinationFolderPath.startsWith(sourcePrefix)
        ) {
          return { success: false as const, error: "Cannot move a folder into itself" };
        }
      }

      const newPath = uniquePathInDir(destinationFolderPath, basename(sourcePath), sourceIsDir);

      if (!newPath.startsWith(vaultPrefix)) {
        return { success: false as const, error: "Path outside vault" };
      }

      try {
        renameSync(sourcePath, newPath);

        if (sourceIsDir) {
          const oldPrefix = sourcePath + sep;
          const newPrefix = newPath + sep;
          const oldKeys: string[] = [];
          const newPlaces: PlaceRecord[] = [];
          for (const [key, place] of places) {
            if (key.startsWith(oldPrefix)) {
              places.delete(key);
              oldKeys.push(key);
              newPlaces.push({ ...place, filePath: newPrefix + key.slice(oldPrefix.length) });
            }
          }
          removeFeatures(oldKeys);
          indexFeatures(newPlaces);
          for (const place of newPlaces) {
            places.set(place.filePath, place);
          }
        } else {
          const place = places.get(sourcePath);
          if (place) {
            places.delete(sourcePath);
            removeFeatures([sourcePath]);
            const moved: PlaceRecord = { ...place, filePath: newPath };
            places.set(newPath, moved);
            if (moved.geometry) {
              indexFeatures([moved]);
            }
          }
        }

        notifyFsChanged();
        return { success: true as const, newPath };
      } catch (err) {
        return { success: false as const, error: String(err) };
      }
    }
  );

  ipcMain.handle("fs:delete-path", async (_event, targetPath: string) => {
    const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
    if (targetPath !== vaultRoot && !targetPath.startsWith(vaultPrefix)) {
      return { success: false as const, error: "Path outside vault" };
    }
    if (targetPath === vaultRoot) {
      return { success: false as const, error: "Cannot delete vault root" };
    }
    try {
      rmSync(targetPath, { recursive: true, force: false });
      return { success: true as const };
    } catch (err) {
      return { success: false as const, error: String(err) };
    }
  });

  ipcMain.handle("fs:reveal-in-finder", (_event, targetPath: string) => {
    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle("fs:get-vault-root", () => vaultRoot);

  ipcMain.handle("mapos:get-vaults-config", () => {
    const appStateDir = app.getPath("userData");
    const cfg = loadOrInitMaposConfig(appStateDir);
    const vaults = cfg.vaults.map((p) => resolve(p.trim())).filter((p) => p.length > 0);
    return { vaults, activeVaultPath: vaultRoot };
  });

  ipcMain.handle("mapos:set-folder-as-vault", async () => {
    if (mainWindow.isDestroyed()) return { canceled: true as const };
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose folder to use as a vault"
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true as const };
    const appStateDir = app.getPath("userData");
    const result = appendVaultToConfig(appStateDir, picked.filePaths[0]);
    if (!result.ok) return { ok: false as const, error: result.error };
    initVaultOnDisk(resolve(picked.filePaths[0]));
    closeDb();
    return { ok: true as const, vaults: result.config.vaults.map((p) => resolve(p.trim())) };
  });

  ipcMain.handle("mapos:create-new-vault", async () => {
    if (mainWindow.isDestroyed()) return { canceled: true as const };
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose where to create the new vault"
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true as const };
    const parent = picked.filePaths[0];
    let newPath: string;
    try {
      newPath = uniquePathInDir(parent, "MapOS Vault", true);
      initVaultOnDisk(newPath);
      closeDb();
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
    const appStateDir = app.getPath("userData");
    const result = appendVaultToConfig(appStateDir, newPath);
    if (!result.ok) {
      try {
        rmSync(newPath, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      return { ok: false as const, error: result.error };
    }
    return {
      ok: true as const,
      path: newPath,
      vaults: result.config.vaults.map((p) => resolve(p.trim()))
    };
  });

  ipcMain.handle(
    "fs:create-folder",
    (_event, args: { parentFolderPath: string; folderName: string }) => {
      const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
      const parent = args.parentFolderPath;
      if (parent !== vaultRoot && !parent.startsWith(vaultPrefix))
        return { success: false as const, error: "Path outside vault" };

      const safeName = args.folderName.replace(/[/\\]/g, "").trim();
      if (!safeName) return { success: false as const, error: "Empty name" };

      const candidate = uniquePathInDir(parent, safeName, true);

      if (!candidate.startsWith(vaultPrefix))
        return { success: false as const, error: "Path outside vault" };

      try {
        mkdirSync(candidate);
        notifyFsChanged();
        return { success: true as const, folderPath: candidate };
      } catch (err) {
        return { success: false as const, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "fs:create-place-file",
    async (
      _event,
      args: {
        parentFolderPath: string | null;
        lat?: number;
        lng?: number;
        /** When false with lat/lng, only writes `geometry` (no `type` / `status`). Default true. */
        includePlaceFrontmatterDefaults?: boolean;
      }
    ) => {
      const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
      let dir: string;
      if (args.parentFolderPath) {
        const p = args.parentFolderPath;
        if (p !== vaultRoot && !p.startsWith(vaultPrefix)) {
          return { success: false as const, error: "Path outside vault" };
        }
        dir = p;
      } else {
        dir = vaultRoot;
      }
      const candidate = uniquePathInDir(dir, "Untitled.md", false);
      const content =
        args.lat != null && args.lng != null
          ? `---\ngeometry: POINT(${args.lng} ${args.lat})\n---\n`
          : "";
      try {
        writeFileSync(candidate, content, "utf-8");
        notifyFsChanged();
        return { success: true as const, filePath: candidate };
      } catch (err) {
        return { success: false as const, error: String(err) };
      }
    }
  );

  ipcMain.handle("places:query-bounds", (_event, bounds) => {
    return querySpatialIndex(bounds)
      .filter((r) => r.file_path.startsWith(vaultRoot))
      .map((r) => {
        const titleFallback = (r.file_path.split(sep).pop() ?? r.file_path).replace(/\.md$/i, "");
        return {
          geometry: r.geometry,
          title: titleFallback,
          color: r.color ?? undefined,
          type: "place",
          filePath: r.file_path
        };
      });
  });

  ipcMain.handle("places:query-folder-all", (_event, folderPath: string) => {
    return queryFolderAll(folderPath)
      .filter((r) => r.file_path.startsWith(vaultRoot))
      .map((r) => {
        const titleFallback = (r.file_path.split(sep).pop() ?? r.file_path).replace(/\.md$/i, "");
        return {
          geometry: r.geometry,
          title: titleFallback,
          color: r.color ?? undefined,
          type: "place",
          filePath: r.file_path
        };
      });
  });

  ipcMain.handle("places:query-folder-bounds", (_event, args) => {
    const { folderPath, bounds } = args as {
      folderPath: string;
      bounds: { north: number; south: number; east: number; west: number };
    };
    return querySpatialIndex(bounds, { folderPath })
      .filter((r) => r.file_path.startsWith(vaultRoot))
      .map((r) => {
        const titleFallback = (r.file_path.split(sep).pop() ?? r.file_path).replace(/\.md$/i, "");
        return {
          geometry: r.geometry,
          title: titleFallback,
          color: r.color ?? undefined,
          type: "place",
          filePath: r.file_path
        };
      });
  });

  ipcMain.handle("fs:read-geojson", async (_event, filePath: string) => {
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data.type === "FeatureCollection") return data;
      if (data.type === "Feature") return { type: "FeatureCollection", features: [data] };
      return null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("fs:geojson-files-in-folder", (_event, folderPath: string) => {
    try {
      const entries = readdirSync(folderPath, { recursive: true }) as string[];
      return entries
        .filter((e) => extname(e).toLowerCase() === ".geojson")
        .map((e) => join(folderPath, e))
        .filter((p) => p.startsWith(vaultRoot));
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    "fs:write-geojson-property",
    async (_event, filePath: string, key: string, value: unknown) => {
      try {
        const raw = await readFile(filePath, "utf-8");
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (value === null || value === undefined) {
          delete data[key];
        } else {
          data[key] = value;
        }
        await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  );

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

  const WATCHER_HANDLE_CHANNELS = [
    "fs:list-dir",
    "places:get-by-path",
    "fs:read-file",
    "fs:write-file",
    "fs:write-place-body",
    "fs:write-frontmatter-property",
    "fs:reorder-frontmatter",
    "properties:list-all-keys",
    "properties:values-for-key",
    "fs:rename-file",
    "fs:move-into",
    "fs:delete-path",
    "fs:reveal-in-finder",
    "fs:get-vault-root",
    "mapos:get-vaults-config",
    "mapos:set-folder-as-vault",
    "mapos:create-new-vault",
    "fs:create-folder",
    "fs:create-place-file",
    "places:query-bounds",
    "places:query-folder-all",
    "places:query-folder-bounds",
    "fs:read-geojson",
    "fs:geojson-files-in-folder",
    "fs:write-geojson-property"
  ] as const;

  async function stop(): Promise<void> {
    await watcher.close();
    for (const ch of WATCHER_HANDLE_CHANNELS) ipcMain.removeHandler(ch);
    ipcMain.removeAllListeners("places:request-initial");
    places.clear();
  }

  return { places, stop };
}

function buildMaposSystemPrompt(vaultRoot: string): string {
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

When you get search or geocode results from Mapbox (e.g. geocoding an address, searching for POIs), use render_overlay_on_map to display them on the map as temporary overlay. Pass points for POIs, lines for routes/boundaries, polygons for isochrones or areas. Use clear_map_overlay when starting a new search or when the user asks to clear.

After showing results on the map, do not explain how to interact with the UI (e.g. do not say to click markers, to say "save", or to use Add all — those affordances are visible in the app). Give a short substantive answer only: what you found, names, or next steps that are not redundant with the map.

## File operations

For any vault file write or delete, use write_vault_file or delete_vault_file — never the raw Bash redirect or other file tools. These tracked tools handle undo snapshots and spatial index updates automatically. After writing a place file, do NOT call index_file separately — write_vault_file handles indexing. When only the file path is changing (rename or move), use rename_vault_file instead of write+delete.

## Display vs. action intent

- If the user asks you to find, show, search, explore, or preview → use render_overlay_on_map for ephemeral display. Do not write files.
- If the user asks you to save, create, add, update, mark, or organize → write actual vault files with write_vault_file.`;
}

const ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "mcp__mapbox__*",
  "mcp__mapos__render_overlay_on_map",
  "mcp__mapos__clear_map_overlay",
  "mcp__mapos__query_spatial_index",
  "mcp__mapos__index_file",
  "mcp__mapos__rebuild_index",
  "mcp__mapos__get_viewport",
  "mcp__mapos__pan_to",
  "mcp__mapos__write_vault_file",
  "mcp__mapos__delete_vault_file",
  "mcp__mapos__rename_vault_file"
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

function createMaposMcpServer(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  maposDir: string,
  onVaultWrite: (op: VaultOperation) => void,
  onOverlayUpdate: (overlay: MapOverlayPayload | null) => void,
  getOverlay: () => MapOverlayPayload | null | undefined
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
              z.object({
                coordinates: z
                  .array(z.tuple([z.number(), z.number()]))
                  .describe("Array of [longitude, latitude] pairs"),
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
            const lines = (args.lines ?? []).map((l, i) => ({
              id: l.id ?? `overlay-line-${i}`,
              coordinates: l.coordinates,
              title: l.title,
              ...(l.preview_markdown != null ? { preview_markdown: l.preview_markdown } : {})
            }));
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
          if (record) {
            indexFeatures([record]);
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
            if (record) indexFeatures([record]);
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
            if (record) indexFeatures([record]);
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

type ActiveConversation = {
  id: string;
  messages: PersistedMessage[];
  sdkSessionId?: string;
  overlay?: MapOverlayPayload | null;
};

function newConversationId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

let activeConversationsDir = "";
let activeConversationsIndex = "";

function loadConvState(id: string): { overlay: MapOverlayPayload | null } {
  try {
    const p = join(activeConversationsDir, `${id}.state.json`);
    if (!existsSync(p)) return { overlay: null };
    return JSON.parse(readFileSync(p, "utf-8")) as { overlay: MapOverlayPayload | null };
  } catch {
    return { overlay: null };
  }
}

function saveConvState(id: string, state: { overlay: MapOverlayPayload | null }): void {
  try {
    writeFileSync(join(activeConversationsDir, `${id}.state.json`), JSON.stringify(state), "utf-8");
  } catch (err) {
    console.error("[main] failed to save conv state:", err);
  }
}

type ConversationMeta = {
  id: string;
  created_at: string;
  updated_at: string;
  messageCount: number;
  preview: string;
  sdkSessionId?: string;
};

function convToMeta(conv: ActiveConversation): ConversationMeta {
  const firstUser = conv.messages.find((m) => m.role === "user");
  return {
    id: conv.id,
    created_at: conv.messages[0]?.timestamp ?? new Date().toISOString(),
    updated_at: conv.messages[conv.messages.length - 1]?.timestamp ?? new Date().toISOString(),
    messageCount: conv.messages.length,
    preview: (firstUser?.content ?? "").slice(0, 100),
    sdkSessionId: conv.sdkSessionId
  };
}

function readConversationIndex(): ConversationMeta[] {
  try {
    const lines = readFileSync(activeConversationsIndex, "utf-8").split("\n").filter(Boolean);
    const map = new Map<string, ConversationMeta>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ConversationMeta;
        map.set(entry.id, entry);
      } catch {
        /* skip malformed lines */
      }
    }
    return Array.from(map.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
  } catch {
    return [];
  }
}

function compactIndex(entries: ConversationMeta[]): void {
  try {
    writeFileSync(
      activeConversationsIndex,
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf-8"
    );
  } catch (err) {
    console.error("[main] failed to compact index:", err);
  }
}

function appendToIndex(conv: ActiveConversation): void {
  try {
    appendFileSync(activeConversationsIndex, `${JSON.stringify(convToMeta(conv))}\n`, "utf-8");
  } catch (err) {
    console.error("[main] failed to append to index:", err);
  }
}

function initConversationsDir(): void {
  if (!existsSync(activeConversationsDir)) {
    mkdirSync(activeConversationsDir, { recursive: true });
  }
  // Compact index on startup to deduplicate accumulated entries
  const entries = readConversationIndex();
  if (entries.length > 0) compactIndex(entries);
}

function loadMostRecentConversation(): ActiveConversation | null {
  try {
    const entries = readConversationIndex();
    if (entries.length === 0) return null;
    const latest = entries[entries.length - 1];
    const lines = readFileSync(join(activeConversationsDir, `${latest.id}.jsonl`), "utf-8")
      .split("\n")
      .filter(Boolean);
    const messages = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as PersistedMessage];
      } catch {
        return [];
      }
    });
    const state = loadConvState(latest.id);
    return { id: latest.id, messages, sdkSessionId: latest.sdkSessionId, overlay: state.overlay };
  } catch {
    return null;
  }
}

function appendMessage(conv: ActiveConversation, msg: PersistedMessage): void {
  try {
    appendFileSync(
      join(activeConversationsDir, `${conv.id}.jsonl`),
      `${JSON.stringify(msg)}\n`,
      "utf-8"
    );
    appendToIndex(conv);
  } catch (err) {
    console.error("[main] failed to append message:", err);
  }
}

function setupChat(
  mainWindow: BrowserWindow,
  places: Map<string, PlaceRecord>,
  vaultRoot: string,
  appStateDir: string
): () => void {
  activeConversationsDir = join(appStateDir, "conversations");
  activeConversationsIndex = join(activeConversationsDir, "index.jsonl");

  const apiKey = import.meta.env.MAIN_VITE_ANTHROPIC_API_KEY;
  const mapboxAccessToken = import.meta.env.MAIN_VITE_MAPBOX_ACCESS_TOKEN;
  let currentQuery: { close: () => void } | null = null;
  let currentUndoEntry: UndoEntry | null = null;

  const onVaultWrite = (op: VaultOperation): void => {
    if (!currentUndoEntry) return;
    // Only snapshot the first write per path per turn (keep original pre-turn content)
    const alreadyTracked = currentUndoEntry.operations.some((o) => o.path === op.path);
    if (!alreadyTracked) {
      currentUndoEntry.operations.push(op);
    }
  };

  const onOverlayUpdate = (overlay: MapOverlayPayload | null): void => {
    if (!currentConversation) return;
    currentConversation.overlay = overlay;
    saveConvState(currentConversation.id, { overlay });
  };

  initConversationsDir();

  let currentConversation: ActiveConversation | null = loadMostRecentConversation();
  if (currentConversation) {
    console.log(
      "[main] loaded conversation:",
      currentConversation.id,
      "messages:",
      currentConversation.messages.length
    );
  }

  const maposServer = createMaposMcpServer(
    mainWindow,
    places,
    vaultRoot,
    onVaultWrite,
    onOverlayUpdate,
    () => currentConversation?.overlay
  );

  ipcMain.handle("chat:load-history", () => {
    return {
      messages: currentConversation?.messages ?? [],
      overlay: currentConversation?.overlay ?? null
    };
  });

  ipcMain.handle("chat:list-conversations", () => {
    return readConversationIndex();
  });

  ipcMain.handle("chat:switch-conversation", (_event, id: string) => {
    try {
      currentUndoEntry = null;
      const lines = readFileSync(join(activeConversationsDir, `${id}.jsonl`), "utf-8")
        .split("\n")
        .filter(Boolean);
      const messages = lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as PersistedMessage];
        } catch {
          return [];
        }
      });
      const meta = readConversationIndex().find((e) => e.id === id);
      const state = loadConvState(id);
      currentConversation = {
        id,
        messages,
        sdkSessionId: meta?.sdkSessionId,
        overlay: state.overlay
      };
      return { messages, overlay: state.overlay };
    } catch {
      return { messages: [], overlay: null };
    }
  });

  ipcMain.on("chat:send", async (_event, message: string) => {
    if (currentQuery) {
      currentQuery.close();
      currentQuery = null;
    }

    // Reset undo stack for this new turn
    currentUndoEntry = { operations: [] };

    if (!currentConversation) {
      currentConversation = { id: newConversationId(), messages: [] };
    }

    const userMsg: PersistedMessage = {
      role: "user",
      content: message,
      timestamp: new Date().toISOString()
    };
    currentConversation.messages.push(userMsg);
    appendMessage(currentConversation, userMsg);

    const abortController = new AbortController();

    try {
      const q = query({
        prompt: message,
        options: {
          ...(currentConversation.sdkSessionId ? { resume: currentConversation.sdkSessionId } : {}),
          abortController,
          cwd: vaultRoot,
          model: "claude-sonnet-4-6",
          systemPrompt: buildMaposSystemPrompt(vaultRoot),
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
            ANTHROPIC_API_KEY: apiKey,
            ANTHROPIC_BASE_URL: import.meta.env.MAIN_VITE_ANTHROPIC_BASE_URL,
            MAPOS_VAULT_ROOT: vaultRoot
          }
        }
      });

      currentQuery = q;

      let fullText = "";
      let fullThinking = "";
      const fullToolCalls: Array<{
        id: string;
        name: string;
        input: unknown;
        result?: string;
        isError?: boolean;
      }> = [];

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
          } else if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "thinking_delta"
          ) {
            const thinking = (event.delta as { thinking?: string }).thinking ?? "";
            fullThinking += thinking;
            mainWindow.webContents.send("chat:thinking_chunk", thinking);
          }
        } else if (msg.type === "assistant") {
          const content = (
            msg as {
              message?: {
                content?: Array<{
                  type?: string;
                  text?: string;
                  id?: string;
                  name?: string;
                  input?: unknown;
                }>;
              };
            }
          ).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_use" && block.name) {
                const id = block.id ?? "";
                fullToolCalls.push({ id, name: block.name, input: block.input ?? {} });
                mainWindow.webContents.send("chat:tool_call", {
                  id,
                  name: block.name,
                  input: block.input ?? {}
                });
              }
            }
          }
        } else if (msg.type === "user") {
          const userMsg = msg as {
            message?: {
              content?: Array<{
                type?: string;
                tool_use_id?: string;
                content?: unknown;
                is_error?: boolean;
              }>;
            };
          };
          const content = userMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? (block.content as Array<{ type?: string; text?: string }>)
                          .filter((b) => b.type === "text")
                          .map((b) => b.text ?? "")
                          .join("")
                      : "";
                const isError = block.is_error ?? false;
                const tc = fullToolCalls.find((t) => t.id === block.tool_use_id);
                if (tc) {
                  tc.result = resultText;
                  tc.isError = isError;
                }
                mainWindow.webContents.send("chat:tool_result", {
                  tool_use_id: block.tool_use_id,
                  content: resultText,
                  isError
                });
              }
            }
          }
        } else if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
          const initSessionId = (msg as { session_id?: string }).session_id;
          if (initSessionId && currentConversation) {
            currentConversation.sdkSessionId = initSessionId;
            appendToIndex(currentConversation);
          }
        } else if (msg.type === "result" && (msg as { subtype?: string }).subtype === "success") {
          if (currentConversation) {
            const assistantMsg: PersistedMessage = {
              role: "assistant",
              content: fullText,
              thinking: fullThinking || undefined,
              toolCalls: fullToolCalls.length > 0 ? fullToolCalls : undefined,
              timestamp: new Date().toISOString()
            };
            currentConversation.messages.push(assistantMsg);
            appendMessage(currentConversation, assistantMsg);
          }
          if (!mainWindow.isDestroyed()) {
            const canUndo = (currentUndoEntry?.operations.length ?? 0) > 0;
            mainWindow.webContents.send("chat:done", { canUndo });
          }
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

  ipcMain.handle("chat:undo", async () => {
    if (!currentUndoEntry || currentUndoEntry.operations.length === 0) {
      return { success: false, error: "Nothing to undo" };
    }
    const errors: string[] = [];
    for (const op of [...currentUndoEntry.operations].reverse()) {
      try {
        if (op.previousContent === null) {
          // File was created this turn — delete it
          removeFeatures([op.path]);
          if (existsSync(op.path)) rmSync(op.path);
        } else {
          // File was modified or deleted — restore it
          mkdirSync(dirname(op.path), { recursive: true });
          writeFileSync(op.path, op.previousContent, "utf-8");
          const record = await parsePlaceFile(op.path);
          if (record) indexFeatures([record]);
        }
      } catch (e) {
        errors.push(`${op.path}: ${e}`);
      }
    }
    currentUndoEntry = null;
    return { success: errors.length === 0, errors };
  });

  ipcMain.on("chat:reset", () => {
    currentConversation = null;
    currentUndoEntry = null;
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("map:overlay-clear");
    }
  });

  ipcMain.on("chat:clear-overlay", () => {
    onOverlayUpdate(null);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("map:overlay-clear");
    }
  });

  ipcMain.handle("chat:delete-conversation", (_event, id: string) => {
    try {
      const convFile = join(activeConversationsDir, `${id}.jsonl`);
      if (existsSync(convFile)) rmSync(convFile);
      const stateFile = join(activeConversationsDir, `${id}.state.json`);
      if (existsSync(stateFile)) rmSync(stateFile);
      const entries = readConversationIndex().filter((e) => e.id !== id);
      compactIndex(entries);
      if (currentConversation?.id === id) {
        currentConversation = null;
      }
    } catch (err) {
      console.error("[main] failed to delete conversation:", err);
    }
  });

  const CHAT_HANDLE_CHANNELS = [
    "chat:load-history",
    "chat:list-conversations",
    "chat:switch-conversation",
    "chat:undo",
    "chat:delete-conversation"
  ] as const;
  const CHAT_ON_CHANNELS = ["chat:send", "chat:abort", "chat:reset", "chat:clear-overlay"] as const;

  return function stopChat(): void {
    currentQuery?.close();
    currentQuery = null;
    currentConversation = null;
    currentUndoEntry = null;
    for (const ch of CHAT_HANDLE_CHANNELS) ipcMain.removeHandler(ch);
    for (const ch of CHAT_ON_CHANNELS) ipcMain.removeAllListeners(ch);
  };
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false
      // devTools: false
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
            "img-src 'self' data: blob: https://api.protomaps.com https://protomaps.github.io",
            "connect-src 'self' https://api.protomaps.com https://protomaps.github.io https://photon.komoot.io",
            "worker-src 'self' blob:",
            "font-src 'self' data:"
          ].join("; ")
        ]
      }
    });
  });

  const mainWindow = createWindow();
  const appStateDir = app.getPath("userData");

  let maposConfig = loadOrInitMaposConfig(appStateDir);
  let vaultRoot = getPrimaryVaultRoot(maposConfig);
  let { places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir);
  let stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);

  ipcMain.handle("mapos:switch-vault", async (_event, targetPath: string) => {
    const result = setActiveVaultInConfig(appStateDir, targetPath);
    if (!result.ok) return result;

    // Tear down current vault
    stopChat();
    await stopWatcher();
    closeDb();

    // Re-initialize with new vault
    maposConfig = loadOrInitMaposConfig(appStateDir);
    vaultRoot = getPrimaryVaultRoot(maposConfig);
    ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
    stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);

    // Reload the renderer (fast — no process restart)
    mainWindow.webContents.reload();

    return { ok: true as const };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
