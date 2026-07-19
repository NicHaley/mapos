import { useEffect, useState } from "react";

// Vault switches, renames, and onboarding all reload the renderer, so the
// active vault root is stable for the lifetime of a page load and safe to
// cache module-wide.
let cachedRoot: string | null = null;
let pending: Promise<string | null> | null = null;

function fetchVaultRoot(): Promise<string | null> {
  pending ??= window.api.fs.getVaultRoot().then(
    (root) => {
      cachedRoot = root;
      return root;
    },
    () => null
  );
  return pending;
}

/**
 * Active vault root; `null` until resolved. Use it to scope persisted
 * renderer state per vault (`` `some-key:${vaultRoot}` ``) — unscoped
 * localStorage keys leak state across vaults because every vault shares the
 * renderer origin. Keys should stay `null` (skip persistence) until the root
 * resolves.
 */
export function useVaultRoot(): string | null {
  const [root, setRoot] = useState<string | null>(cachedRoot);
  useEffect(() => {
    if (root !== null) return;
    let alive = true;
    void fetchVaultRoot().then((r) => {
      if (alive && r !== null) setRoot(r);
    });
    return () => {
      alive = false;
    };
  }, [root]);
  return root;
}
