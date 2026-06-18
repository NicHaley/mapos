import { electronAPI } from "@electron-toolkit/preload";
import type {
  GeocodeForwardRequest,
  GeocodeResult,
  GeocodeReverseRequest,
  TileStyleRequest
} from "@mapos/contracts";
import { contextBridge, ipcRenderer } from "electron";
import type { ModelCapabilities } from "../shared/ai-models";
import type {
  AiState,
  FetchedModel,
  KnownProviderOption,
  ProviderInput
} from "../shared/ai-providers";
import type {
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatToolCallPayload,
  ChatToolResultPayload,
  InstalledRegionPack,
  MapOverlayLayer,
  PropertyType,
  RegionDownloadProgress,
  RegionManifest
} from "../shared/types";

// Custom APIs for renderer
const api = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>
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
    onOverlayClear: (cb: () => void) => ipcRenderer.on("map:overlay-clear", () => cb()),
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
    /** Overlay listeners are owned by App (shared with Chat); not cleared by MapView.removeListeners. */
    removeOverlayListeners: () => {
      ipcRenderer.removeAllListeners("map:overlay-add");
      ipcRenderer.removeAllListeners("map:overlay-clear");
    }
  },
  fs: {
    listDir: () => ipcRenderer.invoke("fs:list-dir"),
    readFile: (filePath: string) =>
      ipcRenderer.invoke("fs:read-file", filePath) as Promise<
        { raw: string; body: string; frontmatter: Record<string, unknown> } | { error: string }
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
        { canceled: true } | { ok: false; error: string } | { ok: true; vaults: string[] }
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
  ai: {
    getState: () => ipcRenderer.invoke("ai:get-state") as Promise<AiState>,
    getStatus: () =>
      ipcRenderer.invoke("ai:get-status") as Promise<{
        configured: boolean;
        activeProvider: "anthropic" | "local";
        model: string;
      }>,
    addProvider: (input: ProviderInput) =>
      ipcRenderer.invoke("ai:add-provider", input) as Promise<
        { ok: true; id: string } | { ok: false; error: string }
      >,
    updateProvider: (id: string, patch: ProviderInput) =>
      ipcRenderer.invoke("ai:update-provider", { id, patch }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    removeProvider: (id: string) =>
      ipcRenderer.invoke("ai:remove-provider", { id }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    setActive: (providerId: string, model: string, capabilities: ModelCapabilities) =>
      ipcRenderer.invoke("ai:set-active", { providerId, model, capabilities }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    clearActive: () => ipcRenderer.invoke("ai:clear-active") as Promise<{ ok: true }>,
    listModels: (providerId: string) =>
      ipcRenderer.invoke("ai:list-models", { providerId }) as Promise<
        { ok: true; models: FetchedModel[] } | { ok: false; error: string }
      >,
    testProvider: (input: ProviderInput, providerId?: string) =>
      ipcRenderer.invoke("ai:test-provider", { input, providerId }) as Promise<
        { ok: true; modelCount: number } | { ok: false; error: string }
      >,
    listKnownProviders: () =>
      ipcRenderer.invoke("ai:list-known-providers") as Promise<KnownProviderOption[]>,
    addKnownProvider: (provider: string) =>
      ipcRenderer.invoke("ai:add-known-provider", { provider }) as Promise<
        { ok: true; id: string } | { ok: false; error: string }
      >,
    setApiKey: (provider: string, key: string) =>
      ipcRenderer.invoke("ai:set-api-key", { provider, key }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    oauthLogin: (provider: string) =>
      ipcRenderer.invoke("ai:oauth-login", { provider }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    oauthCancel: () => ipcRenderer.invoke("ai:oauth-cancel") as Promise<{ ok: true }>,
    disconnect: (provider: string) =>
      ipcRenderer.invoke("ai:disconnect", { provider }) as Promise<{ ok: true }>,
    onOAuthProgress: (
      cb: (data: {
        provider: string;
        status: string;
        url?: string;
        userCode?: string;
        verificationUri?: string;
      }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        data: {
          provider: string;
          status: string;
          url?: string;
          userCode?: string;
          verificationUri?: string;
        }
      ): void => cb(data);
      ipcRenderer.on("ai:oauth-progress", listener);
      return () => {
        ipcRenderer.off("ai:oauth-progress", listener);
      };
    },
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on("ai:changed", listener);
      return () => {
        ipcRenderer.off("ai:changed", listener);
      };
    }
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
  chat: {
    send: (convId: string, message: string) => ipcRenderer.send("chat:send", { convId, message }),
    abort: (convId: string) => ipcRenderer.send("chat:abort", { convId }),
    loadConversation: (convId: string) => ipcRenderer.invoke("chat:load-conversation", convId),
    listConversations: () => ipcRenderer.invoke("chat:list-conversations"),
    deleteConversation: (id: string) => ipcRenderer.invoke("chat:delete-conversation", id),
    renameConversation: (id: string, title: string) =>
      ipcRenderer.invoke("chat:rename-conversation", id, title) as Promise<{
        success: boolean;
        error?: string;
      }>,
    onChunk: (cb: (data: ChatChunkPayload) => void) =>
      ipcRenderer.on("chat:chunk", (_e, d) => cb(d)),
    onThinkingChunk: (cb: (data: ChatChunkPayload) => void) =>
      ipcRenderer.on("chat:thinking_chunk", (_e, d) => cb(d)),
    onDone: (cb: (data: ChatDonePayload) => void) =>
      ipcRenderer.on("chat:done", (_e, data) => cb(data)),
    undo: (convId: string) => ipcRenderer.invoke("chat:undo", convId),
    onError: (cb: (data: ChatErrorPayload) => void) =>
      ipcRenderer.on("chat:error", (_e, d) => cb(d)),
    onToolCall: (cb: (data: ChatToolCallPayload) => void) =>
      ipcRenderer.on("chat:tool_call", (_e, d) => cb(d)),
    onToolResult: (cb: (data: ChatToolResultPayload) => void) =>
      ipcRenderer.on("chat:tool_result", (_e, d) => cb(d)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("chat:chunk");
      ipcRenderer.removeAllListeners("chat:thinking_chunk");
      ipcRenderer.removeAllListeners("chat:done");
      ipcRenderer.removeAllListeners("chat:error");
      ipcRenderer.removeAllListeners("chat:tool_call");
      ipcRenderer.removeAllListeners("chat:tool_result");
    }
  },
  services: {
    geocodingForward: (req: GeocodeForwardRequest) =>
      ipcRenderer.invoke("services:geocoding-forward", req) as Promise<GeocodeResult[]>,
    geocodingReverse: (req: GeocodeReverseRequest) =>
      ipcRenderer.invoke("services:geocoding-reverse", req) as Promise<GeocodeResult[]>,
    tilesStyleUrl: (req: TileStyleRequest) =>
      ipcRenderer.invoke("services:tiles-style-url", req) as Promise<string>
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
