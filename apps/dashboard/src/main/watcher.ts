import {
  type Stats,
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
import chokidar from "chokidar";
import { type BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import matter from "gray-matter";
import type { PlaceRecord } from "../shared/types";
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
  reconcileFeatureProperties,
  reconcileIndexWithPlaces,
  removeFeaturePropertiesForFile,
  removeFeatures,
  replaceFeaturePropertiesForFile,
  syncFeatureForFile
} from "./db";
import {
  appendVaultToConfig,
  loadOrInitMaposConfig,
  migrateLegacyVaultInternals,
  vaultDotDir as vaultDotDirPath
} from "./mapos-config";
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
export async function parsePlaceFile(
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

export function setupPlacesWatcher(
  mainWindow: BrowserWindow,
  vaultRoot: string,
  appStateDir: string
): { places: Map<string, PlaceRecord>; stop: () => Promise<void> } {
  migrateLegacyVaultInternals(vaultRoot, appStateDir);
  initVaultOnDisk(vaultRoot);

  const places = new Map<string, PlaceRecord>();
  const knownPropertyKeys = new Set<string>();
  const pendingRenameOldPaths = new Set<string>();
  let initialScanDone = false;
  let pendingInitialSenders: Electron.WebContents[] = [];

  const watcher = chokidar.watch(`${vaultRoot}/**/*.md`, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 300 },
    ignored: /(^|[/\\])(\.|node_modules)/,
    // `fsevents` is native; it is built for the system Node ABI. Under Electron the .node
    // binary can load but break (e.g. Native.flags undefined → Cannot read 'SinceNow').
    ...(process.versions.electron ? { useFsEvents: false as const } : {})
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
    if (pendingRenameOldPaths.has(filePath)) {
      pendingRenameOldPaths.delete(filePath);
      return;
    }
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
    const oldExt = oldPath.match(/\.[^./\\]+$/)?.[0] ?? ".md";
    const finalName = isDir || safeName.includes(".") ? safeName : `${safeName}${oldExt}`;
    const newPath = uniquePathInDir(dir, finalName, isDir, oldPath);

    if (!newPath.startsWith(vaultPrefix)) return { success: false, error: "Path outside vault" };

    try {
      pendingRenameOldPaths.add(oldPath);
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
          syncFeatureForFile(newPath, moved);
        }
      }

      notifyFsChanged();
      return { success: true, newPath };
    } catch (err) {
      pendingRenameOldPaths.delete(oldPath);
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
            syncFeatureForFile(newPath, moved);
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
        writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
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
