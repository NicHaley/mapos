import { randomUUID } from "node:crypto";
import { app, safeStorage } from "electron";
import { type ModelCapabilities, resolveCapabilities } from "../shared/ai-models";
import { isAiV2Configured, resolveActiveV2 } from "./aiv2";
import { getSelectedModel } from "./local-llm/models";
import {
  type AiConfig,
  type AiLocalMode,
  type AiProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  loadOrInitMaposConfig,
  updateAiConfigInFile
} from "./mapos-config";

type AdvancedEndpoint = AiConfig["local"]["advanced"]["endpoints"][number];

/** Find the active advanced endpoint, or `null` if none is selected or it doesn't exist. */
function activeEndpoint(cfg: AiConfig): AdvancedEndpoint | null {
  const { activeId, endpoints } = cfg.local.advanced;
  if (!activeId) return null;
  return endpoints.find((e) => e.id === activeId) ?? null;
}

export class AiConfigError extends Error {
  constructor(
    public code: "AI_NOT_CONFIGURED" | "AI_DECRYPT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "AiConfigError";
  }
}

function encrypt(plaintext: string): string {
  return safeStorage.encryptString(plaintext).toString("base64");
}

function decrypt(encryptedBase64: string): string {
  const buf = Buffer.from(encryptedBase64, "base64");
  return safeStorage.decryptString(buf);
}

/**
 * Ollama follows the Docker convention: a bare model name (no `:tag`) implicitly means `:latest`
 * at inference time, but `/api/ps` always reports the fully-tagged name. We canonicalize on save
 * so `qwen3.6` and `qwen3.6:latest` are stored identically — and so the value the user sees in
 * Settings matches what `ollama list` shows. Empty strings are passed through unchanged so the
 * caller can still error on "model is required".
 */
function withDefaultTag(model: string): string {
  if (model.length === 0) return model;
  return model.includes(":") ? model : `${model}:latest`;
}

/** One custom endpoint as exposed to the renderer — never carries the encrypted token. */
export type AdvancedEndpointView = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  hasAuthToken: boolean;
};

/** Plaintext input for adding/updating an endpoint. Main encrypts the token before persisting. */
export type AdvancedEndpointInput = {
  label?: string;
  baseUrl?: string;
  model?: string;
  /** Plaintext token. `null` clears, `undefined` leaves unchanged. */
  authToken?: string | null;
};

/** Form-shaped state for the renderer. Never includes raw secrets — only "is one set" booleans. */
export type AiSettingsState = {
  provider: AiProvider;
  anthropic: { model: string; hasApiKey: boolean };
  local: {
    mode: AiLocalMode;
    magic: { model: string };
    advanced: {
      endpoints: AdvancedEndpointView[];
      activeId: string | null;
    };
  };
};

/**
 * Subset of fields the renderer can write through the catch-all `update` IPC.
 * Endpoint CRUD goes through dedicated IPC methods; only the active selector lives here.
 */
export type AiSettingsUpdate = {
  provider?: AiProvider;
  anthropic?: {
    model?: string;
    /** Plaintext key. `null` clears, `undefined` leaves unchanged. */
    apiKey?: string | null;
  };
  local?: {
    mode?: AiLocalMode;
    magic?: { model?: string };
    advanced?: {
      /** Switch which endpoint is active. `null` clears the active pointer. */
      activeId?: string | null;
    };
  };
};

export function getAiSettingsState(): AiSettingsState {
  const cfg = loadOrInitMaposConfig(app.getPath("userData")).ai;
  return {
    provider: cfg.provider,
    anthropic: { model: cfg.anthropic.model, hasApiKey: !!cfg.anthropic.encryptedApiKey },
    local: {
      mode: cfg.local.mode,
      magic: { model: cfg.local.magic.model },
      advanced: {
        endpoints: cfg.local.advanced.endpoints.map((e) => ({
          id: e.id,
          label: e.label,
          baseUrl: e.baseUrl,
          model: e.model,
          hasAuthToken: !!e.encryptedAuthToken
        })),
        activeId: cfg.local.advanced.activeId
      }
    }
  };
}

export function isAiConfigured(): { configured: boolean; activeProvider: AiProvider; model: string } {
  // Embedded local runtime wins when a downloaded model is selected.
  const embedded = getSelectedModel();
  if (embedded) return { configured: true, activeProvider: "local", model: embedded.id };
  // POC: a usable v2 provider selection takes precedence over the legacy config.
  const v2 = isAiV2Configured();
  if (v2) return v2;
  const cfg = loadOrInitMaposConfig(app.getPath("userData")).ai;
  if (cfg.provider === "anthropic") {
    return {
      configured: !!cfg.anthropic.encryptedApiKey && cfg.anthropic.model.length > 0,
      activeProvider: "anthropic",
      model: cfg.anthropic.model
    };
  }
  if (cfg.local.mode === "magic") {
    return {
      configured: cfg.local.magic.model.length > 0,
      activeProvider: "local",
      model: cfg.local.magic.model
    };
  }
  const active = activeEndpoint(cfg);
  return {
    configured: !!active && active.baseUrl.length > 0 && active.model.length > 0,
    activeProvider: "local",
    model: active?.model ?? ""
  };
}

/**
 * Apply an update to the on-disk AI config. Encrypts plaintext secrets via safeStorage
 * before writing. Magic and Advanced are independent slots — writing to one never modifies
 * the other.
 */
export function updateAiSettings(update: AiSettingsUpdate): { ok: true } | { ok: false; error: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "Secure storage isn't available on this system." };
  }
  try {
    const partial: Parameters<typeof updateAiConfigInFile>[1] = {};
    if (update.provider) partial.provider = update.provider;

    if (update.anthropic) {
      partial.anthropic = {};
      if (typeof update.anthropic.model === "string") {
        partial.anthropic.model = update.anthropic.model.trim();
      }
      if (update.anthropic.apiKey === null) {
        partial.anthropic.encryptedApiKey = null;
      } else if (typeof update.anthropic.apiKey === "string") {
        const trimmed = update.anthropic.apiKey.trim();
        partial.anthropic.encryptedApiKey = trimmed === "" ? null : encrypt(trimmed);
      }
    }

    if (update.local) {
      partial.local = {};
      if (update.local.mode) partial.local.mode = update.local.mode;
      if (update.local.magic) {
        partial.local.magic = {};
        if (typeof update.local.magic.model === "string") {
          partial.local.magic.model = withDefaultTag(update.local.magic.model.trim());
        }
      }
      if (update.local.advanced && "activeId" in update.local.advanced) {
        partial.local.advanced = { activeId: update.local.advanced.activeId ?? null };
      }
    }

    updateAiConfigInFile(app.getPath("userData"), partial);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Add a new custom endpoint. Returns its generated id on success. */
export function addCustomEndpoint(
  input: AdvancedEndpointInput
): { ok: true; id: string } | { ok: false; error: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "Secure storage isn't available on this system." };
  }
  const baseUrl = input.baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL;
  const trimmedModel = input.model?.trim() ?? "";
  if (trimmedModel.length === 0) {
    return { ok: false, error: "Model is required." };
  }
  const model = withDefaultTag(trimmedModel);
  const label = input.label?.trim() || "Custom";
  let encryptedAuthToken: string | null = null;
  if (typeof input.authToken === "string" && input.authToken.trim().length > 0) {
    encryptedAuthToken = encrypt(input.authToken.trim());
  }
  const id = randomUUID();
  const cfg = loadOrInitMaposConfig(app.getPath("userData")).ai;
  const next: AdvancedEndpoint = { id, label, baseUrl, model, encryptedAuthToken };
  updateAiConfigInFile(app.getPath("userData"), {
    local: { advanced: { endpoints: [...cfg.local.advanced.endpoints, next] } }
  });
  return { ok: true, id };
}

/** Update fields of an existing custom endpoint. Token is only touched when explicitly provided. */
export function updateCustomEndpoint(
  id: string,
  patch: AdvancedEndpointInput
): { ok: true } | { ok: false; error: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "Secure storage isn't available on this system." };
  }
  const cfg = loadOrInitMaposConfig(app.getPath("userData")).ai;
  const idx = cfg.local.advanced.endpoints.findIndex((e) => e.id === id);
  if (idx === -1) {
    return { ok: false, error: "Endpoint not found." };
  }
  const current = cfg.local.advanced.endpoints[idx];
  if (!current) {
    return { ok: false, error: "Endpoint not found." };
  }
  let encryptedAuthToken = current.encryptedAuthToken;
  if (patch.authToken === null) {
    encryptedAuthToken = null;
  } else if (typeof patch.authToken === "string") {
    const trimmed = patch.authToken.trim();
    encryptedAuthToken = trimmed === "" ? null : encrypt(trimmed);
  }
  const trimmedBase = typeof patch.baseUrl === "string" ? patch.baseUrl.trim() : undefined;
  const trimmedModel = typeof patch.model === "string" ? patch.model.trim() : undefined;
  const trimmedLabel = typeof patch.label === "string" ? patch.label.trim() : undefined;
  if (trimmedModel !== undefined && trimmedModel.length === 0) {
    return { ok: false, error: "Model is required." };
  }
  const updated: AdvancedEndpoint = {
    id: current.id,
    label: trimmedLabel ?? current.label,
    baseUrl: trimmedBase || current.baseUrl,
    model: trimmedModel !== undefined ? withDefaultTag(trimmedModel) : current.model,
    encryptedAuthToken
  };
  const endpoints = [...cfg.local.advanced.endpoints];
  endpoints[idx] = updated;
  updateAiConfigInFile(app.getPath("userData"), { local: { advanced: { endpoints } } });
  return { ok: true };
}

/** Remove an endpoint. Clears `activeId` if it was pointing at the removed one. */
export function removeCustomEndpoint(
  id: string
): { ok: true } | { ok: false; error: string } {
  const cfg = loadOrInitMaposConfig(app.getPath("userData")).ai;
  const exists = cfg.local.advanced.endpoints.some((e) => e.id === id);
  if (!exists) {
    return { ok: false, error: "Endpoint not found." };
  }
  const endpoints = cfg.local.advanced.endpoints.filter((e) => e.id !== id);
  const wasActive = cfg.local.advanced.activeId === id;
  updateAiConfigInFile(app.getPath("userData"), {
    local: {
      advanced: { endpoints, ...(wasActive ? { activeId: null } : {}) }
    }
  });
  return { ok: true };
}

export type ResolvedAiRequestConfig = {
  provider: AiProvider;
  baseUrl: string;
  authToken: string;
  apiKey: string;
  model: string;
  capabilities: ModelCapabilities;
  /**
   * POC v2: when set, this is a Pi catalog provider name (e.g. "anthropic"). The chat path resolves
   * the model via `getModel(piProvider, model)` and its auth (API key or auto-refreshed OAuth token)
   * through the shared persistent AuthStorage — no inline key/token is carried here.
   */
  piProvider?: string;
  /** Embedded runtime: path to the selected GGUF. When set, inference runs in-process (no network). */
  embeddedModelPath?: string;
};

function resolveLocalConfig(cfg: AiConfig): ResolvedAiRequestConfig {
  if (cfg.local.mode === "magic") {
    if (!cfg.local.magic.model) {
      throw new AiConfigError("AI_NOT_CONFIGURED", "Local model is not configured.");
    }
    return {
      provider: "local",
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      // Ollama accepts any non-empty token; the SDK requires one to be set.
      authToken: "ollama",
      apiKey: "",
      model: cfg.local.magic.model,
      capabilities: resolveCapabilities("local", cfg.local.magic.model)
    };
  }
  const active = activeEndpoint(cfg);
  if (!active || !active.baseUrl || !active.model) {
    throw new AiConfigError("AI_NOT_CONFIGURED", "Local model is not configured.");
  }
  let authToken = "";
  if (active.encryptedAuthToken) {
    try {
      authToken = decrypt(active.encryptedAuthToken);
    } catch {
      throw new AiConfigError("AI_DECRYPT_FAILED", "Couldn't decrypt the local auth token.");
    }
  }
  return {
    provider: "local",
    baseUrl: active.baseUrl,
    authToken,
    apiKey: "",
    model: active.model,
    capabilities: resolveCapabilities("local", active.model)
  };
}

/**
 * Read the saved Anthropic credentials regardless of which provider is currently active.
 * Used by the Test connection flow so users can verify their stored key even while running
 * on the local provider. Returns null when no key is saved or decryption fails.
 */
export function loadSavedAnthropicConfig(): { apiKey: string; model: string } | null {
  const cfg = loadOrInitMaposConfig(app.getPath("userData")).ai;
  if (!cfg.anthropic.encryptedApiKey) return null;
  try {
    return {
      apiKey: decrypt(cfg.anthropic.encryptedApiKey),
      model: cfg.anthropic.model || DEFAULT_ANTHROPIC_MODEL
    };
  } catch {
    return null;
  }
}

/**
 * Read the current AI config and resolve to env-var-ready values for one chat request.
 * Throws AiConfigError when no provider is configured or when the encrypted secret can't be decrypted.
 */
export function loadAiConfigForRequest(): ResolvedAiRequestConfig {
  // Embedded local runtime takes precedence: a selected, downloaded GGUF runs in-process.
  const embedded = getSelectedModel();
  if (embedded) {
    return {
      provider: "local",
      baseUrl: "",
      authToken: "",
      apiKey: "",
      model: embedded.id,
      capabilities: embedded.capabilities,
      embeddedModelPath: embedded.path
    };
  }
  // POC: prefer the unified-provider selection when one is set and usable; otherwise fall through
  // to the legacy provider/anthropic/local config below.
  const v2 = resolveActiveV2();
  if (v2) return v2;
  const cfg = loadOrInitMaposConfig(app.getPath("userData")).ai;
  if (cfg.provider === "anthropic") {
    if (!cfg.anthropic.encryptedApiKey) {
      throw new AiConfigError("AI_NOT_CONFIGURED", "Anthropic API key is not set.");
    }
    if (!cfg.anthropic.model) {
      throw new AiConfigError("AI_NOT_CONFIGURED", "Anthropic model is not set.");
    }
    let apiKey: string;
    try {
      apiKey = decrypt(cfg.anthropic.encryptedApiKey);
    } catch {
      throw new AiConfigError("AI_DECRYPT_FAILED", "Couldn't decrypt the Anthropic API key.");
    }
    const model = cfg.anthropic.model || DEFAULT_ANTHROPIC_MODEL;
    return {
      provider: "anthropic",
      baseUrl: "",
      authToken: "",
      apiKey,
      model,
      capabilities: resolveCapabilities("anthropic", model)
    };
  }
  return resolveLocalConfig(cfg);
}
