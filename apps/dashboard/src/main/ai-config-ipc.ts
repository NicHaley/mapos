import { type BrowserWindow, ipcMain } from "electron";
import {
  type AiSettingsUpdate,
  getAiSettingsState,
  isAiConfigured,
  loadAiConfigForRequest,
  updateAiSettings
} from "./ai-config";
import { cancelPull, detectOllama, listInstalledModels, pullModel } from "./ollama";

const HANDLE_CHANNELS = [
  "ai-config:get-status",
  "ai-config:get-settings-state",
  "ai-config:update",
  "ai-config:test-connection",
  "ai-config:ollama-detect",
  "ai-config:ollama-list-installed",
  "ai-config:ollama-pull",
  "ai-config:ollama-cancel-pull"
] as const;

/** Probe the configured provider with a minimal request. Returns ok or a verbatim error. */
async function testConnection(
  provider: "anthropic" | "local"
): Promise<{ ok: true } | { ok: false; error: string }> {
  let resolved: ReturnType<typeof loadAiConfigForRequest>;
  try {
    resolved = loadAiConfigForRequest();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (resolved.provider !== provider) {
    return { ok: false, error: `Active provider is ${resolved.provider}, not ${provider}.` };
  }

  const url =
    provider === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : `${resolved.baseUrl.replace(/\/$/, "")}/v1/messages`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01"
  };
  if (provider === "anthropic") {
    headers["x-api-key"] = resolved.apiKey;
  } else if (resolved.authToken) {
    headers.authorization = `Bearer ${resolved.authToken}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: controller.signal
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 240)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function registerAiConfigIpc(mainWindow: BrowserWindow): () => void {
  ipcMain.handle("ai-config:get-status", () => isAiConfigured());
  ipcMain.handle("ai-config:get-settings-state", () => getAiSettingsState());
  ipcMain.handle("ai-config:update", (_e, update: AiSettingsUpdate) => {
    const result = updateAiSettings(update);
    if (result.ok) broadcastAiConfigChanged(mainWindow);
    return result;
  });
  ipcMain.handle("ai-config:test-connection", (_e, provider: "anthropic" | "local") =>
    testConnection(provider)
  );
  ipcMain.handle("ai-config:ollama-detect", (_e, baseUrl: string) => detectOllama(baseUrl));
  ipcMain.handle("ai-config:ollama-list-installed", (_e, baseUrl: string) =>
    listInstalledModels(baseUrl)
  );
  ipcMain.handle("ai-config:ollama-pull", async (_e, args: { baseUrl: string; modelId: string }) => {
    try {
      await pullModel(mainWindow, args.baseUrl, args.modelId);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("ai-config:ollama-cancel-pull", (_e, args: { baseUrl: string; modelId: string }) => {
    cancelPull(args.baseUrl, args.modelId);
    return { ok: true as const };
  });

  return function unregister(): void {
    for (const ch of HANDLE_CHANNELS) ipcMain.removeHandler(ch);
  };
}

/** Status notification fired after a save so other windows/components can refresh. */
export function broadcastAiConfigChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ai-config:changed");
  }
}
