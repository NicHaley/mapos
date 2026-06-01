import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import {
  type InstalledRegionPack,
  type RegionDownloadProgress,
  type RegionManifest,
  regionVersionDigest
} from "../shared/types";
import { invalidateServiceClient } from "./services/client";

// Build-time injected by electron-vite (declared in env.d.ts). Trailing slash
// stripped so URL joins are unambiguous.
const R2_BASE = (import.meta.env.MAIN_VITE_R2_PUBLIC_URL ?? "").replace(/\/+$/, "");

// Completeness marker written last after a successful download, so an interrupted
// download (whose .part files are cleaned up) never leaves a dir that looks installed.
const PACK_META_FILENAME = ".pack.json";
const MANIFEST_TTL_MS = 60_000;
const PROGRESS_THROTTLE_MS = 200;

let manifestCache: { at: number; data: RegionManifest } | null = null;

/** Active downloads keyed by region slug, so cancelDownload can abort them. */
const activeDownloads = new Map<string, AbortController>();

function regionsDirFor(appStateDir: string): string {
  return join(appStateDir, "regions");
}

/**
 * Tell the renderer the set of installed packs changed, so the map can reload its
 * offline style (the style URL is stable but its contents — sources/layers — grew
 * or shrank) and any region UI can refresh.
 */
function broadcastChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send("regions:changed");
}

/**
 * Fetch the region catalog from R2. Cached briefly so opening the Offline tab and
 * re-rendering doesn't re-hit the network on every keystroke. `force` bypasses it.
 */
export async function fetchManifest(force = false): Promise<RegionManifest> {
  if (!R2_BASE) {
    throw new Error("Region packs are not configured (MAIN_VITE_R2_PUBLIC_URL is unset).");
  }
  if (!force && manifestCache && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return manifestCache.data;
  }
  const res = await fetch(`${R2_BASE}/manifest.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch region manifest: HTTP ${res.status}`);
  const data = (await res.json()) as RegionManifest;
  if (!data || typeof data !== "object" || typeof data.regions !== "object") {
    throw new Error("Region manifest is malformed.");
  }
  manifestCache = { at: Date.now(), data };
  return data;
}

/** Region packs present on disk, read from their `.pack.json` sidecars. */
export function listLocal(regionsDir: string): InstalledRegionPack[] {
  if (!existsSync(regionsDir)) return [];
  const out: InstalledRegionPack[] = [];
  for (const region of readdirSync(regionsDir)) {
    const metaPath = join(regionsDir, region, PACK_META_FILENAME);
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Partial<InstalledRegionPack>;
      if (typeof meta.version !== "string") continue;
      out.push({
        region,
        version: meta.version,
        totalBytes: typeof meta.totalBytes === "number" ? meta.totalBytes : 0,
        installedAt: typeof meta.installedAt === "string" ? meta.installedAt : "",
        ...(typeof meta.contentHash === "string" ? { contentHash: meta.contentHash } : {}),
        ...(Array.isArray(meta.bbox) && meta.bbox.length === 4 ? { bbox: meta.bbox } : {})
      });
    } catch {
      /* unreadable sidecar — treat as not installed */
    }
  }
  return out;
}

/** Remove every leftover `.part` file in a dir (failed/aborted download cleanup). */
function cleanupParts(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".part")) rmSync(join(dir, f), { force: true });
  }
}

/**
 * Stream one artifact to `<dest>.part`, hashing as we go and applying backpressure.
 * Throws on HTTP error, abort, write error, or checksum mismatch — leaving the
 * caller to clean up the partial file.
 */
async function downloadArtifact(
  url: string,
  destPart: string,
  expectedSha: string,
  signal: AbortSignal,
  onChunk: (bytes: number) => void
): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const hash = createHash("sha256");
  const out = createWriteStream(destPart);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hash.update(buf);
      onChunk(buf.length);
      // write() returns false when the internal buffer is full — wait for drain
      // (or surface a write error) before pulling more from the network.
      if (!out.write(buf)) {
        await Promise.race([
          once(out, "drain"),
          once(out, "error").then(([e]) => {
            throw e;
          })
        ]);
      }
    }
    out.end();
    await once(out, "finish");
  } catch (e) {
    out.destroy();
    throw e;
  }
  if (hash.digest("hex") !== expectedSha) {
    throw new Error(`Checksum mismatch for ${url}`);
  }
}

/**
 * Download every artifact of a region pack to `.part` files, verify each checksum,
 * then atomically rename them into place and write the `.pack.json` marker last.
 * Progress streams to the renderer via `regions:download-progress`. Cancelling
 * (via {@link cancelDownload}) aborts in-flight fetches and cleans up partials; a
 * pre-existing installed pack is left untouched until every new artifact verifies.
 */
export async function downloadRegion(
  mainWindow: BrowserWindow,
  appStateDir: string,
  region: string,
  version?: string
): Promise<void> {
  const manifest = await fetchManifest();
  const entry = manifest.regions[region];
  if (!entry) throw new Error(`Unknown region "${region}".`);
  const ver = version ?? entry.latest;
  const versionEntry = entry.versions[ver];
  if (!versionEntry) throw new Error(`Region "${region}" has no version "${ver}".`);

  const dir = join(regionsDirFor(appStateDir), region);
  mkdirSync(dir, { recursive: true });

  // Refuse a second concurrent download of the same region: both would stream to
  // the same `.part` paths and interleave bytes, corrupting the pack.
  if (activeDownloads.has(region)) {
    throw new Error(`Region "${region}" is already downloading.`);
  }
  const controller = new AbortController();
  activeDownloads.set(region, controller);

  const totalBytes = versionEntry.total_bytes;
  let received = 0;
  let lastSent = 0;
  const send = (p: RegionDownloadProgress): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("regions:download-progress", p);
  };
  const emitDownloading = (): void => {
    const now = Date.now();
    if (now - lastSent < PROGRESS_THROTTLE_MS) return;
    lastSent = now;
    send({ region, receivedBytes: received, totalBytes, phase: "downloading" });
  };

  const renames: { part: string; final: string }[] = [];
  try {
    send({ region, receivedBytes: 0, totalBytes, phase: "downloading" });
    for (const artifact of Object.values(versionEntry.artifacts)) {
      const url = `${R2_BASE}/${versionEntry.path}/${artifact.file}`;
      const final = join(dir, artifact.file);
      const part = `${final}.part`;
      await downloadArtifact(url, part, artifact.sha256, controller.signal, (n) => {
        received += n;
        emitDownloading();
      });
      renames.push({ part, final });
    }

    // Everything verified — swap into place, then mark complete. The bbox is
    // copied from the manifest so offline region selection works without network.
    send({ region, receivedBytes: totalBytes, totalBytes, phase: "verifying" });
    for (const { part, final } of renames) renameSync(part, final);
    const meta: InstalledRegionPack = {
      region,
      version: ver,
      totalBytes,
      installedAt: new Date().toISOString(),
      contentHash: regionVersionDigest(versionEntry),
      ...(entry.bbox ? { bbox: entry.bbox } : {})
    };
    writeFileSync(join(dir, PACK_META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");

    // A freshly downloaded pack is immediately live — drop cached service handles
    // so the next request resolves against the new pack, and tell the renderer to
    // reload the map style so the new tiles appear without an app restart.
    invalidateServiceClient();
    broadcastChanged(mainWindow);
    send({ region, receivedBytes: totalBytes, totalBytes, phase: "done" });
  } catch (e) {
    cleanupParts(dir);
    const cancelled = controller.signal.aborted;
    send({
      region,
      receivedBytes: received,
      totalBytes,
      phase: "error",
      error: cancelled ? "cancelled" : e instanceof Error ? e.message : String(e)
    });
    // Cancellation is a normal outcome — resolve. Real failures reject so the
    // renderer's invoke() catch can surface them.
    if (!cancelled) throw e;
  } finally {
    // Only clear our own controller — a later download for this region may have
    // replaced it (e.g. after this one was cancelled and restarted).
    if (activeDownloads.get(region) === controller) activeDownloads.delete(region);
  }
}

export function cancelDownload(region: string): void {
  activeDownloads.get(region)?.abort();
  activeDownloads.delete(region);
}

/**
 * Delete a downloaded pack from disk. Cancels any in-flight download first, and
 * drops cached service handles (SQLite/Valhalla) *before* removing files so an
 * open handle can't block deletion (notably on Windows).
 */
export function deleteRegion(appStateDir: string, region: string): void {
  cancelDownload(region);
  invalidateServiceClient();
  rmSync(join(regionsDirFor(appStateDir), region), { recursive: true, force: true });
}

/**
 * Register renderer→main region-pack handlers. Vault-independent — registered once
 * for the lifetime of the window, alongside the other service IPCs.
 */
export function registerRegionPacksIpc(mainWindow: BrowserWindow, appStateDir: string): void {
  ipcMain.handle("regions:get-manifest", (_e, force?: boolean) => fetchManifest(!!force));
  ipcMain.handle("regions:list-local", () => listLocal(regionsDirFor(appStateDir)));
  ipcMain.handle(
    "regions:download",
    (_e, { region, version }: { region: string; version?: string }) =>
      downloadRegion(mainWindow, appStateDir, region, version)
  );
  ipcMain.handle("regions:cancel-download", (_e, region: string) => {
    cancelDownload(region);
  });
  ipcMain.handle("regions:delete", (_e, region: string) => {
    deleteRegion(appStateDir, region);
    broadcastChanged(mainWindow);
  });
}
