/**
 * IPC for the embedded model manager: request/response handlers plus a streamed
 * `local-llm:download-progress` event for the renderer's progress bar. Model *selection* is not here
 * — it rides the AI active selection (`ai:set-active`); this surface only manages the catalog.
 */

import { type BrowserWindow, ipcMain } from "electron";
import type { DownloadProgress } from "../../shared/local-llm";
import { clearActiveIfEmbeddedModel } from "../ai";
import { broadcastAiChanged } from "../ai-ipc";
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  getHardware,
  listInstalled,
  listInterruptedDownloads,
  listRecommended
} from "./models";

const HANDLE_CHANNELS = [
  "local-llm:get-hardware",
  "local-llm:list-recommended",
  "local-llm:list-installed",
  "local-llm:download",
  "local-llm:cancel-download",
  "local-llm:delete"
] as const;

export function registerLocalLlmIpc(mainWindow: BrowserWindow): () => void {
  const sendProgress = (progress: DownloadProgress): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("local-llm:download-progress", progress);
    }
  };

  ipcMain.handle("local-llm:get-hardware", () => getHardware());
  ipcMain.handle("local-llm:list-recommended", () => listRecommended());
  ipcMain.handle("local-llm:list-installed", () => listInstalled());

  ipcMain.handle("local-llm:download", (_e, args: { id: string }) => downloadModel(args.id, sendProgress));

  ipcMain.handle("local-llm:cancel-download", (_e, args: { id: string }) => {
    cancelDownload(args.id);
    return { ok: true as const };
  });

  ipcMain.handle("local-llm:delete", (_e, args: { id: string }) => {
    const result = deleteModel(args.id);
    if (result.ok) {
      // If the deleted model was the active selection, drop it and refresh the tab + composer.
      clearActiveIfEmbeddedModel(args.id);
      broadcastAiChanged(mainWindow);
    }
    return result;
  });

  // A download interrupted by an app quit leaves a resumable partial on disk — pick it back up
  // automatically. The renderer just sees a regular in-flight download via the progress events,
  // so its progress bar and Cancel button work unchanged.
  for (const id of listInterruptedDownloads()) {
    void downloadModel(id, sendProgress);
  }

  return function unregister(): void {
    for (const ch of HANDLE_CHANNELS) ipcMain.removeHandler(ch);
  };
}
