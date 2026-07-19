import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vaultDotDir } from "./mapos-config";

/**
 * Allowlisted basenames under `.mapos/` for canonical per-vault intent JSON.
 * Files are created lazily on first write — never stubbed empty at vault init.
 * See CLAUDE.md "`.mapos/` layout".
 */
export const VAULT_CONFIG_FILES = [
  "appearance.json",
  "app.json",
  "ai.json",
  "hotkeys.json",
  "workspace.json"
] as const;

export type VaultConfigFile = (typeof VAULT_CONFIG_FILES)[number];

const ALLOWED = new Set<string>(VAULT_CONFIG_FILES);

export function vaultConfigPath(vaultRoot: string, file: VaultConfigFile): string {
  if (!ALLOWED.has(file)) throw new Error(`Disallowed vault config file: ${file}`);
  return join(vaultDotDir(vaultRoot), file);
}

/** Missing, unreadable, malformed, or non-object file all read as `{}`. */
export function readVaultConfig(vaultRoot: string, file: VaultConfigFile): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(vaultConfigPath(vaultRoot, file), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** Merge `patch` onto the file's current contents; a `null` value unsets the key. */
export function writeVaultConfig(
  vaultRoot: string,
  file: VaultConfigFile,
  patch: Record<string, unknown | null>
): { ok: true } | { ok: false; error: string } {
  if (!ALLOWED.has(file)) return { ok: false, error: `Disallowed vault config file: ${file}` };
  const next = readVaultConfig(vaultRoot, file);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  try {
    mkdirSync(vaultDotDir(vaultRoot), { recursive: true });
    writeFileSync(vaultConfigPath(vaultRoot, file), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  return { ok: true };
}
