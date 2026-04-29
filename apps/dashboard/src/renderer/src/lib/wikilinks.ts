import type { FileNode } from "../../../shared/types";

export type VaultMdFile = { title: string; filePath: string };

/** Extract de-duplicated `[[title]]` titles from markdown body, ignoring fenced/inline code. */
export function extractWikilinkTitles(markdown: string): string[] {
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
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

/** Flatten a vault FileNode tree into the (title, filePath) shape used for wikilink lookups. */
export function flattenMdFiles(nodes: FileNode[]): VaultMdFile[] {
  const result: VaultMdFile[] = [];
  for (const node of nodes) {
    if (node.type === "file" && node.name.endsWith(".md")) {
      result.push({ title: node.name.replace(/\.md$/i, ""), filePath: node.path });
    } else if (node.type === "directory" && node.children) {
      result.push(...flattenMdFiles(node.children));
    }
  }
  return result;
}
