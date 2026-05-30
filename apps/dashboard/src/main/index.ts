import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { BrowserWindow, app, ipcMain, session, shell } from "electron";

// Electron `userData` is `appData` + app name; keep the on-disk folder as MapOS.
app.setName("MapOS");
import icon from "../../resources/icon.png?asset";
import { registerAiConfigIpc } from "./ai-config-ipc";
import { setupAppMenu } from "./app-menu";
import { setupChat } from "./chat";
import { buildCsp, setActiveServicesForCsp } from "./csp";
import { closeDb } from "./db";
import {
  getPrimaryVaultRoot,
  isOnboardingPending,
  loadOrInitMaposConfig,
  removeVaultFromConfig,
  renameVaultInConfig,
  setActiveVaultInConfig
} from "./mapos-config";
import { registerMaposIpc } from "./mapos-ipc";
import { setupOllamaPersistence } from "./ollama";
import { registerRegionPacksIpc } from "./region-packs";
import {
  registerAssetProtocol,
  registerLocalSchemes,
  registerRegionProtocol
} from "./region-protocol";
import { registerServicesIpc } from "./services-ipc";
import { setupUpdater } from "./updater";
import { setupPlacesWatcher } from "./watcher";

// Privileged-scheme registration must happen before app `ready`, so it runs at
// module load. The handlers themselves are attached inside whenReady.
registerLocalSchemes();

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
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false
      // devTools: false
    }
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    if (is.dev) mainWindow.webContents.openDevTools();
  });

  const sendFullscreenState = (isFullScreen: boolean): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window:fullscreen-change", isFullScreen);
    }
  };
  mainWindow.on("enter-full-screen", () => sendFullscreenState(true));
  mainWindow.on("leave-full-screen", () => sendFullscreenState(false));

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // Plain <a href> clicks (e.g. MapLibre attribution: maplibre.org, protomaps.com,
  // openstreetmap.org) navigate the renderer itself. Redirect off-app URLs to the
  // user's default browser so the app shell isn't replaced.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    try {
      const target = new URL(url);
      const current = new URL(currentUrl);
      if (target.origin !== current.origin) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return mainWindow;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("md.mapos.app");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.on("ping", () => console.log("pong"));

  ipcMain.handle("window:is-fullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isFullScreen() ?? false;
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [buildCsp()]
      }
    });
  });

  const mainWindow = createWindow();
  const appStateDir = app.getPath("userData");

  // Serve downloaded region packs (offline tiles/style) to the renderer, and the
  // global glyphs/sprites + world basemap bundled with the app.
  const basemapAssetsDir = app.isPackaged
    ? join(process.resourcesPath, "basemap-assets")
    : join(__dirname, "../../resources/basemap-assets");
  registerRegionProtocol(
    join(appStateDir, "regions"),
    join(basemapAssetsDir, "basemap", "world.pmtiles")
  );
  registerAssetProtocol(basemapAssetsDir);

  // Vault-bound state. When onboarding is pending these stay as no-op stubs until the user
  // completes the flow; `bootVault()` populates them and is also reused by switch/rename/delete.
  // The stubs are unreachable in practice — the only IPCs that touch this state (switch/rename/
  // delete) are callable from the main app, which renders only after onboarding finishes.
  const notReady = (): never => {
    throw new Error("Vault not initialized — onboarding has not completed.");
  };
  let maposConfig = loadOrInitMaposConfig(appStateDir);
  setActiveServicesForCsp(maposConfig.services);
  let vaultRoot = "";
  let places: Awaited<ReturnType<typeof setupPlacesWatcher>>["places"] = new Map();
  let stopWatcher: () => Promise<void> = async () => notReady();
  let stopChat: () => void = notReady;
  // Tracks whether `setupPlacesWatcher` has registered its IPC handlers. Re-running onboarding
  // mid-session (e.g. user wipes mapos.json without quitting on macOS, then reloads) would
  // otherwise re-call setupPlacesWatcher and collide with its own handlers.
  let vaultActive = false;

  async function teardownVault(): Promise<void> {
    if (!vaultActive) return;
    stopChat();
    await stopWatcher();
    closeDb();
    vaultActive = false;
  }

  function bootVault(): void {
    maposConfig = loadOrInitMaposConfig(appStateDir);
    vaultRoot = getPrimaryVaultRoot(maposConfig);
    ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
    stopChat = setupChat(mainWindow, places, vaultRoot);
    vaultActive = true;
  }

  // AI config handlers don't depend on vault state — register once for the lifetime of the window.
  setupOllamaPersistence(appStateDir);
  registerAiConfigIpc(mainWindow);
  registerServicesIpc();
  registerRegionPacksIpc(mainWindow, appStateDir);
  setupUpdater(mainWindow);
  setupAppMenu();

  // Vault management + onboarding IPCs are also vault-independent. They power both the
  // first-launch onboarding flow and the in-app vault switcher.
  registerMaposIpc(mainWindow, {
    onOnboardingComplete: async () => {
      // Renderer has already created a vault and saved AI config through existing IPCs.
      // If a previous vault is active (e.g. user wiped mapos.json mid-session and is
      // re-onboarding), tear it down first so handler registration doesn't collide.
      await teardownVault();
      bootVault();
      mainWindow.webContents.reload();
    }
  });

  if (!isOnboardingPending(appStateDir)) {
    bootVault();
  }

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
    stopChat = setupChat(mainWindow, places, vaultRoot);

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
      stopChat = setupChat(mainWindow, places, vaultRoot);
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
      stopChat = setupChat(mainWindow, places, vaultRoot);
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
    stopChat = setupChat(mainWindow, places, vaultRoot);

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
      stopChat = setupChat(mainWindow, places, vaultRoot);
      return { ok: false as const, error: removed.error };
    }
    const activated = setActiveVaultInConfig(appStateDir, fallback);
    if (!activated.ok) {
      ({ places, stop: stopWatcher } = setupPlacesWatcher(mainWindow, vaultRoot, appStateDir));
      stopChat = setupChat(mainWindow, places, vaultRoot);
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
    stopChat = setupChat(mainWindow, places, vaultRoot);

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
