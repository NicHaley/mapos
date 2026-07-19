import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vaultDotDir } from "./mapos-config";

/**
 * Per-vault appearance state (`.mapos/appearance.json`) — accent colour, map
 * colour, theme. Mirrors Obsidian's `.obsidian/appearance.json`. Values are opaque
 * strings here; the renderer owns validation and defaults, so unknown keys and
 * values written by other/newer versions survive read-merge-write round-trips.
 */
export function appearanceFilePath(vaultRoot: string): string {
  return join(vaultDotDir(vaultRoot), "appearance.json");
}

/** Missing, unreadable, malformed, or non-object file all read as `{}`. */
export function readVaultAppearance(vaultRoot: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(appearanceFilePath(vaultRoot), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/** Merge `patch` onto the file's current contents; a `null` value unsets the key. */
export function writeVaultAppearance(
  vaultRoot: string,
  patch: Record<string, string | null>
): { ok: true } | { ok: false; error: string } {
  const next = readVaultAppearance(vaultRoot);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  try {
    mkdirSync(vaultDotDir(vaultRoot), { recursive: true });
    writeFileSync(appearanceFilePath(vaultRoot), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  return { ok: true };
}
