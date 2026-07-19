import { readVaultConfig, writeVaultConfig } from "./vault-config";

/**
 * Per-vault appearance state (`.mapos/appearance.json`) — accent colour, map
 * colour, theme. Mirrors Obsidian's `.obsidian/appearance.json`. Values are opaque
 * strings here; the renderer owns validation and defaults, so unknown keys and
 * values written by other/newer versions survive read-merge-write round-trips.
 */
export function readVaultAppearance(vaultRoot: string): Record<string, unknown> {
  return readVaultConfig(vaultRoot, "appearance.json");
}

/** Merge `patch` onto the file's current contents; a `null` value unsets the key. */
export function writeVaultAppearance(
  vaultRoot: string,
  patch: Record<string, string | null>
): { ok: true } | { ok: false; error: string } {
  return writeVaultConfig(vaultRoot, "appearance.json", patch);
}
