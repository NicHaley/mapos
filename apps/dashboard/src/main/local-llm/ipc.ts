/**
 * IPC for the embedded model manager: request/response handlers plus a streamed
 * `local-llm:download-progress` event for the renderer's progress bar.
 */

import { type BrowserWindow, ipcMain } from "electron";
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  getHardware,
  getSelectedModel,
  listInstalled,
  listRecommended,
  setSelectedModel
} from "./models";

const HANDLE_CHANNELS = [
  "local-llm:get-hardware",
  "local-llm:list-recommended",
  "local-llm:list-installed",
  "local-llm:download",
  "local-llm:cancel-download",
  "local-llm:delete",
  "local-llm:get-selected",
  "local-llm:select"
] as const;

export function registerLocalLlmIpc(mainWindow: BrowserWindow): () => void {
  ipcMain.handle("local-llm:get-hardware", () => getHardware());
  ipcMain.handle("local-llm:list-recommended", () => listRecommended());
  ipcMain.handle("local-llm:list-installed", () => listInstalled());

  ipcMain.handle("local-llm:download", (_e, args: { id: string }) =>
    downloadModel(args.id, (progress) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("local-llm:download-progress", progress);
      }
    })
  );

  ipcMain.handle("local-llm:cancel-download", (_e, args: { id: string }) => {
    cancelDownload(args.id);
    return { ok: true as const };
  });

  ipcMain.handle("local-llm:delete", (_e, args: { id: string }) => deleteModel(args.id));

  // The selected model is the active embedded model id, or null. We return just the id (the renderer
  // already has the catalog from list-recommended) — the path/capabilities stay in main.
  ipcMain.handle("local-llm:get-selected", () => getSelectedModel()?.id ?? null);

  ipcMain.handle("local-llm:select", (_e, args: { id: string | null }) => {
    const result = setSelectedModel(args.id);
    if (result.ok && !mainWindow.isDestroyed()) {
      // Reuse the existing ai-config signal so the chat composer re-checks configured state.
      mainWindow.webContents.send("ai-config:changed");
    }
    return result;
  });

  return function unregister(): void {
    for (const ch of HANDLE_CHANNELS) ipcMain.removeHandler(ch);
  };
}
