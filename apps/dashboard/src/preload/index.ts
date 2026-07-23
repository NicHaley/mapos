import { electronAPI } from "@electron-toolkit/preload";
import type {
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest,
  Route,
  RouteDirectionsRequest,
  TileStyleRequest
} from "@mapos/contracts";
import { contextBridge, ipcRenderer } from "electron";
import type {
  InstalledRegionPack,
  MapOverlayLayer,
  McpClientInfo,
  McpConnectionInfo,
  PropertyType,
  RegionDownloadProgress,
  RegionManifest
} from "../shared/types";

// Custom APIs for renderer
const api = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke("clipboard:write-text", text) as Promise<void>
  },
  places: {
    requestInitial: () => ipcRenderer.send("places:request-initial"),
    queryBounds: (bounds: { north: number; south: number; east: number; west: number }) =>
      ipcRenderer.invoke("places:query-bounds", bounds),
    queryFolderAll: (folderPath: string) =>
      ipcRenderer.invoke("places:query-folder-all", folderPath),
    queryFolderBounds: (args: {
      folderPath: string;
      bounds: { north: number; south: number; east: number; west: number };
    }) => ipcRenderer.invoke("places:query-folder-bounds", args),
    getByPath: (filePath: string) => ipcRenderer.invoke("places:get-by-path", filePath),
    onInitial: (cb: (places: unknown[]) => void) =>
      ipcRenderer.on("places:initial", (_e, p) => cb(p)),
    onUpdated: (cb: (u: unknown) => void) => ipcRenderer.on("places:updated", (_e, u) => cb(u)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("places:initial");
      ipcRenderer.removeAllListeners("places:updated");
    }
  },
  map: {
    onOverlayAdd: (cb: (layer: MapOverlayLayer) => void) =>
      ipcRenderer.on("map:overlay-add", (_e, layer) => cb(layer)),
    sendViewport: (data: {
      north: number;
      south: number;
      east: number;
      west: number;
      centerLat: number;
      centerLng: number;
      zoom: number;
    }) => ipcRenderer.send("map:viewport-update", data),
    onPanTo: (cb: (data: { lat: number; lng: number; zoom?: number }) => void) =>
      ipcRenderer.on("map:pan-to", (_e, data) => cb(data)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("map:pan-to");
      ipcRenderer.removeAllListeners("map:viewport-update");
    },
    /** Overlay listener is owned by App; not cleared by MapView.removeListeners. */
    removeOverlayListeners: () => {
      ipcRenderer.removeAllListeners("map:overlay-add");
    }
  },
  nav: {
    sendNavState: (data: {
      active: { path: string; kind: "place" | "folder"; title: string } | null;
      activeIndex: number;
      tabs: Array<{ path: string; kind: "place" | "folder"; title: string }>;
    }) => ipcRenderer.send("nav:state-update", data),
    onOpenFile: (cb: (data: { path: string }) => void) =>
      ipcRenderer.on("nav:open-file", (_e, data) => cb(data)),
    /** Agent `present_directions`: open a Directions tab for the given endpoints.
     * `origin: null` → the renderer defaults to the user's current location. */
    onOpenDirections: (
      cb: (data: {
        origin: { lat: number; lng: number; label: string } | null;
        destination: { lat: number; lng: number; label: string };
        mode: "auto" | "pedestrian" | "bicycle";
      }) => void
    ) => ipcRenderer.on("nav:open-directions", (_e, data) => cb(data)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("nav:open-file");
      ipcRenderer.removeAllListeners("nav:open-directions");
    }
  },
  geo: {
    /** Main asks the renderer for a fresh geolocation fix (correlated by `id`).
     * `reveal` = also drop the marker + fly to it, like the "My location" button. */
    onLocateRequest: (cb: (data: { id: string; reveal: boolean }) => void) =>
      ipcRenderer.on("geo:locate-request", (_e, data) => cb(data)),
    /** Renderer returns the fix (or an error) for the matching request `id`. */
    sendLocateReply: (
      data:
        | { id: string; ok: true; lat: number; lng: number; accuracy: number }
        | { id: string; ok: false; error: string }
    ) => ipcRenderer.send("geo:locate-reply", data),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("geo:locate-request");
    }
  },
  fs: {
    listDir: () => ipcRenderer.invoke("fs:list-dir"),
    readFile: (filePath: string) =>
      ipcRenderer.invoke("fs:read-file", filePath) as Promise<
        | {
            raw: string;
            body: string;
            frontmatter: Record<string, unknown>;
            cover?: string;
            coverSource?: string;
          }
        | { error: string }
      >,
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke("fs:write-file", filePath, content) as Promise<{
        success: boolean;
        error?: string;
      }>,
    writePlaceBody: (filePath: string, body: string) =>
      ipcRenderer.invoke("fs:write-place-body", filePath, body) as Promise<{
        success: boolean;
        error?: string;
      }>,
    writeFrontmatterProperty: (filePath: string, key: string, value: unknown) =>
      ipcRenderer.invoke("fs:write-frontmatter-property", filePath, key, value) as Promise<{
        success: boolean;
        error?: string;
      }>,
    writeFrontmatterProperties: (filePath: string, properties: Record<string, unknown>) =>
      ipcRenderer.invoke("fs:write-frontmatter-properties", filePath, properties) as Promise<{
        success: boolean;
        error?: string;
      }>,
    reorderFrontmatter: (filePath: string, keyOrder: string[]) =>
      ipcRenderer.invoke("fs:reorder-frontmatter", filePath, keyOrder) as Promise<{
        success: boolean;
        error?: string;
      }>,
    renameFile: (oldPath: string, newName: string) =>
      ipcRenderer.invoke("fs:rename-file", oldPath, newName) as Promise<
        { success: true; newPath: string } | { success: false; error: string }
      >,
    moveInto: (sourcePath: string, destinationFolderPath: string) =>
      ipcRenderer.invoke("fs:move-into", sourcePath, destinationFolderPath) as Promise<
        { success: true; newPath: string } | { success: false; error: string }
      >,
    deletePath: (targetPath: string) =>
      ipcRenderer.invoke("fs:delete-path", targetPath) as Promise<
        { success: true } | { success: false; error: string }
      >,
    revealInFinder: (targetPath: string) => ipcRenderer.invoke("fs:reveal-in-finder", targetPath),
    createNoteFile: (args: {
      parentFolderPath: string | null;
      lat?: number;
      lng?: number;
      geometryWkt?: string;
      includePlaceFrontmatterDefaults?: boolean;
    }) =>
      ipcRenderer.invoke("fs:create-place-file", args) as Promise<
        { success: true; filePath: string } | { success: false; error: string }
      >,
    getVaultRoot: () => ipcRenderer.invoke("fs:get-vault-root") as Promise<string>,
    createFolder: (args: { parentFolderPath: string; folderName: string }) =>
      ipcRenderer.invoke("fs:create-folder", args) as Promise<
        { success: true; folderPath: string } | { success: false; error: string }
      >,
    importAttachment: (args: { suggestedName?: string; bytes: Uint8Array }) =>
      ipcRenderer.invoke("fs:import-attachment", args) as Promise<
        { success: true; relPath: string; absPath: string } | { success: false; error: string }
      >,
    readGeoJson: (filePath: string) =>
      ipcRenderer.invoke("fs:read-geojson", filePath) as Promise<Record<string, unknown> | null>,
    geoJsonFilesInFolder: (folderPath: string) =>
      ipcRenderer.invoke("fs:geojson-files-in-folder", folderPath) as Promise<string[]>,
    writeGeoJsonProperty: (filePath: string, key: string, value: unknown) =>
      ipcRenderer.invoke("fs:write-geojson-property", filePath, key, value) as Promise<{
        success: boolean;
        error?: string;
      }>,
    onChange: (cb: () => void) => ipcRenderer.on("fs:changed", cb),
    /** Returns a cleanup function; call it (e.g. from a useEffect) to unregister. */
    onFileContentChanged: (cb: (payload: { filePath: string }) => void): (() => void) => {
      const listener = (_e: unknown, p: { filePath: string }): void => cb(p);
      ipcRenderer.on("fs:file-content-changed", listener);
      return () => {
        ipcRenderer.off("fs:file-content-changed", listener);
      };
    },
    removeListeners: (): void => {
      ipcRenderer.removeAllListeners("fs:changed");
    }
  },
  appearance: {
    get: () => ipcRenderer.invoke("appearance:get") as Promise<Record<string, unknown>>,
    set: (patch: { accent?: string | null; mapColor?: string | null; theme?: string | null }) =>
      ipcRenderer.invoke("appearance:set", patch) as Promise<
        { ok: true } | { ok: false; error: string }
      >
  },
  onboarding: {
    getState: () => ipcRenderer.invoke("onboarding:get-state") as Promise<{ pending: boolean }>,
    pickCreateLocation: (name: string) =>
      ipcRenderer.invoke("onboarding:pick-create-location", name) as Promise<
        | { canceled: true }
        | { ok: false; error: string }
        | { ok: true; targetPath: string; parentPath: string }
      >,
    pickExistingVault: () =>
      ipcRenderer.invoke("onboarding:pick-existing-vault") as Promise<
        { canceled: true } | { ok: false; error: string } | { ok: true; path: string }
      >,
    complete: (
      draft:
        | { kind: "create"; targetPath: string; name: string }
        | { kind: "existing"; path: string }
    ) =>
      ipcRenderer.invoke("onboarding:complete", draft) as Promise<
        { ok: true } | { ok: false; error: string }
      >
  },
  mapos: {
    getVaultsConfig: () =>
      ipcRenderer.invoke("mapos:get-vaults-config") as Promise<{
        vaults: string[];
        activeVaultPath: string;
      }>,
    setFolderAsVault: () =>
      ipcRenderer.invoke("mapos:set-folder-as-vault") as Promise<
        | { canceled: true }
        | { ok: false; error: string }
        | { ok: true; path: string; vaults: string[] }
      >,
    createNewVault: (name: string) =>
      ipcRenderer.invoke("mapos:create-new-vault", name) as Promise<
        | { canceled: true }
        | { ok: false; error: string }
        | { ok: true; path: string; vaults: string[] }
      >,
    switchVault: (vaultPath: string) =>
      ipcRenderer.invoke("mapos:switch-vault", vaultPath) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    renameVault: (newName: string) =>
      ipcRenderer.invoke("mapos:rename-vault", newName) as Promise<
        { ok: true; newPath: string } | { ok: false; error: string }
      >,
    deleteVault: () =>
      ipcRenderer.invoke("mapos:delete-vault") as Promise<
        { ok: true } | { ok: false; error: string }
      >
  },
  mcp: {
    getConnectionInfo: () =>
      ipcRenderer.invoke("mcp:get-connection-info") as Promise<McpConnectionInfo>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("mcp:set-enabled", enabled) as Promise<McpConnectionInfo>,
    regenerateToken: () => ipcRenderer.invoke("mcp:regenerate-token") as Promise<McpConnectionInfo>,
    /** Fires when a client completes the MCP handshake. Returns a cleanup fn to unregister. */
    onClientConnected: (cb: (client: McpClientInfo) => void): (() => void) => {
      const listener = (_e: unknown, client: McpClientInfo): void => cb(client);
      ipcRenderer.on("mcp:client-connected", listener);
      return () => {
        ipcRenderer.off("mcp:client-connected", listener);
      };
    }
  },
  properties: {
    listAllKeys: () =>
      ipcRenderer.invoke("properties:list-all-keys") as Promise<
        Array<{ key: string; type: PropertyType }>
      >,
    valuesForKey: (key: string) =>
      ipcRenderer.invoke("properties:values-for-key", key) as Promise<string[]>
  },
  window: {
    isFullscreen: () => ipcRenderer.invoke("window:is-fullscreen") as Promise<boolean>,
    onFullscreenChange: (cb: (isFullscreen: boolean) => void): (() => void) => {
      const listener = (_e: unknown, value: boolean): void => cb(value);
      ipcRenderer.on("window:fullscreen-change", listener);
      return () => {
        ipcRenderer.off("window:fullscreen-change", listener);
      };
    }
  },
  system: {
    openLocationSettings: () =>
      ipcRenderer.invoke("system:open-location-settings") as Promise<{ ok: boolean }>
  },
  updater: {
    install: () => ipcRenderer.invoke("updater:install") as Promise<void>,
    retry: () => ipcRenderer.invoke("updater:retry") as Promise<void>,
    check: () =>
      ipcRenderer.invoke("updater:check") as Promise<
        | { ok: true; current: string; latest: string; available: boolean }
        | { ok: false; current: string; error: string }
      >,
    onAvailable: (cb: (data: { version: string; releaseDate: string }) => void): (() => void) => {
      const listener = (_e: unknown, data: { version: string; releaseDate: string }): void =>
        cb(data);
      ipcRenderer.on("updater:available", listener);
      return () => {
        ipcRenderer.off("updater:available", listener);
      };
    },
    onDownloaded: (cb: (data: { version: string }) => void): (() => void) => {
      const listener = (_e: unknown, data: { version: string }): void => cb(data);
      ipcRenderer.on("updater:downloaded", listener);
      return () => {
        ipcRenderer.off("updater:downloaded", listener);
      };
    },
    onProgress: (cb: (data: { percent: number }) => void): (() => void) => {
      const listener = (_e: unknown, data: { percent: number }): void => cb(data);
      ipcRenderer.on("updater:progress", listener);
      return () => {
        ipcRenderer.off("updater:progress", listener);
      };
    },
    onError: (cb: (data: { message: string }) => void): (() => void) => {
      const listener = (_e: unknown, data: { message: string }): void => cb(data);
      ipcRenderer.on("updater:error", listener);
      return () => {
        ipcRenderer.off("updater:error", listener);
      };
    }
  },
  services: {
    geocodingForward: (req: GeocodeForwardRequest) =>
      ipcRenderer.invoke("services:geocoding-forward", req) as Promise<GeocodeResult[]>,
    geocodingReverse: (req: GeocodeReverseRequest) =>
      ipcRenderer.invoke("services:geocoding-reverse", req) as Promise<GeocodeResult[]>,
    routingDirections: (req: RouteDirectionsRequest) =>
      ipcRenderer.invoke("services:routing-directions", req) as Promise<Route>,
    tilesStyleUrl: (req: TileStyleRequest) =>
      ipcRenderer.invoke("services:tiles-style-url", req) as Promise<string>
  },
  wiki: {
    imageLookup: (qid: string) =>
      ipcRenderer.invoke("wiki:image-lookup", qid) as Promise<{
        thumbUrl: string;
        fileName: string;
        pageUrl: string;
      } | null>,
    importImage: (qid: string) =>
      ipcRenderer.invoke("wiki:import-image", qid) as Promise<
        { success: true; relPath: string; pageUrl: string } | { success: false; error: string }
      >
  },
  regions: {
    getManifest: (force?: boolean) =>
      ipcRenderer.invoke("regions:get-manifest", force) as Promise<RegionManifest>,
    listLocal: () => ipcRenderer.invoke("regions:list-local") as Promise<InstalledRegionPack[]>,
    download: (region: string, version?: string) =>
      ipcRenderer.invoke("regions:download", { region, version }) as Promise<void>,
    cancelDownload: (region: string) =>
      ipcRenderer.invoke("regions:cancel-download", region) as Promise<void>,
    delete: (region: string) => ipcRenderer.invoke("regions:delete", region) as Promise<void>,
    onProgress: (cb: (data: RegionDownloadProgress) => void): (() => void) => {
      const listener = (_e: unknown, data: RegionDownloadProgress): void => cb(data);
      ipcRenderer.on("regions:download-progress", listener);
      return () => {
        ipcRenderer.off("regions:download-progress", listener);
      };
    },
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on("regions:changed", listener);
      return () => {
        ipcRenderer.off("regions:changed", listener);
      };
    }
  }
};

export type PreloadApi = typeof api;

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.api = api;
}
