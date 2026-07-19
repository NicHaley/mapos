import type { FileNode } from "@shared/types";

export type PendingDelete = { kind: "files"; nodes: FileNode[] } | null;

export function displayNameForNode(node: FileNode): string {
  return node.type === "file" ? node.name.replace(/\.(md|geojson)$/i, "") : node.name;
}

function summarizeNames(names: string[], max = 5): string {
  if (names.length <= max) return names.map((n) => `"${n}"`).join(", ");
  const head = names
    .slice(0, max)
    .map((n) => `"${n}"`)
    .join(", ");
  return `${head} and ${names.length - max} more`;
}

export function describePendingDelete(p: NonNullable<PendingDelete>): {
  title: string;
  description: string;
} {
  const { nodes } = p;
  if (nodes.length === 1) {
    const n = nodes[0];
    const display = displayNameForNode(n);
    return {
      title: `Delete ${n.type === "directory" ? "folder" : "file"}?`,
      description:
        n.type === "directory"
          ? `This will permanently delete "${display}" and all its contents.`
          : `This will permanently delete "${display}".`
    };
  }
  const names = nodes.map(displayNameForNode);
  const folderCount = nodes.filter((n) => n.type === "directory").length;
  const folderNote = folderCount > 0 ? " Folder contents are also deleted." : "";
  return {
    title: `Delete ${nodes.length} items?`,
    description: `This will permanently delete ${summarizeNames(names)}.${folderNote}`
  };
}
