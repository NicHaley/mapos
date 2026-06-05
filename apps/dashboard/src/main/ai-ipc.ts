/**
 * IPC surface for the AI provider model. Registered once for the window lifetime. Every mutation
 * broadcasts a single `ai:changed` event so the Providers settings tab and the chat composer both
 * refresh. The embedded-runtime IPC (local-llm/ipc.ts) reuses {@link broadcastAiChanged}.
 */

import { type BrowserWindow, ipcMain, shell } from "electron";
import type { ModelCapabilities } from "../shared/ai-models";
import type { ProviderInput } from "../shared/ai-providers";
import {
  cancelOauthLogin,
  disconnectKnownProvider,
  oauthLogin,
  setKnownProviderApiKey
} from "./ai-auth";
import {
  addKnownProvider,
  addProvider,
  clearActive,
  fetchModels,
  getAiState,
  getAiStatus,
  listKnownProviders,
  removeProvider,
  setActive,
  updateProvider
} from "./ai";

const HANDLE_CHANNELS = [
  "ai:get-state",
  "ai:get-status",
  "ai:add-provider",
  "ai:update-provider",
  "ai:remove-provider",
  "ai:set-active",
  "ai:clear-active",
  "ai:list-models",
  "ai:list-known-providers",
  "ai:add-known-provider",
  "ai:set-api-key",
  "ai:oauth-login",
  "ai:oauth-cancel",
  "ai:disconnect"
] as const;

/** Notify the renderer that the AI providers/selection changed. */
export function broadcastAiChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send("ai:changed");
}

export function registerAiIpc(mainWindow: BrowserWindow): () => void {
  const changed = (): void => broadcastAiChanged(mainWindow);

  ipcMain.handle("ai:get-state", () => getAiState());
  ipcMain.handle("ai:get-status", () => getAiStatus());

  ipcMain.handle("ai:add-provider", (_e, input: ProviderInput) => {
    const result = addProvider(input);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("ai:update-provider", (_e, args: { id: string; patch: ProviderInput }) => {
    const result = updateProvider(args.id, args.patch);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("ai:remove-provider", (_e, args: { id: string }) => {
    const result = removeProvider(args.id);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle(
    "ai:set-active",
    (_e, args: { providerId: string; model: string; capabilities: ModelCapabilities }) => {
      const result = setActive(args.providerId, args.model, args.capabilities);
      if (result.ok) changed();
      return result;
    }
  );

  ipcMain.handle("ai:clear-active", () => {
    const result = clearActive();
    changed();
    return result;
  });

  ipcMain.handle("ai:list-models", (_e, args: { providerId: string }) => fetchModels(args.providerId));

  ipcMain.handle("ai:list-known-providers", () => listKnownProviders());

  ipcMain.handle("ai:add-known-provider", (_e, args: { provider: string }) => {
    const result = addKnownProvider(args.provider);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("ai:set-api-key", (_e, args: { provider: string; key: string }) => {
    const result = setKnownProviderApiKey(args.provider, args.key);
    if (result.ok) changed();
    return result;
  });

  // Runs the OAuth flow (opens the system browser, awaits the local callback). Progress and the
  // authorize URL are streamed to the renderer via `ai:oauth-progress` so it can show status and a
  // manual "open browser" link.
  ipcMain.handle("ai:oauth-login", async (_e, args: { provider: string }) => {
    const emit = (status: string, url?: string): void => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("ai:oauth-progress", { provider: args.provider, status, url });
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

  ipcMain.handle("ai:oauth-cancel", () => {
    cancelOauthLogin();
    return { ok: true as const };
  });

  ipcMain.handle("ai:disconnect", (_e, args: { provider: string }) => {
    const result = disconnectKnownProvider(args.provider);
    changed();
    return result;
  });

  return function unregister(): void {
    for (const ch of HANDLE_CHANNELS) ipcMain.removeHandler(ch);
  };
}
