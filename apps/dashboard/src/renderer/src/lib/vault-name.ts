/**
 * Cheap client-side validation for a new vault folder name. Catches obvious mistakes
 * before round-tripping to main; the main process re-validates on every IPC anyway.
 */
export function validateVaultName(name: string): { ok: true } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name cannot be empty." };
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { ok: false, error: "Name cannot contain slashes." };
  }
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
    return { ok: false, error: "Name cannot start with a dot." };
  }
  return { ok: true };
}

export const DEFAULT_VAULT_NAME = "MapOS Vault";
