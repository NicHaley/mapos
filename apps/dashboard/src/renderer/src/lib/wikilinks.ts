import type { FileNode } from "../../../shared/types";

export type VaultMdFile = {
  title: string;
  /** Vault-relative path without the `.md` extension, `/`-separated (e.g. `tokyo/kinka-izakaya`). */
  relPath: string;
  filePath: string;
};

/** Extract de-duplicated `[[title]]` titles from markdown body, ignoring fenced/inline code. */
export function extractWikilinkTitles(markdown: string): string[] {
  const stripped = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const titles = new Set<string>();
  const re = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null = re.exec(stripped);
  while (match !== null) {
    const title = match[1].trim();
    if (title) titles.add(title);
    match = re.exec(stripped);
  }
  return [...titles];
}

/** Flatten a vault FileNode tree into the shape used for wikilink lookups. */
export function flattenMdFiles(nodes: FileNode[], prefix = ""): VaultMdFile[] {
  const result: VaultMdFile[] = [];
  for (const node of nodes) {
    if (node.type === "file" && node.name.endsWith(".md")) {
      const title = node.name.replace(/\.md$/i, "");
      result.push({ title, relPath: prefix + title, filePath: node.path });
    } else if (node.type === "directory" && node.children) {
      result.push(...flattenMdFiles(node.children, `${prefix}${node.name}/`));
    }
  }
  return result;
}

/**
 * Resolve `[[link]]` text to a vault file: exact vault-relative path first
 * (`[[tokyo/kinka-izakaya]]`), then filename (`[[kinka-izakaya]]`, first match in tree order).
 */
export function resolveWikilinkTarget<T extends VaultMdFile>(
  files: T[],
  link: string
): T | undefined {
  return files.find((f) => f.relPath === link) ?? files.find((f) => f.title === link);
}

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
 * otherwise the vault-relative path, which {@link resolveWikilinkTarget} matches first.
 *
 * Works off the places index rather than a directory listing so callers stay synchronous.
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

/**
 * Reverse of {@link wikilinkForFile}: `[[link]]` text → an absolute vault path, or null when
 * nothing matches (the target was renamed or deleted — links are never rewritten on rename).
 * Mirrors {@link resolveWikilinkTarget}'s precedence: exact relative path, then filename.
 */
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
