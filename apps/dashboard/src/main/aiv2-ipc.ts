/**
 * POC: IPC surface for the unified provider model. Registered once for the window lifetime
 * alongside the existing AI config IPC. Mutations broadcast both `aiv2:changed` (for the
 * Providers settings tab) and the existing `ai-config:changed` (so the chat composer re-checks
 * whether AI is configured).
 */

import { type BrowserWindow, ipcMain, shell } from "electron";
import type { ModelCapabilities } from "../shared/ai-models";
import type { ProviderInput } from "../shared/ai-providers";
import { broadcastAiConfigChanged } from "./ai-config-ipc";
import {
  addKnownProvider,
  addProvider,
  clearActive,
  fetchModels,
  getAiV2State,
  listKnownProviders,
  removeProvider,
  setActive,
  updateProvider
} from "./aiv2";
import {
  cancelOauthLogin,
  disconnectKnownProvider,
  oauthLogin,
  setKnownProviderApiKey
} from "./aiv2-auth";

const HANDLE_CHANNELS = [
  "aiv2:get-state",
  "aiv2:add-provider",
  "aiv2:update-provider",
  "aiv2:remove-provider",
  "aiv2:set-active",
  "aiv2:clear-active",
  "aiv2:list-models",
  "aiv2:list-known-providers",
  "aiv2:add-known-provider",
  "aiv2:set-api-key",
  "aiv2:oauth-login",
  "aiv2:oauth-cancel",
  "aiv2:disconnect"
] as const;

export function registerAiV2Ipc(mainWindow: BrowserWindow): () => void {
  const changed = (): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send("aiv2:changed");
    broadcastAiConfigChanged(mainWindow);
  };

  ipcMain.handle("aiv2:get-state", () => getAiV2State());

  ipcMain.handle("aiv2:add-provider", (_e, input: ProviderInput) => {
    const result = addProvider(input);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("aiv2:update-provider", (_e, args: { id: string; patch: ProviderInput }) => {
    const result = updateProvider(args.id, args.patch);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("aiv2:remove-provider", (_e, args: { id: string }) => {
    const result = removeProvider(args.id);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle(
    "aiv2:set-active",
    (_e, args: { providerId: string; model: string; capabilities: ModelCapabilities }) => {
      const result = setActive(args.providerId, args.model, args.capabilities);
      if (result.ok) changed();
      return result;
    }
  );

  ipcMain.handle("aiv2:clear-active", () => {
    const result = clearActive();
    changed();
    return result;
  });

  ipcMain.handle("aiv2:list-models", (_e, args: { providerId: string }) => fetchModels(args.providerId));

  ipcMain.handle("aiv2:list-known-providers", () => listKnownProviders());

  ipcMain.handle("aiv2:add-known-provider", (_e, args: { provider: string }) => {
    const result = addKnownProvider(args.provider);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("aiv2:set-api-key", (_e, args: { provider: string; key: string }) => {
    const result = setKnownProviderApiKey(args.provider, args.key);
    if (result.ok) changed();
    return result;
  });

  // Runs the OAuth flow (opens the system browser, awaits the local callback). Progress and the
  // authorize URL are streamed to the renderer via `aiv2:oauth-progress` so it can show status and
  // a manual "open browser" link.
  ipcMain.handle("aiv2:oauth-login", async (_e, args: { provider: string }) => {
    const emit = (status: string, url?: string): void => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("aiv2:oauth-progress", { provider: args.provider, status, url });
      }
    };
    emit("starting");
    const result = await oauthLogin(args.provider, {
      onAuthUrl: (url) => {
        void shell.openExternal(url);
        emit("awaiting-browser", url);
      },
      onProgress: (m) => emit(m)
    });
    emit(result.ok ? "done" : "error");
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("aiv2:oauth-cancel", () => {
    cancelOauthLogin();
    return { ok: true as const };
  });

  ipcMain.handle("aiv2:disconnect", (_e, args: { provider: string }) => {
    const result = disconnectKnownProvider(args.provider);
    changed();
    return result;
  });

  return function unregister(): void {
    for (const ch of HANDLE_CHANNELS) ipcMain.removeHandler(ch);
  };
}
