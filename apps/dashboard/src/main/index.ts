import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { BrowserWindow, app, ipcMain, session, shell } from "electron";

// Electron `userData` is `appData` + app name; keep the on-disk folder as MapOS.
app.setName("MapOS");
import icon from "../../resources/icon.png?asset";
import { setupChat } from "./chat";
import { closeDb } from "./db";
import {
  getPrimaryVaultRoot,
  loadOrInitMaposConfig,
  removeVaultFromConfig,
  renameVaultInConfig,
  setActiveVaultInConfig
} from "./mapos-config";
import { setupPlacesWatcher } from "./watcher";

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false
      // devTools: false
    }
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    if (is.dev) mainWindow.webContents.openDevTools();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.electron");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.on("ping", () => console.log("pong"));

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' blob:",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://api.protomaps.com https://protomaps.github.io",
            "connect-src 'self' https://api.protomaps.com https://protomaps.github.io https://photon.komoot.io https://valhalla1.openstreetmap.de",
            "worker-src 'self' blob:",
            "font-src 'self' data:"
          ].join("; ")
        ]
      }
    });
  });

  const mainWindow = createWindow();
  const appStateDir = app.getPath("userData");

  let maposConfig = loadOrInitMaposConfig(appStateDir);
  let vaultRoot = getPrimaryVaultRoot(maposConfig);
  let { places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir);
  let stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);

  ipcMain.handle("mapos:switch-vault", async (_event, targetPath: string) => {
    const result = setActiveVaultInConfig(appStateDir, targetPath);
    if (!result.ok) return result;

    // Tear down current vault
    stopChat();
    await stopWatcher();
    closeDb();

    // Re-initialize with new vault
    maposConfig = loadOrInitMaposConfig(appStateDir);
    vaultRoot = getPrimaryVaultRoot(maposConfig);
    ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
    stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);

    // Reload the renderer (fast — no process restart)
    mainWindow.webContents.reload();

    return { ok: true as const };
  });

  ipcMain.handle("mapos:rename-vault", async (_event, newName: string) => {
    const trimmed = typeof newName === "string" ? newName.trim() : "";
    if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      return { ok: false as const, error: "Name cannot contain slashes." };
    }
    if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
      return { ok: false as const, error: "Name cannot start with a dot." };
    }

    const oldPath = resolve(vaultRoot);
    const newPath = resolve(join(dirname(oldPath), trimmed));
    if (newPath === oldPath) return { ok: false as const, error: "Name is unchanged." };
    if (existsSync(newPath)) {
      return { ok: false as const, error: "A folder with that name already exists." };
    }

    // Tear down current vault so we can release file handles before renaming on disk.
    stopChat();
    await stopWatcher();
    closeDb();

    try {
      renameSync(oldPath, newPath);
    } catch (e) {
      // Re-initialize at the original path so the app is not left in a broken state.
      ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
      stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);
      return { ok: false as const, error: `Rename failed: ${String(e)}` };
    }

    const updated = renameVaultInConfig(appStateDir, oldPath, newPath);
    if (!updated.ok) {
      // Config update failed after disk rename — try to roll back the disk rename.
      try {
        renameSync(newPath, oldPath);
      } catch {
        /* best-effort rollback */
      }
      ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
      stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);
      return { ok: false as const, error: updated.error };
    }

    // Spatial index caches file paths rooted at the old folder name — purge before rescan.
    for (const suffix of ["index.db", "index.db-wal", "index.db-shm"]) {
      try {
        rmSync(join(appStateDir, suffix), { force: true });
      } catch {
        /* best-effort */
      }
    }

    maposConfig = loadOrInitMaposConfig(appStateDir);
    vaultRoot = getPrimaryVaultRoot(maposConfig);
    ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
    stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);

    mainWindow.webContents.reload();

    return { ok: true as const, newPath };
  });

  ipcMain.handle("mapos:delete-vault", async () => {
    const oldActive = resolve(vaultRoot);
    const cfg = loadOrInitMaposConfig(appStateDir);
    const normalized = cfg.vaults.map((p) => resolve(p.trim()));
    if (normalized.length <= 1) {
      return { ok: false as const, error: "Cannot delete the only vault." };
    }
    const fallback = normalized.find((p) => p !== oldActive);
    if (!fallback) {
      return { ok: false as const, error: "No other vault available to switch to." };
    }

    stopChat();
    await stopWatcher();
    closeDb();

    const removed = removeVaultFromConfig(appStateDir, oldActive);
    if (!removed.ok) {
      ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
      stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);
      return { ok: false as const, error: removed.error };
    }
    const activated = setActiveVaultInConfig(appStateDir, fallback);
    if (!activated.ok) {
      ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
      stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);
      return { ok: false as const, error: activated.error };
    }

    for (const suffix of ["index.db", "index.db-wal", "index.db-shm"]) {
      try {
        rmSync(join(appStateDir, suffix), { force: true });
      } catch {
        /* best-effort */
      }
    }

    maposConfig = loadOrInitMaposConfig(appStateDir);
    vaultRoot = getPrimaryVaultRoot(maposConfig);
    ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
    stopChat = setupChat(mainWindow, places, vaultRoot, appStateDir);

    mainWindow.webContents.reload();

    return { ok: true as const };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
