import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MAPOS_CONFIG_FILENAME = "mapos.json";

const DEFAULT_VAULT_PATH = join(homedir(), "MapOS");

export type MaposJson = {
  /** Absolute paths to vault roots. Order is stable; active vault is tracked separately. */
  vaults: string[];
  /** Absolute path of the currently active vault. Defaults to vaults[0] if absent. */
  activeVault?: string;
};

function defaultConfig(): MaposJson {
  return { vaults: [DEFAULT_VAULT_PATH] };
}

function parseConfig(raw: string): MaposJson | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const vaults = (parsed as { vaults?: unknown }).vaults;
    if (!Array.isArray(vaults) || vaults.some((v) => typeof v !== "string")) return null;
    const activeVault = (parsed as { activeVault?: unknown }).activeVault;
    return {
      vaults: [...vaults],
      ...(typeof activeVault === "string" ? { activeVault } : {})
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
    ...(cfg.activeVault ? { activeVault: cfg.activeVault } : {})
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
  const next: MaposJson = { vaults: normalized, activeVault: resolved };
  writeFileSync(
    join(appStateDir, MAPOS_CONFIG_FILENAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8"
  );
  return { ok: true };
}

/**
 * One-time move from `<vault>/.mapos/*` into the app state dir when the new layout has no DB yet.
 */
export function migrateLegacyVaultInternals(vaultRoot: string, appStateDir: string): void {
  const legacyDot = join(vaultRoot, ".mapos");
  const legacyDb = join(legacyDot, "index.db");
  const newDb = join(appStateDir, "index.db");
  if (!existsSync(newDb) && existsSync(legacyDb)) {
    copyFileSync(legacyDb, newDb);
  }
  const legacyConv = join(legacyDot, "conversations");
  const newConv = join(appStateDir, "conversations");
  if (!existsSync(newConv) && existsSync(legacyConv)) {
    cpSync(legacyConv, newConv, { recursive: true });
  }
}
