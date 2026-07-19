import {
  type Stats,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import chokidar from "chokidar";
import { type BrowserWindow, ipcMain, shell } from "electron";
import matter from "gray-matter";
import type { PlaceRecord } from "../shared/types";
import { RESERVED_PROPERTY_KEYS, SERVABLE_IMAGE_EXTENSIONS } from "../shared/types";
import { readVaultAppearance, writeVaultAppearance } from "./appearance";
import {
  getAllPropertyKeysWithTypes,
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
import { vaultDotDir as vaultDotDirPath } from "./mapos-config";
import { parseWkt } from "./wkt";

/**
 * First available `join(dir, …)` using the same pattern as Obsidian-style naming:
 * directories: `name`, `name 1`, `name 2`, …
 * files: `stem.ext`, `stem 1.ext`, …
 *
 * If `skipPath` is set, that path counts as available (same-file rename).
 */
export function uniquePathInDir(
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

/** Vault folder that paste/drag-drop imports land in (future per-vault config point). */
const ATTACHMENTS_DIR_NAME = "attachments";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Hand-rolled on purpose: importing date-fns into the main bundle flips the
// commonjs transform so chokidar's optional `fsevents` require gets inlined as
// a top-level native chunk, crashing the ESM main process at boot.
function attachmentTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Magic-byte sniff of the formats the vault protocol serves. The sniffed type —
 * never the sender-supplied name — decides the written file's extension, so a
 * renamed non-image can't land in the vault as a servable `.png`.
 */
function sniffImageType(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return { ext: ".png", mime: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { ext: ".gif", mime: "image/gif" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: ".webp", mime: "image/webp" };
  }
  return null;
}

/**
 * Write image bytes into the vault's attachments folder. Shared by the renderer
 * import IPC (paste/drop/file picker) and main-process importers (wiki images).
 */
export async function importAttachmentToVault(
  vaultRoot: string,
  args: { suggestedName?: string; bytes: Uint8Array }
): Promise<
  { success: true; relPath: string; absPath: string } | { success: false; error: string }
> {
  if (args.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { success: false as const, error: "Image exceeds the 25 MB attachment limit" };
  }
  const sniffed = sniffImageType(args.bytes);
  if (!sniffed) {
    return { success: false as const, error: "Unsupported image format" };
  }
  // basename + char strip defang traversal/hidden-file names; the sniffed
  // extension always wins over whatever the sender's name claimed.
  const cleaned = args.suggestedName
    ? basename(args.suggestedName)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from filenames is the point
        .replace(/[/\\\x00-\x1f]/g, "")
        .replace(/^\.+/, "")
        .trim()
    : "";
  const stem = cleaned ? cleaned.replace(/\.[^.]*$/, "") : "";
  const finalName = `${stem || `Pasted image ${attachmentTimestamp(new Date())}`}${sniffed.ext}`;
  try {
    const dir = join(vaultRoot, ATTACHMENTS_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const absPath = uniquePathInDir(dir, finalName, false);
    // Async so a large image doesn't block the main event loop; `wx` turns the
    // pick-name→write race (name looked free, created meanwhile) into an error
    // instead of an overwrite.
    await writeFile(absPath, Buffer.from(args.bytes), { flag: "wx" });
    // Posix-style so the path is portable inside markdown regardless of OS.
    const relPath = relative(vaultRoot, absPath).split(sep).join("/");
    return { success: true as const, relPath, absPath };
  } catch (err) {
    return { success: false as const, error: String(err) };
  }
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
const VAULT_TREE_LISTED_EXTENSIONS = new Set<string>([
  ".md",
  ".geojson",
  ...SERVABLE_IMAGE_EXTENSIONS
]);

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
export function initVaultOnDisk(vaultRoot: string): void {
  const dotDir = vaultDotDirPath(vaultRoot);
  mkdirSync(dotDir, { recursive: true }); // also creates vaultRoot if missing
  initDb(dotDir);
}

export function setupPlacesWatcher(
  mainWindow: BrowserWindow,
  vaultRoot: string,
  _appStateDir: string
): { places: Map<string, PlaceRecord>; stop: () => Promise<void> } {
  initVaultOnDisk(vaultRoot);

  const places = new Map<string, PlaceRecord>();
  const knownPropertyKeys = new Set<string>();
  const pendingRenameOldPaths = new Set<string>();
  let initialScanDone = false;
  let pendingInitialSenders: Electron.WebContents[] = [];

  /**
   * Separates "internal" file writes (from our own IPC handlers) from "external"
   * writes (git pull, VS Code, Obsidian open alongside, cloud sync agents).
   *
   * Every IPC write handler does two things:
   *   1. writeFileSync — persist to disk
   *   2. ipcWriteBarrier.add(filePath) — record that we were the writer
   * and then (for handlers that track place state) updates the in-memory `places`
   * Map synchronously from the data it just serialized — no disk re-read needed.
   *
   * When chokidar's `change` event later fires, it calls `ipcWriteBarrier.delete(path)`.
   * If it finds a matching entry, the change is *our own write echoing back* and we
   * skip re-parsing from disk (the Map is already correct, re-reading is wasted work
   * and opens a race window). If the entry isn't there, the change is external and
   * we re-parse normally.
   *
   * Why this matters concretely:
   *   - It avoids redundant parse-on-every-keystroke for typical UI edits.
   *   - It prevents a data-corruption bug seen when the vault lives in iCloud Drive:
   *     after a write, iCloud can briefly re-push an older version of the file; a
   *     blind re-read in chokidar would then load that stale content back into the
   *     Map and (after a file switch) the user would see reverted state. The barrier
   *     makes the Map immune to this class of "echo" write.
   *
   * External-write support (the original reason `chokidar.change` re-parses at all)
   * still works: those writes don't go through our IPC, so no barrier entry exists,
   * and the normal re-parse path runs.
   */
  const ipcWriteBarrier = new Set<string>();

  /**
   * Persist a vault file and mark it as an internal write in one step.
   * Use this — not raw `writeFileSync` — for every vault file write from an IPC
   * handler. Raw `writeFileSync` would skip the barrier and cause the chokidar
   * re-read race described above.
   */
  const writeVaultFile = (filePath: string, content: string): void => {
    writeFileSync(filePath, content, "utf-8");
    ipcWriteBarrier.add(filePath);
  };

  const watcher = chokidar.watch(`${vaultRoot}/**/*.md`, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 300 },
    ignored: /(^|[/\\])(\.|node_modules)/,
    // `fsevents` is native; it is built for the system Node ABI. Under Electron the .node
    // binary can load but break (e.g. Native.flags undefined → Cannot read 'SinceNow').
    ...(process.versions.electron ? { useFsEvents: false as const } : {})
  });

  /**
   * Non-place vault files (geojson, images) appear in the sidebar tree but have no
   * persistent in-memory state — they're loaded on demand. Watch just for add/unlink
   * so the file tree stays live when files are dropped in or removed externally.
   * No `change` handler: content edits don't affect what the tree shows.
   */
  const nonPlaceGlobExts = ["geojson", ...SERVABLE_IMAGE_EXTENSIONS.map((e) => e.slice(1))];
  const nonPlaceWatcher = chokidar.watch(`${vaultRoot}/**/*.{${nonPlaceGlobExts.join(",")}}`, {
    ignoreInitial: true, // startup listing is covered by readDirTree
    ignored: /(^|[/\\])(\.|node_modules)/,
    ...(process.versions.electron ? { useFsEvents: false as const } : {})
  });
  nonPlaceWatcher.on("add", () => notifyFsChanged());
  nonPlaceWatcher.on("unlink", () => notifyFsChanged());
  // Content changes to a file that's currently rendered (e.g. an external AI edits
  // a .geojson the user is viewing). The sidebar tree doesn't care, but the map /
  // PlaceCard needs to re-read the file to reflect the change.
  nonPlaceWatcher.on("change", (filePath) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("fs:file-content-changed", { filePath });
    }
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
    // If this change event is an echo of our own IPC write, the Map is already
    // correct. Skip the re-parse; just forward the notification to the renderer.
    // See the `ipcWriteBarrier` doc comment above for the full rationale.
    if (ipcWriteBarrier.delete(filePath)) {
      const place = places.get(filePath);
      if (initialScanDone && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
          "places:updated",
          place ? { event: "change", place } : { event: "unlink", filePath }
        );
        mainWindow.webContents.send("fs:file-content-changed", { filePath });
      }
      return;
    }
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
      mainWindow.webContents.send(
        "places:updated",
        place ? { event: "change", place } : { event: "unlink", filePath }
      );
      mainWindow.webContents.send("fs:file-content-changed", { filePath });
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
      // `cover`/`cover_source` are reserved (hidden from the generic grid) but
      // the card renders the hero image and its provenance link from them, so
      // surface each as its own field.
      const cover = typeof data.cover === "string" ? data.cover : undefined;
      const coverSource = typeof data.cover_source === "string" ? data.cover_source : undefined;
      return { raw, body: content.trimStart(), frontmatter, cover, coverSource };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle("fs:write-file", async (_event, filePath: string, content: string) => {
    const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
    if (filePath !== vaultRoot && !filePath.startsWith(vaultPrefix))
      return { success: false, error: "Path outside vault" };
    try {
      writeVaultFile(filePath, content);
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
      writeVaultFile(filePath, newContent);
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
        // Clone before mutating: gray-matter caches parses by raw string and hands
        // back the SAME `data` object every time, so in-place edits poison the cache
        // and deleted keys resurrect whenever a file round-trips to identical bytes.
        const data: Record<string, unknown> = { ...parsed.data };
        if (value === null || value === undefined) {
          delete data[key];
        } else {
          data[key] = value;
        }
        writeVaultFile(filePath, matter.stringify(parsed.content, data));
        // Update the places Map synchronously from `data` — the same object we just
        // serialized to disk. Don't re-read the file: the barrier above will make
        // chokidar skip its own re-read for this change, so this is the one place
        // that establishes the new state.
        const rec = data;
        collectPropertyKeysFromData(rec, knownPropertyKeys);
        replaceFeaturePropertiesForFile(filePath, rec);
        const place = placeRecordFromMatterData(rec, filePath);
        if (place) {
          places.set(filePath, place);
          syncFeatureForFile(filePath, place);
        } else {
          places.delete(filePath);
          removeFeatures([filePath]);
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  // Merge several frontmatter properties in one round-trip, preserving existing keys
  // and the body. New keys are appended in the object's iteration order; blank values
  // are skipped and null/undefined deletes the key (matching the singular handler).
  // Used when saving a preview place (search/chat) to the vault so the file isn't
  // rewritten once per property.
  ipcMain.handle(
    "fs:write-frontmatter-properties",
    async (_event, filePath: string, properties: Record<string, unknown>) => {
      const vaultPrefix = vaultRoot.endsWith(sep) ? vaultRoot : vaultRoot + sep;
      if (filePath !== vaultRoot && !filePath.startsWith(vaultPrefix))
        return { success: false, error: "Path outside vault" };
      try {
        const raw = await readFile(filePath, "utf-8");
        const parsed = matter(raw);
        // Clone before mutating — see fs:write-frontmatter-property.
        const data: Record<string, unknown> = { ...parsed.data };
        for (const [key, value] of Object.entries(properties)) {
          if (value === "") continue;
          if (value === null || value === undefined) delete data[key];
          else data[key] = value;
        }
        writeVaultFile(filePath, matter.stringify(parsed.content, data));
        const rec = data;
        collectPropertyKeysFromData(rec, knownPropertyKeys);
        replaceFeaturePropertiesForFile(filePath, rec);
        const place = placeRecordFromMatterData(rec, filePath);
        if (place) {
          places.set(filePath, place);
          syncFeatureForFile(filePath, place);
        } else {
          places.delete(filePath);
          removeFeatures([filePath]);
        }
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
      writeVaultFile(filePath, matter.stringify(parsed.content, reordered));
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("properties:list-all-keys", () => getAllPropertyKeysWithTypes());

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

  ipcMain.handle("appearance:get", () => readVaultAppearance(vaultRoot));

  ipcMain.handle("appearance:set", (_event, patch: Record<string, string | null>) =>
    writeVaultAppearance(vaultRoot, patch)
  );

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
    "fs:import-attachment",
    (_event, args: { suggestedName?: string; bytes: Uint8Array }) =>
      importAttachmentToVault(vaultRoot, args)
  );

  ipcMain.handle(
    "fs:create-place-file",
    async (
      _event,
      args: {
        parentFolderPath: string | null;
        lat?: number;
        lng?: number;
        /** WKT geometry. Takes precedence over lat/lng — use for non-Point shapes. */
        geometryWkt?: string;
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
      const wkt =
        args.geometryWkt ??
        (args.lat != null && args.lng != null ? `POINT(${args.lng} ${args.lat})` : null);
      const content = wkt ? `---\ngeometry: ${wkt}\n---\n` : "";
      try {
        // New file — chokidar fires `add` (not `change`), which populates the places
        // Map from disk. No barrier entry needed; raw writeFileSync is intentional.
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
        // .geojson files aren't in the chokidar glob (`*.md` only), so no change
        // event fires and no barrier entry is needed. Raw writeFileSync is intentional.
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
    "fs:write-frontmatter-properties",
    "fs:reorder-frontmatter",
    "properties:list-all-keys",
    "properties:values-for-key",
    "fs:rename-file",
    "fs:move-into",
    "fs:delete-path",
    "fs:reveal-in-finder",
    "fs:get-vault-root",
    "appearance:get",
    "appearance:set",
    "fs:create-folder",
    "fs:import-attachment",
    "fs:create-place-file",
    "places:query-bounds",
    "places:query-folder-all",
    "places:query-folder-bounds",
    "fs:read-geojson",
    "fs:geojson-files-in-folder",
    "fs:write-geojson-property"
  ] as const;

  async function stop(): Promise<void> {
    await Promise.all([watcher.close(), nonPlaceWatcher.close()]);
    for (const ch of WATCHER_HANDLE_CHANNELS) ipcMain.removeHandler(ch);
    ipcMain.removeAllListeners("places:request-initial");
    places.clear();
  }

  return { places, stop };
}
