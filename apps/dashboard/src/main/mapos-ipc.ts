import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type BrowserWindow, app, dialog, ipcMain } from "electron";
import { closeDb } from "./db";
import {
  appendVaultToConfig,
  getPrimaryVaultRoot,
  isOnboardingPending,
  loadOrInitMaposConfig
} from "./mapos-config";
import { initVaultOnDisk } from "./watcher";

type RegisterOpts = {
  /**
   * Called when the renderer signals onboarding is finished. The host (main/index.ts) uses
   * this to start the watcher and chat against the freshly-configured vault, then reload
   * the renderer so it boots into the main app.
   */
  onOnboardingComplete: () => Promise<void> | void;
};

function validateVaultName(name: string): { ok: true } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name cannot be empty." };
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { ok: false, error: "Name cannot contain slashes." };
  }
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
    return { ok: false, error: "Name cannot start with a dot." };
  }
  return { ok: true };
}

/**
 * Vault draft passed from the renderer at the end of onboarding. Until the user lands on
 * the Done step nothing has been written to disk or to mapos.json — they can revisit and
 * change their pick freely.
 */
export type OnboardingVaultDraft =
  | { kind: "create"; targetPath: string; name: string }
  | { kind: "existing"; path: string };

/**
 * Vault management + onboarding IPCs. These don't depend on a live watcher, so they're
 * registered once for the lifetime of the window and remain available before, during,
 * and after onboarding.
 */
export function registerMaposIpc(mainWindow: BrowserWindow, opts: RegisterOpts): void {
  ipcMain.handle("mapos:get-vaults-config", () => {
    const appStateDir = app.getPath("userData");
    const cfg = loadOrInitMaposConfig(appStateDir);
    const vaults = cfg.vaults.map((p) => resolve(p.trim())).filter((p) => p.length > 0);
    return { vaults, activeVaultPath: getPrimaryVaultRoot(cfg) };
  });

  ipcMain.handle("mapos:set-folder-as-vault", async () => {
    if (mainWindow.isDestroyed()) return { canceled: true as const };
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose folder to use as a vault"
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true as const };
    const path = resolve(picked.filePaths[0]);
    const appStateDir = app.getPath("userData");
    const result = appendVaultToConfig(appStateDir, path);
    if (!result.ok) return { ok: false as const, error: result.error };
    initVaultOnDisk(path);
    closeDb();
    return {
      ok: true as const,
      path,
      vaults: result.config.vaults.map((p) => resolve(p.trim()))
    };
  });

  ipcMain.handle("mapos:create-new-vault", async (_event, name: string) => {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return { ok: false as const, error: "Name cannot be empty." };
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      return { ok: false as const, error: "Name cannot contain slashes." };
    }
    if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
      return { ok: false as const, error: "Name cannot start with a dot." };
    }

    if (mainWindow.isDestroyed()) return { canceled: true as const };
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose where to create the new vault"
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true as const };
    const parent = picked.filePaths[0];
    const newPath = resolve(join(parent, trimmed));
    if (existsSync(newPath)) {
      return { ok: false as const, error: "A folder with that name already exists." };
    }
    try {
      initVaultOnDisk(newPath);
      closeDb();
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
    const appStateDir = app.getPath("userData");
    const result = appendVaultToConfig(appStateDir, newPath);
    if (!result.ok) {
      try {
        rmSync(newPath, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      return { ok: false as const, error: result.error };
    }
    return {
      ok: true as const,
      path: newPath,
      vaults: result.config.vaults.map((p) => resolve(p.trim()))
    };
  });

  ipcMain.handle("onboarding:get-state", () => {
    const appStateDir = app.getPath("userData");
    return { pending: isOnboardingPending(appStateDir) };
  });

  /**
   * Renderer-driven "create new vault" picker. Opens a folder picker for the parent
   * directory, validates the name, and returns the resolved target path WITHOUT writing
   * anything to disk. Onboarding stores this as a draft and only commits on Done.
   */
  ipcMain.handle("onboarding:pick-create-location", async (_event, name: string) => {
    const validated = validateVaultName(name);
    if (!validated.ok) return { ok: false as const, error: validated.error };
    if (mainWindow.isDestroyed()) return { canceled: true as const };
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose where to create the new vault"
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true as const };
    const parent = picked.filePaths[0];
    const targetPath = resolve(join(parent, name.trim()));
    if (existsSync(targetPath)) {
      return { ok: false as const, error: "A folder with that name already exists." };
    }
    return { ok: true as const, targetPath, parentPath: parent };
  });

  /**
   * Renderer-driven "use existing folder" picker. Returns the picked path without
   * registering it. Onboarding stores it as a draft and commits on Done.
   */
  ipcMain.handle("onboarding:pick-existing-vault", async () => {
    if (mainWindow.isDestroyed()) return { canceled: true as const };
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose folder to use as a vault"
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true as const };
    const path = resolve(picked.filePaths[0]);
    try {
      if (!statSync(path).isDirectory()) {
        return { ok: false as const, error: "Path is not a folder." };
      }
    } catch {
      return { ok: false as const, error: "Could not read that path." };
    }
    return { ok: true as const, path };
  });

  ipcMain.handle("onboarding:complete", async (_event, draft: OnboardingVaultDraft) => {
    const appStateDir = app.getPath("userData");

    if (draft.kind === "create") {
      if (existsSync(draft.targetPath)) {
        return { ok: false as const, error: "A folder with that name already exists." };
      }
      try {
        initVaultOnDisk(draft.targetPath);
        closeDb();
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
      const result = appendVaultToConfig(appStateDir, draft.targetPath);
      if (!result.ok) {
        try {
          rmSync(draft.targetPath, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
        return { ok: false as const, error: result.error };
      }
    } else {
      const result = appendVaultToConfig(appStateDir, draft.path);
      if (!result.ok) return { ok: false as const, error: result.error };
      initVaultOnDisk(draft.path);
      closeDb();
    }

    await opts.onOnboardingComplete();
    return { ok: true as const };
  });
}
