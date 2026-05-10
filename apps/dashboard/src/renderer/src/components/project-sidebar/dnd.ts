import type { FileNode } from "@shared/types";

export const MAPOS_DRAG_MIME = "application/x-mapos-node";

export type SidebarDndBridge = {
  dragOverTarget: string | null;
  onDragStartNode: (e: React.DragEvent, path: string, type: FileNode["type"]) => void;
  onDragEnd: () => void;
  onFolderDragOver: (e: React.DragEvent, folderPath: string) => void;
  onFolderDragLeave: (e: React.DragEvent) => void;
  onFolderDrop: (e: React.DragEvent, folderPath: string) => void;
};

export function parseDragPayload(
  e: React.DragEvent
): { path: string; type: FileNode["type"] } | null {
  try {
    const raw = e.dataTransfer.getData(MAPOS_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { path?: string; type?: FileNode["type"] };
    if (!parsed.path || !parsed.type) return null;
    return { path: parsed.path, type: parsed.type };
  } catch {
    return null;
  }
}

export function parentDir(filePath: string): string {
  const n = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (n <= 0) return filePath.slice(0, 1);
  return filePath.slice(0, n);
}
