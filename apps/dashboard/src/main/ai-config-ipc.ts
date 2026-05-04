import { type BrowserWindow, ipcMain } from "electron";
import {
  type AiSettingsUpdate,
  getAiSettingsState,
  isAiConfigured,
  loadAiConfigForRequest,
  updateAiSettings
} from "./ai-config";
import { DEFAULT_OLLAMA_BASE_URL } from "./mapos-config";
import { cancelPull, deleteModel, detectOllama, listInstalledModels, pullModel } from "./ollama";

const HANDLE_CHANNELS = [
  "ai-config:get-status",
  "ai-config:get-settings-state",
  "ai-config:update",
  "ai-config:test-connection",
  "ai-config:ollama-detect",
  "ai-config:ollama-list-installed",
  "ai-config:ollama-pull",
  "ai-config:ollama-cancel-pull",
  "ai-config:ollama-delete"
] as const;

/**
 * Plaintext draft passed by the renderer for testing unsaved values. Anything left undefined
 * falls back to the saved on-disk config; only fields the user actually edited need to be sent.
 */
export type TestConnectionDraft = {
  provider: "anthropic" | "local";
  apiKey?: string;
  baseUrl?: string;
  authToken?: string;
  model?: string;
};

type ResolvedTest = {
  url: string;
  headers: Record<string, string>;
  model: string;
};

/**
 * Build the request shape for the connectivity probe. Prefers draft fields when present so the
 * user can test before saving; falls back to the saved config (decrypted) for missing ones.
 */
function resolveTestRequest(
  draft: TestConnectionDraft
): { ok: true; resolved: ResolvedTest } | { ok: false; error: string } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01"
  };

  // Pull saved config lazily — we only need it when the draft is missing fields.
  let saved: ReturnType<typeof loadAiConfigForRequest> | null = null;
  function loadSaved(): ReturnType<typeof loadAiConfigForRequest> | null {
    if (saved) return saved;
    try {
      saved = loadAiConfigForRequest();
    } catch {
      saved = null;
    }
    return saved;
  }

  if (draft.provider === "anthropic") {
    const apiKey =
      typeof draft.apiKey === "string" && draft.apiKey.length > 0
        ? draft.apiKey
        : loadSaved()?.provider === "anthropic"
          ? loadSaved()?.apiKey
          : undefined;
    if (!apiKey) return { ok: false, error: "No API key to test." };
    const model = draft.model?.trim() || loadSaved()?.model;
    if (!model) return { ok: false, error: "No model to test." };
    headers["x-api-key"] = apiKey;
    return {
      ok: true,
      resolved: { url: "https://api.anthropic.com/v1/messages", headers, model }
    };
  }

  // Local provider — choose base URL and bearer token from the draft, falling back to saved.
  const savedLocal = loadSaved();
  const baseUrl =
    draft.baseUrl?.trim() ||
    (savedLocal?.provider === "local" ? savedLocal.baseUrl : DEFAULT_OLLAMA_BASE_URL);
  if (!baseUrl) return { ok: false, error: "No base URL to test." };
  const model =
    draft.model?.trim() || (savedLocal?.provider === "local" ? savedLocal.model : "");
  if (!model) return { ok: false, error: "No model to test." };

  // Ollama accepts any non-empty token; default to "ollama" so the SDK doesn't choke when the user
  // is testing a Magic-mode-style endpoint that doesn't actually require auth.
  const draftToken = draft.authToken?.trim();
  const authToken =
    typeof draftToken === "string" && draftToken.length > 0
      ? draftToken
      : savedLocal?.provider === "local" && savedLocal.authToken
        ? savedLocal.authToken
        : "ollama";
  headers.authorization = `Bearer ${authToken}`;

  return {
    ok: true,
    resolved: { url: `${baseUrl.replace(/\/$/, "")}/v1/messages`, headers, model }
  };
}

/** Probe the configured provider with a minimal request. Returns ok or a verbatim error. */
async function testConnection(
  draft: TestConnectionDraft
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolution = resolveTestRequest(draft);
  if (!resolution.ok) return resolution;
  const { url, headers, model } = resolution.resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
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
  ipcMain.handle("ai-config:test-connection", (_e, draft: TestConnectionDraft) =>
    testConnection(draft)
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
  ipcMain.handle(
    "ai-config:ollama-delete",
    async (_e, args: { baseUrl: string; modelId: string }) => {
      try {
        await deleteModel(args.baseUrl, args.modelId);
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      // If the deleted model was the active Magic selection, clear it so the chat doesn't try to use
      // a model that no longer exists. Advanced is left alone (power users manage their own pointers).
      const state = getAiSettingsState();
      if (state.local.magic.model === args.modelId) {
        updateAiSettings({ local: { magic: { model: "" } } });
      }
      broadcastAiConfigChanged(mainWindow);
      return { ok: true as const };
    }
  );

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
