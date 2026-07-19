/**
 * Active-vault binding for AI config. Kept in a tiny module (no Pi SDK) so `index.ts` can
 * register a getter without pulling `ai.ts` onto the startup path. Empty string = no vault
 * yet (onboarding); callers stage the default model in userData until a vault boots.
 */
let getVaultRoot: () => string = () => "";

export function bindAiVaultRoot(getter: () => string): void {
  getVaultRoot = getter;
}

export function aiVaultRoot(): string {
  return getVaultRoot();
}
