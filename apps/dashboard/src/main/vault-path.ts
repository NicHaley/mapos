import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Canonicalize `abs` even when the leaf doesn't exist yet: realpath the deepest
 * existing ancestor (so a symlink anywhere along the path can't smuggle the
 * target outside the vault), then re-append the not-yet-created tail.
 */
function canonicalize(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs; // reached filesystem root without an existing ancestor
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  const realBase = realpathSync(cur);
  return tail.length ? join(realBase, ...tail) : realBase;
}

/**
 * Resolve a caller-supplied path and confine it to `vaultRoot`. Returns the
 * canonical absolute path when it is the vault root or lives inside it, or
 * `null` when it escapes via `..`, an absolute path outside the vault, or a
 * symlink that points out. A raw `startsWith(vaultRoot)` check catches none of
 * these — `/vault/../../etc/passwd` starts with `/vault/` yet resolves outside.
 */
export function resolveInVault(vaultRoot: string, input: string): string | null {
  if (typeof input !== "string" || input === "") return null;
  const root = canonicalize(resolve(vaultRoot));
  const target = canonicalize(resolve(root, input));
  if (target === root) return target;
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

/**
 * True if `input` targets the protected `.mapos/` subtree (config + the derived
 * index.db). Agent-facing writes must never land there — secrets and config are
 * off-limits, and index.db is a rebuildable cache written only by the indexer.
 */
export function isProtectedVaultPath(vaultRoot: string, input: string): boolean {
  const root = canonicalize(resolve(vaultRoot));
  const target = canonicalize(resolve(root, input));
  return relative(root, target).split(sep)[0] === ".mapos";
}
