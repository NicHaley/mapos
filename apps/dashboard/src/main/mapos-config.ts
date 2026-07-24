import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { McpActivity } from "../shared/types";

export const MAPOS_CONFIG_FILENAME = "mapos.json";

const DEFAULT_VAULT_PATH = join(homedir(), "MapOS");

/**
 * Fixed default port for the local MCP server (127.0.0.1). Chosen high + uncommon to avoid
 * collisions; overridable via `mapos.json`. Clients connect to `http://127.0.0.1:<port>/mcp`.
 */
export const DEFAULT_MCP_PORT = 51737;

/**
 * App-level MCP server settings. Lives in `userData/mapos.json` (machine/secrets tier — the
 * bearer token must never enter a synced `.mapos/` file). Minted lazily on first access via
 * {@link getOrCreateMcpConfig}; `enabled` defaults to on so the server is reachable out of the
 * box, still gated by the token.
 */
const McpConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  /** Last witnessed client activity — lets the Connections badge survive app restarts. */
  lastClient: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
      at: z.number()
    })
    .optional()
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

function mintMcpToken(): string {
  return randomBytes(24).toString("base64url");
}

function freshMcpConfig(): McpConfig {
  return { enabled: true, port: DEFAULT_MCP_PORT, token: mintMcpToken() };
}

/**
 * Two-mode connection config. `local` is the free, fully-offline path: capabilities
 * come only from downloaded region packs (the offline overlay), never from public
 * providers. `cloud` routes through a MapOS server via the mapos_v1 adapter — an
 * optional `baseUrl` points at a custom/self-hosted server; its absence means the
 * canonical MapOS Cloud (not yet available). Any invalid persisted shape falls back
 * to `local` via `.catch()` so a broken config never bricks startup.
 */
/**
 * Slug of a downloaded region pack (e.g. "monaco") layered *on top of* the base
 * mode. It's an overlay, not a mode: capabilities the pack provides locally
 * (today only geocoding, from `<userData>/regions/<offlineRegion>/geocode.sqlite`)
 * are served offline, while everything else still uses the base mode. This is why
 * you can run cloud tiles and offline geocoding at the same time.
 */
const offlineRegion = z.string().optional();

const ServicesConfigSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("local"), offlineRegion }),
    z.object({
      mode: z.literal("cloud"),
      baseUrl: z.string().optional(),
      authToken: z.string().optional(),
      offlineRegion
    })
  ])
  .catch(() => ({ mode: "local" as const }));

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
  /** Network services configuration (local / cloud). */
  services: ServicesConfig;
  /** Local MCP server settings. Minted lazily (absent until first accessed). */
  mcp?: McpConfig;
};

function defaultConfig(): MaposJson {
  // No default vault — onboarding registers the user's chosen vault. An empty list
  // means "first launch / onboarding pending" everywhere it's read.
  return { vaults: [], services: defaultServicesConfig() };
}

/**
 * Migrate legacy service modes to the two-mode shape: `community` → `local`;
 * `self_hosted`/`mapos_cloud` → `cloud` (preserving any `baseUrl`/`authToken`).
 * Already-current or unrecognizable shapes pass through untouched (zod's `.catch()`
 * repairs the latter).
 */
function normalizeLegacyServices(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  const offline = typeof r.offlineRegion === "string" ? { offlineRegion: r.offlineRegion } : {};
  if (r.mode === "community") {
    return { mode: "local", ...offline };
  }
  if (r.mode === "self_hosted" || r.mode === "mapos_cloud") {
    return {
      mode: "cloud",
      ...(typeof r.baseUrl === "string" ? { baseUrl: r.baseUrl } : {}),
      ...(typeof r.authToken === "string" ? { authToken: r.authToken } : {}),
      ...offline
    };
  }
  return raw;
}

/** True if the persisted services mode predates the two-mode schema and needs migrating. */
function rawHasLegacyServices(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const services = (raw as Record<string, unknown>).services;
  if (!services || typeof services !== "object") return false;
  const mode = (services as Record<string, unknown>).mode;
  return mode === "community" || mode === "self_hosted" || mode === "mapos_cloud";
}

function parseConfig(raw: string): MaposJson | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const vaults = (parsed as { vaults?: unknown }).vaults;
    if (!Array.isArray(vaults) || vaults.some((v) => typeof v !== "string")) return null;
    const activeVault = (parsed as { activeVault?: unknown }).activeVault;
    const services = ServicesConfigSchema.parse(
      normalizeLegacyServices((parsed as { services?: unknown }).services)
    );
    const mcpParsed = McpConfigSchema.safeParse((parsed as { mcp?: unknown }).mcp);
    return {
      vaults: [...vaults],
      ...(typeof activeVault === "string" ? { activeVault } : {}),
      services,
      ...(mcpParsed.success ? { mcp: mcpParsed.data } : {})
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
  // If we just migrated a legacy services mode, persist immediately so the on-disk config
  // matches the running one.
  let rawJson: unknown = null;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    /* unreachable — parseConfig already succeeded */
  }
  if (rawHasLegacyServices(rawJson)) {
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
    services: cfg.services,
    ...(cfg.mcp ? { mcp: cfg.mcp } : {})
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
    services: cfg.services,
    ...(cfg.mcp ? { mcp: cfg.mcp } : {})
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
    services: cfg.services,
    ...(cfg.mcp ? { mcp: cfg.mcp } : {})
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
  // Removing the last vault is allowed — it leaves vaults empty, which the app reads
  // as "onboarding pending" and routes the user back to the welcome screen.
  const nextVaults = normalized.filter((p) => p !== resolved);
  const activeResolved = cfg.activeVault ? resolve(cfg.activeVault.trim()) : undefined;
  const nextActive = activeResolved && activeResolved !== resolved ? activeResolved : undefined;
  const next: MaposJson = {
    vaults: nextVaults,
    ...(nextActive ? { activeVault: nextActive } : {}),
    services: cfg.services,
    ...(cfg.mcp ? { mcp: cfg.mcp } : {})
  };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return { ok: true, config: next };
}

/**
 * Returns the path to a vault's per-vault state directory.
 */
export function vaultDotDir(vaultRoot: string): string {
  return join(vaultRoot, ".mapos");
}

/** Persist `mcp` onto `mapos.json`, preserving all other fields. Returns the written config. */
function writeMcpConfig(appStateDir: string, mcp: McpConfig): McpConfig {
  const cfg = loadOrInitMaposConfig(appStateDir);
  const next: MaposJson = { ...cfg, mcp };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return mcp;
}

/**
 * Returns the MCP config, minting + persisting a fresh one (enabled, default port, random
 * token) on first access. The token is a machine secret, so it lives here in `userData` and
 * never in a per-vault `.mapos/` file.
 */
export function getOrCreateMcpConfig(appStateDir: string): McpConfig {
  const cfg = loadOrInitMaposConfig(appStateDir);
  if (cfg.mcp) return cfg.mcp;
  return writeMcpConfig(appStateDir, freshMcpConfig());
}

/** Toggle the MCP server on/off; returns the updated config. */
export function setMcpEnabledInConfig(appStateDir: string, enabled: boolean): McpConfig {
  const current = getOrCreateMcpConfig(appStateDir);
  return writeMcpConfig(appStateDir, { ...current, enabled });
}

/** Mint a new token (invalidates existing client connections); returns the updated config. */
export function regenerateMcpTokenInConfig(appStateDir: string): McpConfig {
  // A new token orphans previously-connected clients, so their recorded activity no longer
  // proves a working setup — drop it alongside the mint.
  const { lastClient: _stale, ...current } = getOrCreateMcpConfig(appStateDir);
  return writeMcpConfig(appStateDir, { ...current, token: mintMcpToken() });
}

/**
 * Record witnessed MCP client activity, throttled: an identity change always persists;
 * timestamp-only refreshes write at most every 5 minutes ("last active" only needs to be
 * roughly right across restarts, and this fires on every request the server handles).
 */
export function recordMcpActivityInConfig(appStateDir: string, activity: McpActivity): void {
  const current = getOrCreateMcpConfig(appStateDir);
  const prev = current.lastClient;
  const sameIdentity = prev?.name === activity.name && prev?.version === activity.version;
  if (prev && sameIdentity && activity.at - prev.at < 5 * 60_000) return;
  writeMcpConfig(appStateDir, { ...current, lastClient: activity });
}
