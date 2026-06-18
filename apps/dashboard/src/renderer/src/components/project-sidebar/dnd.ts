import type { FileNode } from "@shared/types";

export const MAPOS_DRAG_MIME = "application/x-mapos-node";

export type DragItem = { path: string; type: FileNode["type"] };

export type SidebarDndBridge = {
  dragOverTarget: string | null;
  onDragStartNode: (e: React.DragEvent, path: string, type: FileNode["type"]) => void;
  onDragEnd: () => void;
  onFolderDragOver: (e: React.DragEvent, folderPath: string) => void;
  onFolderDragLeave: (e: React.DragEvent) => void;
  onFolderDrop: (e: React.DragEvent, folderPath: string) => void;
};

export function parseDragPayload(e: React.DragEvent): DragItem[] {
  try {
    const raw = e.dataTransfer.getData(MAPOS_DRAG_MIME);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { items?: DragItem[] };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter((it) => it?.path && it?.type);
  } catch {
    return [];
  }
}

export function parentDir(filePath: string): string {
  const n = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (n <= 0) return filePath.slice(0, 1);
  return filePath.slice(0, n);
}
