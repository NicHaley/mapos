import type { FileNode } from "../../../shared/types";
import { resolveWikilinkPath, wikilinkForFile } from "../../../shared/wikilinks";

export { resolveWikilinkPath, wikilinkForFile };

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
