import { is } from "@electron-toolkit/utils";
import { type BrowserWindow, ipcMain } from "electron";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { autoUpdater } from "electron-updater";

const send = (win: BrowserWindow, channel: string, payload?: unknown): void => {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
};

export function setupUpdater(mainWindow: BrowserWindow): () => void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on("checking-for-update", () => send(mainWindow, "updater:checking"));
  autoUpdater.on("update-available", (info: UpdateInfo) =>
    send(mainWindow, "updater:available", { version: info.version, releaseDate: info.releaseDate })
  );
  autoUpdater.on("update-not-available", () => send(mainWindow, "updater:up-to-date"));
  autoUpdater.on("download-progress", (p: ProgressInfo) =>
    send(mainWindow, "updater:progress", { percent: p.percent })
  );
  autoUpdater.on("update-downloaded", (info: UpdateInfo) =>
    send(mainWindow, "updater:downloaded", { version: info.version })
  );
  autoUpdater.on("error", (err: Error) =>
    send(mainWindow, "updater:error", { message: err.message })
  );

  ipcMain.handle("updater:check", () => autoUpdater.checkForUpdates());
  ipcMain.handle("updater:install", () => autoUpdater.quitAndInstall());

  // Skip auto-check in dev: there's no signed build to install, and the placeholder URL
  // returns 404 noise. Devs can still trigger via the updater:check IPC if testing manually.
  if (!is.dev) {
    void autoUpdater.checkForUpdates().catch((err: unknown) => {
      send(mainWindow, "updater:error", {
        message: err instanceof Error ? err.message : String(err)
      });
    });
  }

  return () => {
    ipcMain.removeHandler("updater:check");
    ipcMain.removeHandler("updater:install");
    autoUpdater.removeAllListeners();
  };
}
