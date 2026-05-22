import { is } from "@electron-toolkit/utils";
import { type BrowserWindow, ipcMain } from "electron";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { autoUpdater } from "electron-updater";

const send = (win: BrowserWindow, channel: string, payload?: unknown): void => {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
};

// Tracks whether the current check was triggered by the user (menu item / IPC).
// Manual checks emit `updater:manual-result` so the banner can show transient
// "checking / up-to-date / error" feedback. Automatic background checks stay
// silent unless an update is actually available.
let manualCheckInFlight = false;
let manualCheckTimeoutId: NodeJS.Timeout | null = null;
let activeWindow: BrowserWindow | null = null;

// Guard against silent hangs: electron-updater's `checkForUpdates()` can resolve
// without firing any lifecycle event (e.g. in dev when forceDevUpdateConfig is
// off, or when the network stalls). Without a ceiling the banner sits at
// "Checking…" forever.
const MANUAL_CHECK_TIMEOUT_MS = 15_000;

function clearManualCheck(): void {
  manualCheckInFlight = false;
  if (manualCheckTimeoutId) {
    clearTimeout(manualCheckTimeoutId);
    manualCheckTimeoutId = null;
  }
}

export function checkForUpdatesManually(): void {
  if (!activeWindow || activeWindow.isDestroyed()) return;
  manualCheckInFlight = true;
  if (manualCheckTimeoutId) clearTimeout(manualCheckTimeoutId);
  manualCheckTimeoutId = setTimeout(() => {
    if (!manualCheckInFlight || !activeWindow || activeWindow.isDestroyed()) return;
    send(activeWindow, "updater:manual-result", {
      status: "error",
      message: "Update check timed out."
    });
    clearManualCheck();
  }, MANUAL_CHECK_TIMEOUT_MS);

  send(activeWindow, "updater:manual-result", { status: "checking" });
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    if (!manualCheckInFlight || !activeWindow || activeWindow.isDestroyed()) return;
    const message = err instanceof Error ? err.message : String(err);
    send(activeWindow, "updater:manual-result", { status: "error", message });
    clearManualCheck();
  });
}

export function setupUpdater(mainWindow: BrowserWindow): () => void {
  activeWindow = mainWindow;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // In dev (unpackaged) `checkForUpdates()` is a no-op by default — it returns
  // null without firing events, which leaves the manual-check UI stuck. Setting
  // this forces electron-updater to honour `dev-app-update.yml` so the manual
  // "Check for Updates…" menu item actually performs a real HTTP check. The
  // download/install still can't run in dev, but the check + feedback can.
  if (is.dev) autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.on("checking-for-update", () => send(mainWindow, "updater:checking"));
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    send(mainWindow, "updater:available", {
      version: info.version,
      releaseDate: info.releaseDate
    });
    // Available → existing download flow takes over the banner; clear the manual flag.
    clearManualCheck();
  });
  autoUpdater.on("update-not-available", () => {
    send(mainWindow, "updater:up-to-date");
    if (manualCheckInFlight) {
      send(mainWindow, "updater:manual-result", { status: "up-to-date" });
      clearManualCheck();
    }
  });
  autoUpdater.on("download-progress", (p: ProgressInfo) =>
    send(mainWindow, "updater:progress", { percent: p.percent })
  );
  autoUpdater.on("update-downloaded", (info: UpdateInfo) =>
    send(mainWindow, "updater:downloaded", { version: info.version })
  );
  autoUpdater.on("error", (err: Error) => {
    send(mainWindow, "updater:error", { message: err.message });
    if (manualCheckInFlight) {
      send(mainWindow, "updater:manual-result", { status: "error", message: err.message });
      clearManualCheck();
    }
  });

  ipcMain.handle("updater:check", () => {
    checkForUpdatesManually();
  });
  ipcMain.handle("updater:install", () => autoUpdater.quitAndInstall());

  // Skip auto-check in dev: there's no signed build to install, and the placeholder URL
  // returns 404 noise. Devs can still trigger via the menu / updater:check IPC.
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
    activeWindow = null;
    clearManualCheck();
  };
}
