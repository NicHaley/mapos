import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatToolCallPayload,
  ChatToolResultPayload,
  MapOverlayPayload,
  PropertyType
} from "../shared/types";

// Custom APIs for renderer
const api = {
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
    onOverlay: (cb: (data: MapOverlayPayload) => void) =>
      ipcRenderer.on("map:overlay", (_e, data) => cb(data)),
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
      ipcRenderer.removeAllListeners("map:overlay");
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
    getState: () =>
      ipcRenderer.invoke("onboarding:get-state") as Promise<{ pending: boolean }>,
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
  aiConfig: {
    getStatus: () =>
      ipcRenderer.invoke("ai-config:get-status") as Promise<{
        configured: boolean;
        activeProvider: "anthropic" | "local";
        model: string;
      }>,
    getSettingsState: () =>
      ipcRenderer.invoke("ai-config:get-settings-state") as Promise<{
        provider: "anthropic" | "local";
        anthropic: { model: string; hasApiKey: boolean };
        local: {
          mode: "magic" | "advanced";
          magic: { model: string };
          advanced: {
            endpoints: Array<{
              id: string;
              label: string;
              baseUrl: string;
              model: string;
              hasAuthToken: boolean;
            }>;
            activeId: string | null;
          };
        };
      }>,
    update: (
      update: {
        provider?: "anthropic" | "local";
        anthropic?: { model?: string; apiKey?: string | null };
        local?: {
          mode?: "magic" | "advanced";
          magic?: { model?: string };
          advanced?: { activeId?: string | null };
        };
      }
    ) =>
      ipcRenderer.invoke("ai-config:update", update) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    testConnection: (draft: {
      provider: "anthropic" | "local";
      apiKey?: string;
      baseUrl?: string;
      authToken?: string;
      model?: string;
    }) =>
      ipcRenderer.invoke("ai-config:test-connection", draft) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    addCustomEndpoint: (input: {
      label?: string;
      baseUrl?: string;
      model?: string;
      authToken?: string | null;
    }) =>
      ipcRenderer.invoke("ai-config:add-endpoint", input) as Promise<
        { ok: true; id: string } | { ok: false; error: string }
      >,
    updateCustomEndpoint: (
      id: string,
      patch: {
        label?: string;
        baseUrl?: string;
        model?: string;
        authToken?: string | null;
      }
    ) =>
      ipcRenderer.invoke("ai-config:update-endpoint", { id, patch }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    removeCustomEndpoint: (id: string) =>
      ipcRenderer.invoke("ai-config:remove-endpoint", { id }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    ollamaDetect: (baseUrl: string) =>
      ipcRenderer.invoke("ai-config:ollama-detect", baseUrl) as Promise<{
        running: boolean;
        baseUrl: string;
      }>,
    ollamaListInstalled: (baseUrl: string) =>
      ipcRenderer.invoke("ai-config:ollama-list-installed", baseUrl) as Promise<string[]>,
    ollamaPull: (baseUrl: string, modelId: string) =>
      ipcRenderer.invoke("ai-config:ollama-pull", { baseUrl, modelId }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    ollamaCancelPull: (baseUrl: string, modelId: string) =>
      ipcRenderer.invoke("ai-config:ollama-cancel-pull", { baseUrl, modelId }) as Promise<{
        ok: true;
      }>,
    ollamaGetPendingPulls: () =>
      ipcRenderer.invoke("ai-config:ollama-get-pending-pulls") as Promise<
        Array<{ baseUrl: string; modelId: string; active: boolean }>
      >,
    ollamaDelete: (baseUrl: string, modelId: string) =>
      ipcRenderer.invoke("ai-config:ollama-delete", { baseUrl, modelId }) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    onPullProgress: (
      cb: (data: { modelId: string; percent?: number; status?: string }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        data: { modelId: string; percent?: number; status?: string }
      ): void => cb(data);
      ipcRenderer.on("ollama:pull-progress", listener);
      return () => {
        ipcRenderer.off("ollama:pull-progress", listener);
      };
    },
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on("ai-config:changed", listener);
      return () => {
        ipcRenderer.off("ai-config:changed", listener);
      };
    }
  },
  chat: {
    send: (convId: string, message: string) =>
      ipcRenderer.send("chat:send", { convId, message }),
    abort: (convId: string) => ipcRenderer.send("chat:abort", { convId }),
    loadConversation: (convId: string) => ipcRenderer.invoke("chat:load-conversation", convId),
    listConversations: () => ipcRenderer.invoke("chat:list-conversations"),
    deleteConversation: (id: string) => ipcRenderer.invoke("chat:delete-conversation", id),
    clearOverlay: (convId: string) => ipcRenderer.send("chat:clear-overlay", { convId }),
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
