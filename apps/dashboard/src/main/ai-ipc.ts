/**
 * IPC surface for the AI provider model. Registered once for the window lifetime. Every mutation
 * broadcasts a single `ai:changed` event so the Providers settings tab and the chat composer both
 * refresh.
 */

import { type BrowserWindow, ipcMain, shell } from "electron";
import type { ModelCapabilities } from "../shared/ai-models";
import type { ProviderInput } from "../shared/ai-providers";

// `./ai` and `./ai-auth` pull in the Pi SDK (~21 MB of JS) — dynamic imports keep
// that off the app-startup path; the chunk loads on the first AI IPC instead.
const ai = () => import("./ai");
const aiAuth = () => import("./ai-auth");

const HANDLE_CHANNELS = [
  "ai:get-state",
  "ai:get-status",
  "ai:add-provider",
  "ai:update-provider",
  "ai:remove-provider",
  "ai:set-active",
  "ai:clear-active",
  "ai:list-models",
  "ai:test-provider",
  "ai:reveal-secret",
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

  ipcMain.handle("ai:get-state", async () => (await ai()).getAiState());
  ipcMain.handle("ai:get-status", async () => (await ai()).getAiStatus());

  ipcMain.handle("ai:add-provider", async (_e, input: ProviderInput) => {
    const result = (await ai()).addProvider(input);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("ai:update-provider", async (_e, args: { id: string; patch: ProviderInput }) => {
    const result = (await ai()).updateProvider(args.id, args.patch);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("ai:remove-provider", async (_e, args: { id: string }) => {
    const result = (await ai()).removeProvider(args.id);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle(
    "ai:set-active",
    async (_e, args: { providerId: string; model: string; capabilities: ModelCapabilities }) => {
      const result = (await ai()).setActive(args.providerId, args.model, args.capabilities);
      if (result.ok) changed();
      return result;
    }
  );

  ipcMain.handle("ai:clear-active", async () => {
    const result = (await ai()).clearActive();
    changed();
    return result;
  });

  ipcMain.handle("ai:list-models", async (_e, args: { providerId: string }) =>
    (await ai()).fetchModels(args.providerId)
  );

  ipcMain.handle(
    "ai:test-provider",
    async (_e, args: { input: ProviderInput; providerId?: string }) =>
      (await ai()).testProvider(args.input, args.providerId)
  );

  ipcMain.handle("ai:reveal-secret", async (_e, args: { providerId: string }) =>
    (await ai()).revealSecret(args.providerId)
  );

  ipcMain.handle("ai:list-known-providers", async () => (await ai()).listKnownProviders());

  ipcMain.handle("ai:add-known-provider", async (_e, args: { provider: string }) => {
    const result = (await ai()).addKnownProvider(args.provider);
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("ai:set-api-key", async (_e, args: { provider: string; key: string }) => {
    const result = (await aiAuth()).setKnownProviderApiKey(args.provider, args.key);
    if (result.ok) changed();
    return result;
  });

  // Runs the OAuth flow. Two shapes stream over `ai:oauth-progress`: a callback-server flow
  // (Anthropic) reports `awaiting-browser` with the authorize URL, while a device-code flow (GitHub
  // Copilot) reports `device-code` with a user code the renderer shows for entry in the browser.
  ipcMain.handle("ai:oauth-login", async (_e, args: { provider: string }) => {
    const emit = (
      status: string,
      extra?: { url?: string; userCode?: string; verificationUri?: string }
    ): void => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send("ai:oauth-progress", {
          provider: args.provider,
          status,
          ...extra
        });
      }
    };
    emit("starting");
    const result = await (await aiAuth()).oauthLogin(args.provider, {
      onAuthUrl: (url) => {
        void shell.openExternal(url);
        emit("awaiting-browser", { url });
      },
      onDeviceCode: ({ userCode, verificationUri }) => {
        void shell.openExternal(verificationUri);
        emit("device-code", { userCode, verificationUri });
      },
      onProgress: (m) => emit(m)
    });
    emit(result.ok ? "done" : "error");
    if (result.ok) changed();
    return result;
  });

  ipcMain.handle("ai:oauth-cancel", async () => {
    (await aiAuth()).cancelOauthLogin();
    return { ok: true as const };
  });

  ipcMain.handle("ai:disconnect", async (_e, args: { provider: string }) => {
    const result = (await aiAuth()).disconnectKnownProvider(args.provider);
    changed();
    return result;
  });

  return function unregister(): void {
    for (const ch of HANDLE_CHANNELS) ipcMain.removeHandler(ch);
  };
}
