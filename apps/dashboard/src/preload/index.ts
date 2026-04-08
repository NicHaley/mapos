import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import type {
  ChatToolCallPayload,
  ChatToolResultPayload,
  MapOverlayPayload
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
        | { raw: string; body: string; frontmatter: Record<string, unknown> }
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
    createNoteFile: (args: { parentFolderPath: string | null; lat?: number; lng?: number }) =>
      ipcRenderer.invoke("fs:create-place-file", args) as Promise<
        { success: true; filePath: string } | { success: false; error: string }
      >,
    getVaultRoot: () => ipcRenderer.invoke("fs:get-vault-root") as Promise<string>,
    createFolder: (args: { parentFolderPath: string; folderName: string }) =>
      ipcRenderer.invoke("fs:create-folder", args) as Promise<
        { success: true; folderPath: string } | { success: false; error: string }
      >,
    onChange: (cb: () => void) => ipcRenderer.on("fs:changed", cb),
    removeListeners: () => ipcRenderer.removeAllListeners("fs:changed")
  },
  properties: {
    listAllKeys: () => ipcRenderer.invoke("properties:list-all-keys") as Promise<string[]>,
    valuesForKey: (key: string) =>
      ipcRenderer.invoke("properties:values-for-key", key) as Promise<string[]>
  },
  chat: {
    send: (message: string) => ipcRenderer.send("chat:send", message),
    abort: () => ipcRenderer.send("chat:abort"),
    reset: () => ipcRenderer.send("chat:reset"),
    loadHistory: () => ipcRenderer.invoke("chat:load-history"),
    listConversations: () => ipcRenderer.invoke("chat:list-conversations"),
    switchConversation: (id: string) => ipcRenderer.invoke("chat:switch-conversation", id),
    deleteConversation: (id: string) => ipcRenderer.invoke("chat:delete-conversation", id),
    clearOverlay: () => ipcRenderer.send("chat:clear-overlay"),
    onChunk: (cb: (text: string) => void) => ipcRenderer.on("chat:chunk", (_e, t) => cb(t)),
    onThinkingChunk: (cb: (text: string) => void) =>
      ipcRenderer.on("chat:thinking_chunk", (_e, t) => cb(t)),
    onDone: (cb: (data: { canUndo: boolean }) => void) =>
      ipcRenderer.on("chat:done", (_e, data) => cb(data)),
    undo: () => ipcRenderer.invoke("chat:undo"),
    onError: (cb: (msg: string) => void) => ipcRenderer.on("chat:error", (_e, m) => cb(m)),
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
