import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const MAPOS_CONFIG_FILENAME = "mapos.json";

const DEFAULT_VAULT_PATH = join(homedir(), "MapOS");

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

const AnthropicConfigSchema = z
  .object({
    model: z.string().min(1).catch(DEFAULT_ANTHROPIC_MODEL),
    encryptedApiKey: z.string().nullable().catch(null)
  })
  .catch(() => ({ model: DEFAULT_ANTHROPIC_MODEL, encryptedApiKey: null }));

/** Magic mode is hard-fixed to localhost; only the chosen model is configurable. */
const LocalMagicConfigSchema = z
  .object({
    model: z.string().catch("")
  })
  .catch(() => ({ model: "" }));

/**
 * One named custom endpoint. Power users keep a list of these (e.g. one for a remote LiteLLM,
 * one for a local Ollama with a non-default model) and pick which is active.
 */
const LocalAdvancedEndpointSchema = z.object({
  id: z.string().min(1),
  label: z.string().catch(""),
  baseUrl: z.string().min(1).catch(DEFAULT_OLLAMA_BASE_URL),
  model: z.string().catch(""),
  encryptedAuthToken: z.string().nullable().catch(null)
});

/**
 * Advanced mode owns a list of custom endpoints + which one is active. Independent of Magic.
 * Old single-endpoint configs are migrated in {@link normalizeLegacyAdvanced} before zod validates.
 */
const LocalAdvancedConfigSchema = z
  .object({
    endpoints: z.array(LocalAdvancedEndpointSchema).catch([]),
    activeId: z.string().nullable().catch(null)
  })
  .catch(() => ({ endpoints: [], activeId: null }));

const LocalConfigSchema = z
  .object({
    mode: z.enum(["magic", "advanced"]).catch("magic"),
    magic: LocalMagicConfigSchema,
    advanced: LocalAdvancedConfigSchema
  })
  .catch(() => ({
    mode: "magic" as const,
    magic: { model: "" },
    advanced: { endpoints: [], activeId: null }
  }));

const AiConfigSchema = z
  .object({
    provider: z.enum(["anthropic", "local"]).catch("anthropic"),
    anthropic: AnthropicConfigSchema,
    local: LocalConfigSchema
  })
  .catch(() => ({
    provider: "anthropic" as const,
    anthropic: { model: DEFAULT_ANTHROPIC_MODEL, encryptedApiKey: null },
    local: {
      mode: "magic" as const,
      magic: { model: "" },
      advanced: { endpoints: [], activeId: null }
    }
  }));

export type AiConfig = z.infer<typeof AiConfigSchema>;
export type AiProvider = AiConfig["provider"];
export type AiLocalMode = AiConfig["local"]["mode"];

function defaultAiConfig(): AiConfig {
  return AiConfigSchema.parse(undefined);
}

/**
 * Three-mode connection config. `community` is the free path against public OSS
 * providers; `mapos_cloud` and `self_hosted` route through a MapOS server. Any
 * invalid persisted shape falls back to `community` via `.catch()` so a broken
 * config never bricks startup.
 */
const ServicesConfigSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("community") }),
    z.object({
      mode: z.literal("mapos_cloud"),
      authToken: z.string().optional()
    }),
    z.object({
      mode: z.literal("self_hosted"),
      baseUrl: z.string().min(1),
      authToken: z.string().optional()
    })
  ])
  .catch(() => ({ mode: "community" as const }));

export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;
export type ServicesMode = ServicesConfig["mode"];

function defaultServicesConfig(): ServicesConfig {
  return ServicesConfigSchema.parse(undefined);
}

export type MaposJson = {
  /** Absolute paths to vault roots. Order is stable; active vault is tracked separately. */
  vaults: string[];
  /** Absolute path of the currently active vault. Defaults to vaults[0] if absent. */
  activeVault?: string;
  /** AI provider configuration (global, not per-vault). */
  ai: AiConfig;
  /** Network services configuration (community / cloud / self-hosted). */
  services: ServicesConfig;
};

function defaultConfig(): MaposJson {
  // No default vault — onboarding registers the user's chosen vault. An empty list
  // means "first launch / onboarding pending" everywhere it's read.
  return { vaults: [], ai: defaultAiConfig(), services: defaultServicesConfig() };
}

/**
 * Migrate the legacy single-endpoint shape (`{ baseUrl, model, encryptedAuthToken }`) to the
 * new list shape (`{ endpoints: [...], activeId }`). If the legacy slot was unconfigured we
 * drop it; if it had a model we keep it as a single migrated endpoint set as active.
 */
function normalizeLegacyAdvanced(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.endpoints)) return r;
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl : "";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  const encryptedAuthToken =
    typeof r.encryptedAuthToken === "string" ? r.encryptedAuthToken : null;
  if (model.length > 0) {
    const id = randomUUID();
    return {
      endpoints: [
        {
          id,
          label: "Custom",
          baseUrl: baseUrl || DEFAULT_OLLAMA_BASE_URL,
          model,
          encryptedAuthToken
        }
      ],
      activeId: id
    };
  }
  return { endpoints: [], activeId: null };
}

function parseAiConfig(raw: unknown): AiConfig {
  // Pre-zod migration for the legacy `local.advanced` single-endpoint shape.
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const local = r.local;
    if (local && typeof local === "object") {
      const advanced = (local as Record<string, unknown>).advanced;
      const migrated = normalizeLegacyAdvanced(advanced);
      if (migrated !== advanced) {
        return AiConfigSchema.parse({
          ...r,
          local: { ...(local as Record<string, unknown>), advanced: migrated }
        });
      }
    }
  }
  return AiConfigSchema.parse(raw);
}

/** True if the on-disk shape predates the multi-endpoint schema and needs to be persisted. */
function rawHasLegacyAdvanced(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const ai = (raw as Record<string, unknown>).ai;
  if (!ai || typeof ai !== "object") return false;
  const local = (ai as Record<string, unknown>).local;
  if (!local || typeof local !== "object") return false;
  const advanced = (local as Record<string, unknown>).advanced;
  if (!advanced || typeof advanced !== "object") return false;
  return !Array.isArray((advanced as Record<string, unknown>).endpoints);
}

function parseConfig(raw: string): MaposJson | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const vaults = (parsed as { vaults?: unknown }).vaults;
    if (!Array.isArray(vaults) || vaults.some((v) => typeof v !== "string")) return null;
    const activeVault = (parsed as { activeVault?: unknown }).activeVault;
    const ai = parseAiConfig((parsed as { ai?: unknown }).ai);
    const services = ServicesConfigSchema.parse((parsed as { services?: unknown }).services);
    return {
      vaults: [...vaults],
      ...(typeof activeVault === "string" ? { activeVault } : {}),
      ai,
      services
    };
  } catch {
    return null;
  }
}

/**
 * True iff `mapos.json` exists in the app state dir. Pure check — no side effects, no
 * directory creation. Use this to detect a true first launch before deciding whether to
 * boot into the main app or the onboarding flow.
 */
export function maposConfigExists(appStateDir: string): boolean {
  return existsSync(join(appStateDir, MAPOS_CONFIG_FILENAME));
}

/**
 * Ensures the app state directory exists and returns `mapos.json` (creates default if missing).
 * Pass `app.getPath("userData")` from the Electron main process.
 * A corrupt config is repaired to the default (empty vaults) and written back.
 */
export function loadOrInitMaposConfig(appStateDir: string): MaposJson {
  mkdirSync(appStateDir, { recursive: true });
  const configPath = join(appStateDir, MAPOS_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    const cfg = defaultConfig();
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
    return cfg;
  }
  const rawText = readFileSync(configPath, "utf-8");
  const parsed = parseConfig(rawText);
  if (!parsed) {
    const cfg = defaultConfig();
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
    return cfg;
  }
  // If we just migrated the legacy advanced shape, persist immediately so the generated
  // endpoint id is stable across loads (randomUUID is non-deterministic).
  let rawJson: unknown = null;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    /* unreachable — parseConfig already succeeded */
  }
  if (rawHasLegacyAdvanced(rawJson)) {
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  }
  return parsed;
}

/**
 * Onboarding is pending if no config file exists yet, or one exists but no vaults are
 * registered (e.g. the user closed the app mid-onboarding). The renderer reads this once
 * at startup to decide whether to mount the main app or the onboarding screen.
 */
export function isOnboardingPending(appStateDir: string): boolean {
  if (!maposConfigExists(appStateDir)) return true;
  const cfg = loadOrInitMaposConfig(appStateDir);
  return cfg.vaults.length === 0;
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
    ai: cfg.ai,
    services: cfg.services
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
  const next: MaposJson = {
    vaults: normalized,
    activeVault: resolved,
    ai: cfg.ai,
    services: cfg.services
  };
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
    ai: cfg.ai,
    services: cfg.services
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
  const nextActive = activeResolved && activeResolved !== resolved ? activeResolved : undefined;
  const next: MaposJson = {
    vaults: nextVaults,
    ...(nextActive ? { activeVault: nextActive } : {}),
    ai: cfg.ai,
    services: cfg.services
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
 * are deep-merged so callers can update one slice (e.g. just the API key, or just Magic's model)
 * without supplying the rest. The nested `local.magic` and `local.advanced` slots are also
 * deep-merged independently — updating one never clobbers the other.
 */
export type AiAdvancedPartial = {
  /** When provided, fully replaces the endpoints list. */
  endpoints?: AiConfig["local"]["advanced"]["endpoints"];
  /** When provided (including null), sets which endpoint is active. */
  activeId?: string | null;
};

export function updateAiConfigInFile(
  appStateDir: string,
  partial: {
    provider?: AiProvider;
    anthropic?: Partial<AiConfig["anthropic"]>;
    local?: {
      mode?: AiLocalMode;
      magic?: Partial<AiConfig["local"]["magic"]>;
      advanced?: AiAdvancedPartial;
    };
  }
): MaposJson {
  const cfg = loadOrInitMaposConfig(appStateDir);
  const localPartial = partial.local ?? {};
  const next: MaposJson = {
    vaults: cfg.vaults,
    ...(cfg.activeVault ? { activeVault: cfg.activeVault } : {}),
    services: cfg.services,
    ai: {
      provider: partial.provider ?? cfg.ai.provider,
      anthropic: { ...cfg.ai.anthropic, ...(partial.anthropic ?? {}) },
      local: {
        mode: localPartial.mode ?? cfg.ai.local.mode,
        magic: { ...cfg.ai.local.magic, ...(localPartial.magic ?? {}) },
        advanced: {
          endpoints: localPartial.advanced?.endpoints ?? cfg.ai.local.advanced.endpoints,
          activeId:
            localPartial.advanced && "activeId" in localPartial.advanced
              ? (localPartial.advanced.activeId ?? null)
              : cfg.ai.local.advanced.activeId
        }
      }
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
