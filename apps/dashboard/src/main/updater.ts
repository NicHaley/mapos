import { is } from "@electron-toolkit/utils";
import {
  type BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeImage
} from "electron";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import { autoUpdater } from "electron-updater";
import iconPng from "../../resources/icon.png?asset";

const send = (win: BrowserWindow, channel: string, payload?: unknown): void => {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
};

// Menu item id wired up in app-menu.ts. We mutate label + enabled state directly
// while a manual check is in flight to match the standard macOS pattern (the
// "Check for Updates" item becomes "Checking for Updates…" and is disabled).
const MENU_ITEM_ID = "check-for-updates";

// Tracks whether the current check was triggered by the user (menu item / IPC).
// Manual checks surface a native dialog with the result. Background auto-checks
// stay silent unless an update is actually available.
let manualCheckInFlight = false;
let manualCheckTimeoutId: NodeJS.Timeout | null = null;
let activeWindow: BrowserWindow | null = null;

// Guard against silent hangs: electron-updater's `checkForUpdates()` can resolve
// without firing any lifecycle event (e.g. network stalls). Without a ceiling
// the menu item sits in its disabled "Checking…" state forever.
const MANUAL_CHECK_TIMEOUT_MS = 15_000;

const updateDialogIcon = nativeImage.createFromPath(iconPng);

function setMenuChecking(checking: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(MENU_ITEM_ID);
  if (!item) return;
  item.enabled = !checking;
  item.label = checking ? "Checking for Updates…" : "Check for Updates…";
}

function showResultDialog(opts: {
  type?: "info" | "warning";
  message: string;
  detail?: string;
}): void {
  if (!activeWindow || activeWindow.isDestroyed()) return;
  void dialog.showMessageBox(activeWindow, {
    type: opts.type ?? "info",
    icon: updateDialogIcon,
    message: opts.message,
    detail: opts.detail,
    buttons: ["OK"],
    defaultId: 0,
    noLink: true
  });
}

function clearManualCheck(): void {
  manualCheckInFlight = false;
  if (manualCheckTimeoutId) {
    clearTimeout(manualCheckTimeoutId);
    manualCheckTimeoutId = null;
  }
  setMenuChecking(false);
}

export function checkForUpdatesManually(): void {
  if (!activeWindow || activeWindow.isDestroyed()) return;
  if (manualCheckInFlight) return;
  manualCheckInFlight = true;
  setMenuChecking(true);
  if (manualCheckTimeoutId) clearTimeout(manualCheckTimeoutId);
  manualCheckTimeoutId = setTimeout(() => {
    if (!manualCheckInFlight) return;
    showResultDialog({
      type: "warning",
      message: "Couldn't check for updates.",
      detail: "The update check timed out. Check your internet connection and try again."
    });
    clearManualCheck();
  }, MANUAL_CHECK_TIMEOUT_MS);

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    if (!manualCheckInFlight) return;
    const message = err instanceof Error ? err.message : String(err);
    showResultDialog({
      type: "warning",
      message: "Couldn't check for updates.",
      detail: message
    });
    clearManualCheck();
  });
}

export function setupUpdater(mainWindow: BrowserWindow): () => void {
  activeWindow = mainWindow;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // In dev (unpackaged) `checkForUpdates()` is a no-op by default — it returns
  // null without firing events, which leaves the menu in its "Checking…" state.
  // `forceDevUpdateConfig` makes electron-updater honour `dev-app-update.yml`
  // so the manual "Check for Updates…" menu item performs a real HTTP check.
  //
  // We also disable autoDownload in dev: the download would succeed, but
  // Squirrel.Mac's install step refuses because the dev binary is Electron
  // (com.github.Electron) and the published bundle has a different identifier.
  // Stopping at "available" lets the UI be tested without a Squirrel error.
  if (is.dev) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;
  }

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    if (is.dev) {
      if (manualCheckInFlight) {
        showResultDialog({
          message: `Update ${info.version} is available.`,
          detail:
            "Installing updates requires a packaged build, so the install step is skipped in dev mode."
        });
        clearManualCheck();
      }
      return;
    }
    // Prod: kick off the in-app download/restart banner.
    send(mainWindow, "updater:available", {
      version: info.version,
      releaseDate: info.releaseDate
    });
    if (manualCheckInFlight) {
      showResultDialog({
        message: `Update ${info.version} is available.`,
        detail:
          "It will be downloaded in the background. You'll be notified when it's ready to install."
      });
      clearManualCheck();
    }
  });

  autoUpdater.on("update-not-available", () => {
    if (manualCheckInFlight) {
      showResultDialog({
        message: `You're on the latest version of ${app.getName()}!`,
        detail: app.getVersion()
      });
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
      showResultDialog({
        type: "warning",
        message: "Couldn't check for updates.",
        detail: err.message
      });
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
