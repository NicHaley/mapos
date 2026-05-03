import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MAPOS_CONFIG_FILENAME = "mapos.json";

const DEFAULT_VAULT_PATH = join(homedir(), "MapOS");

export type AiProvider = "anthropic" | "local";
export type AiLocalMode = "magic" | "advanced";

export type AiConfig = {
  provider: AiProvider;
  anthropic: {
    model: string;
    encryptedApiKey: string | null;
  };
  local: {
    mode: AiLocalMode;
    baseUrl: string;
    model: string;
    encryptedAuthToken: string | null;
  };
};

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

function defaultAiConfig(): AiConfig {
  return {
    provider: "anthropic",
    anthropic: {
      model: DEFAULT_ANTHROPIC_MODEL,
      encryptedApiKey: null
    },
    local: {
      mode: "magic",
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      model: "",
      encryptedAuthToken: null
    }
  };
}

export type MaposJson = {
  /** Absolute paths to vault roots. Order is stable; active vault is tracked separately. */
  vaults: string[];
  /** Absolute path of the currently active vault. Defaults to vaults[0] if absent. */
  activeVault?: string;
  /** AI provider configuration (global, not per-vault). */
  ai: AiConfig;
};

function defaultConfig(): MaposJson {
  return { vaults: [DEFAULT_VAULT_PATH], ai: defaultAiConfig() };
}

function parseAiConfig(raw: unknown): AiConfig {
  const fallback = defaultAiConfig();
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const provider: AiProvider = r.provider === "local" ? "local" : "anthropic";

  const anthropicRaw = (r.anthropic ?? {}) as Record<string, unknown>;
  const anthropic = {
    model:
      typeof anthropicRaw.model === "string" && anthropicRaw.model.length > 0
        ? anthropicRaw.model
        : DEFAULT_ANTHROPIC_MODEL,
    encryptedApiKey:
      typeof anthropicRaw.encryptedApiKey === "string" ? anthropicRaw.encryptedApiKey : null
  };

  const localRaw = (r.local ?? {}) as Record<string, unknown>;
  const mode: AiLocalMode = localRaw.mode === "advanced" ? "advanced" : "magic";
  const local = {
    mode,
    baseUrl:
      typeof localRaw.baseUrl === "string" && localRaw.baseUrl.length > 0
        ? localRaw.baseUrl
        : DEFAULT_OLLAMA_BASE_URL,
    model: typeof localRaw.model === "string" ? localRaw.model : "",
    encryptedAuthToken:
      typeof localRaw.encryptedAuthToken === "string" ? localRaw.encryptedAuthToken : null
  };

  return { provider, anthropic, local };
}

function parseConfig(raw: string): MaposJson | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const vaults = (parsed as { vaults?: unknown }).vaults;
    if (!Array.isArray(vaults) || vaults.some((v) => typeof v !== "string")) return null;
    const activeVault = (parsed as { activeVault?: unknown }).activeVault;
    const ai = parseAiConfig((parsed as { ai?: unknown }).ai);
    return {
      vaults: [...vaults],
      ...(typeof activeVault === "string" ? { activeVault } : {}),
      ai
    };
  } catch {
    return null;
  }
}

/**
 * Ensures the app state directory exists and returns `mapos.json` (creates default if missing).
 * Pass `app.getPath("userData")` from the Electron main process.
 * Invalid or empty `vaults` is repaired to the default vault path and written back.
 */
export function loadOrInitMaposConfig(appStateDir: string): MaposJson {
  mkdirSync(appStateDir, { recursive: true });
  const configPath = join(appStateDir, MAPOS_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    const cfg = defaultConfig();
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
    return cfg;
  }
  const parsed = parseConfig(readFileSync(configPath, "utf-8"));
  if (!parsed || parsed.vaults.length === 0) {
    const cfg = defaultConfig();
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
    return cfg;
  }
  return parsed;
}

export function getPrimaryVaultRoot(config: MaposJson): string {
  const normalized = config.vaults.map((p) => resolve(p.trim()));
  if (config.activeVault) {
    const active = resolve(config.activeVault.trim());
    if (normalized.includes(active)) return active;
  }
  return normalized[0] ?? resolve(DEFAULT_VAULT_PATH);
}

export function appendVaultToConfig(
  appStateDir: string,
  vaultPath: string
): { ok: true; config: MaposJson } | { ok: false; error: string } {
  const resolved = resolve(vaultPath.trim());
  try {
    if (!existsSync(resolved)) {
      return { ok: false, error: "Folder does not exist." };
    }
    if (!statSync(resolved).isDirectory()) {
      return { ok: false, error: "Path is not a folder." };
    }
  } catch {
    return { ok: false, error: "Could not read that path." };
  }
  const cfg = loadOrInitMaposConfig(appStateDir);
  const normalized = cfg.vaults.map((p) => resolve(p.trim()));
  if (normalized.includes(resolved)) {
    return { ok: false, error: "This folder is already in your vault list." };
  }
  const next: MaposJson = {
    vaults: [...normalized, resolved],
    ...(cfg.activeVault ? { activeVault: cfg.activeVault } : {}),
    ai: cfg.ai
  };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return { ok: true, config: next };
}

export function setActiveVaultInConfig(
  appStateDir: string,
  vaultPath: string
): { ok: true } | { ok: false; error: string } {
  const resolved = resolve(vaultPath.trim());
  const cfg = loadOrInitMaposConfig(appStateDir);
  const normalized = cfg.vaults.map((p) => resolve(p.trim()));
  if (!normalized.includes(resolved)) {
    return { ok: false, error: "Vault not found in config." };
  }
  // Keep vaults[] order stable; only update activeVault pointer.
  const next: MaposJson = { vaults: normalized, activeVault: resolved, ai: cfg.ai };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return { ok: true };
}

export function renameVaultInConfig(
  appStateDir: string,
  oldPath: string,
  newPath: string
): { ok: true; config: MaposJson } | { ok: false; error: string } {
  const resolvedOld = resolve(oldPath.trim());
  const resolvedNew = resolve(newPath.trim());
  const cfg = loadOrInitMaposConfig(appStateDir);
  const normalized = cfg.vaults.map((p) => resolve(p.trim()));
  const idx = normalized.indexOf(resolvedOld);
  if (idx === -1) {
    return { ok: false, error: "Vault not found in config." };
  }
  if (resolvedOld !== resolvedNew && normalized.includes(resolvedNew)) {
    return { ok: false, error: "A vault with that path already exists in your list." };
  }
  const nextVaults = [...normalized];
  nextVaults[idx] = resolvedNew;
  const activeResolved = cfg.activeVault ? resolve(cfg.activeVault.trim()) : undefined;
  const nextActive = activeResolved === resolvedOld ? resolvedNew : activeResolved;
  const next: MaposJson = {
    vaults: nextVaults,
    ...(nextActive ? { activeVault: nextActive } : {}),
    ai: cfg.ai
  };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return { ok: true, config: next };
}

export function removeVaultFromConfig(
  appStateDir: string,
  vaultPath: string
): { ok: true; config: MaposJson } | { ok: false; error: string } {
  const resolved = resolve(vaultPath.trim());
  const cfg = loadOrInitMaposConfig(appStateDir);
  const normalized = cfg.vaults.map((p) => resolve(p.trim()));
  if (!normalized.includes(resolved)) {
    return { ok: false, error: "Vault not found in config." };
  }
  if (normalized.length <= 1) {
    return { ok: false, error: "Cannot remove the only vault." };
  }
  const nextVaults = normalized.filter((p) => p !== resolved);
  const activeResolved = cfg.activeVault ? resolve(cfg.activeVault.trim()) : undefined;
  const nextActive =
    activeResolved && activeResolved !== resolved ? activeResolved : undefined;
  const next: MaposJson = {
    vaults: nextVaults,
    ...(nextActive ? { activeVault: nextActive } : {}),
    ai: cfg.ai
  };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return { ok: true, config: next };
}

/**
 * Atomically merge a partial AI config into mapos.json. Top-level provider/anthropic/local
 * are deep-merged so callers can update one slice (e.g. just the API key) without supplying the rest.
 */
export function updateAiConfigInFile(
  appStateDir: string,
  partial: {
    provider?: AiProvider;
    anthropic?: Partial<AiConfig["anthropic"]>;
    local?: Partial<AiConfig["local"]>;
  }
): MaposJson {
  const cfg = loadOrInitMaposConfig(appStateDir);
  const next: MaposJson = {
    vaults: cfg.vaults,
    ...(cfg.activeVault ? { activeVault: cfg.activeVault } : {}),
    ai: {
      provider: partial.provider ?? cfg.ai.provider,
      anthropic: { ...cfg.ai.anthropic, ...(partial.anthropic ?? {}) },
      local: { ...cfg.ai.local, ...(partial.local ?? {}) }
    }
  };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return next;
}

/**
 * Returns the path to a vault's per-vault state directory.
 */
export function vaultDotDir(vaultRoot: string): string {
  return join(vaultRoot, ".mapos");
}

