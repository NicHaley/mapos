import { realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/**
 * Resolve `target` through symlinks (or its parent, if `target` doesn't exist
 * yet) and confirm the result is at or under `root`. Prevents symlink-based
 * path traversal: a plain `target.startsWith(root)` check passes for a path
 * like `vault/legit/file.md` even when `vault/legit` is a symlink pointing
 * outside the vault — this helper rejects that.
 */
export async function resolveWithinRoot(
  target: string,
  root: string
): Promise<{ ok: true; resolved: string } | { ok: false; error: string }> {
  try {
    const resolvedRoot = await realpath(root);
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch {
      const parent = dirname(target);
      if (parent === target) return { ok: false, error: "Invalid path" };
      const resolvedParent = await realpath(parent);
      resolved = join(resolvedParent, target.slice(parent.length + 1));
    }
    const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    if (resolved !== resolvedRoot && !resolved.startsWith(rootPrefix)) {
      return { ok: false, error: "Path outside vault" };
    }
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
