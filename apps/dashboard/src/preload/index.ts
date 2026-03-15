import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";

// Custom APIs for renderer
const api = {
  places: {
    requestInitial: () => ipcRenderer.send("places:request-initial"),
    queryBounds: (bounds: { north: number; south: number; east: number; west: number }) =>
      ipcRenderer.invoke("places:query-bounds", bounds),
    onInitial: (cb: (places: unknown[]) => void) =>
      ipcRenderer.on("places:initial", (_e, p) => cb(p)),
    onUpdated: (cb: (u: unknown) => void) => ipcRenderer.on("places:updated", (_e, u) => cb(u)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("places:initial");
      ipcRenderer.removeAllListeners("places:updated");
    }
  },
  map: {
    onOverlay: (
      cb: (data: {
        layerName: string;
        points: Array<{ id: string; lat: number; lng: number; title: string }>;
        lines: Array<{ id: string; coordinates: [number, number][]; title?: string }>;
        polygons: Array<{ id: string; coordinates: [number, number][][]; title?: string }>;
      }) => void
    ) => ipcRenderer.on("map:overlay", (_e, data) => cb(data)),
    onOverlayClear: (cb: () => void) => ipcRenderer.on("map:overlay-clear", () => cb()),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("map:overlay");
      ipcRenderer.removeAllListeners("map:overlay-clear");
    }
  },
  fs: {
    listDir: () => ipcRenderer.invoke("fs:list-dir"),
    onChange: (cb: () => void) => ipcRenderer.on("fs:changed", cb),
    removeListeners: () => ipcRenderer.removeAllListeners("fs:changed")
  },
  chat: {
    send: (message: string) => ipcRenderer.send("chat:send", message),
    abort: () => ipcRenderer.send("chat:abort"),
    reset: () => ipcRenderer.send("chat:reset"),
    onChunk: (cb: (text: string) => void) =>
      ipcRenderer.on("chat:chunk", (_e, t) => cb(t)),
    onDone: (cb: () => void) => ipcRenderer.on("chat:done", cb),
    onError: (cb: (msg: string) => void) =>
      ipcRenderer.on("chat:error", (_e, m) => cb(m)),
    removeListeners: () => {
      ipcRenderer.removeAllListeners("chat:chunk");
      ipcRenderer.removeAllListeners("chat:done");
      ipcRenderer.removeAllListeners("chat:error");
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
