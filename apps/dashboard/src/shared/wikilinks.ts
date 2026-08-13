/** Vault-relative path without the `.md` extension, `/`-separated. */
function relPathNoExt(filePath: string, vaultRoot: string): string {
  const rel =
    vaultRoot && filePath.startsWith(vaultRoot)
      ? filePath.slice(vaultRoot.length).replace(/^[/\\]/, "")
      : filePath;
  return rel.replace(/\.md$/i, "").replace(/\\/g, "/");
}

function titleOfPath(filePath: string): string {
  return (filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.md$/i, "");
}

/**
 * The `[[link]]` text for a vault file — its bare filename when that is unique in the vault,
 * otherwise the vault-relative path.
 */
export function wikilinkForFile(
  filePath: string,
  vaultRoot: string,
  allFilePaths: Iterable<string>
): string {
  const title = titleOfPath(filePath);
  let sameTitle = 0;
  for (const p of allFilePaths) {
    if (titleOfPath(p) === title && ++sameTitle > 1) break;
  }
  return `[[${sameTitle > 1 ? relPathNoExt(filePath, vaultRoot) : title}]]`;
}

/** Reverse of {@link wikilinkForFile}: `[[link]]` text → an absolute vault path, or null. */
export function resolveWikilinkPath(
  link: string,
  vaultRoot: string,
  allFilePaths: Iterable<string>
): string | null {
  const needle = link.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
  if (!needle) return null;
  let byTitle: string | null = null;
  for (const p of allFilePaths) {
    if (relPathNoExt(p, vaultRoot) === needle) return p;
    if (byTitle === null && titleOfPath(p) === needle) byTitle = p;
  }
  return byTitle;
}
