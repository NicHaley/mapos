import { app, safeStorage } from "electron";
import { type ModelCapabilities, resolveCapabilities } from "./ai-capabilities";
import {
  type AiConfig,
  type AiLocalMode,
  type AiProvider,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  loadOrInitMaposConfig,
  updateAiConfigInFile
} from "./mapos-config";

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

/** Form-shaped state for the renderer. Never includes raw secrets — only "is one set" booleans. */
export type AiSettingsState = {
  provider: AiProvider;
  anthropic: { model: string; hasApiKey: boolean };
  local: {
    mode: AiLocalMode;
    magic: { model: string };
    advanced: {
      baseUrl: string;
      model: string;
      hasAuthToken: boolean;
    };
  };
};

/** Subset of fields the renderer can write. Plaintext secrets here; main encrypts before writing. */
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
      baseUrl?: string;
      model?: string;
      /** Plaintext token. `null` clears, `undefined` leaves unchanged. */
      authToken?: string | null;
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
        baseUrl: cfg.local.advanced.baseUrl,
        model: cfg.local.advanced.model,
        hasAuthToken: !!cfg.local.advanced.encryptedAuthToken
      }
    }
  };
}

export function isAiConfigured(): { configured: boolean; activeProvider: AiProvider; model: string } {
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
  return {
    configured: cfg.local.advanced.baseUrl.length > 0 && cfg.local.advanced.model.length > 0,
    activeProvider: "local",
    model: cfg.local.advanced.model
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
          partial.local.magic.model = update.local.magic.model.trim();
        }
      }
      if (update.local.advanced) {
        partial.local.advanced = {};
        if (typeof update.local.advanced.baseUrl === "string") {
          const trimmed = update.local.advanced.baseUrl.trim();
          partial.local.advanced.baseUrl = trimmed || DEFAULT_OLLAMA_BASE_URL;
        }
        if (typeof update.local.advanced.model === "string") {
          partial.local.advanced.model = update.local.advanced.model.trim();
        }
        if (update.local.advanced.authToken === null) {
          partial.local.advanced.encryptedAuthToken = null;
        } else if (typeof update.local.advanced.authToken === "string") {
          const trimmed = update.local.advanced.authToken.trim();
          partial.local.advanced.encryptedAuthToken = trimmed === "" ? null : encrypt(trimmed);
        }
      }
    }

    updateAiConfigInFile(app.getPath("userData"), partial);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type ResolvedAiRequestConfig = {
  provider: AiProvider;
  baseUrl: string;
  authToken: string;
  apiKey: string;
  model: string;
  capabilities: ModelCapabilities;
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
  if (!cfg.local.advanced.baseUrl || !cfg.local.advanced.model) {
    throw new AiConfigError("AI_NOT_CONFIGURED", "Local model is not configured.");
  }
  let authToken = "";
  if (cfg.local.advanced.encryptedAuthToken) {
    try {
      authToken = decrypt(cfg.local.advanced.encryptedAuthToken);
    } catch {
      throw new AiConfigError("AI_DECRYPT_FAILED", "Couldn't decrypt the local auth token.");
    }
  }
  return {
    provider: "local",
    baseUrl: cfg.local.advanced.baseUrl,
    authToken,
    apiKey: "",
    model: cfg.local.advanced.model,
    capabilities: resolveCapabilities("local", cfg.local.advanced.model)
  };
}

/**
 * Read the current AI config and resolve to env-var-ready values for one chat request.
 * Throws AiConfigError when no provider is configured or when the encrypted secret can't be decrypted.
 */
export function loadAiConfigForRequest(): ResolvedAiRequestConfig {
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
