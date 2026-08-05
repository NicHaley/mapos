import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "@mapos/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@mapos/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { type FileNode, isServableImageFile } from "@shared/types";
import { FolderPlusIcon, PlusIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { vaultImageUrl } from "../extensions/vault-image-extension";
import { modSymbol, useShortcuts } from "../hooks/use-shortcuts";
import { useVaultRoot } from "../hooks/use-vault-root";
import type { GeometryKind } from "../lib/geometry-wkt";
import { useLocalStorage } from "../lib/use-local-storage";
import { ImageLightbox, type LightboxData } from "./image-lightbox";
import type { PlaceRecord } from "./map-view";
import { NewNoteTooltipContent } from "./new-note-tooltip";
import { CollapsibleGroupLabel } from "./project-sidebar/collapsible-group-label";
import {
  type DragItem,
  MAPOS_DRAG_MIME,
  type SidebarDndBridge,
  parentDir,
  parseDragPayload
} from "./project-sidebar/dnd";
import { FileTreeNode } from "./project-sidebar/file-tree-node";
import { type PendingDelete, describePendingDelete } from "./project-sidebar/pending-delete";
import { VaultSwitcher } from "./project-sidebar/vault-switcher";
import { SettingsDialog } from "./settings-dialog";

// Shared empty initial value — the hook only reads it and callers always build
// new Sets, so it is never mutated.
const EMPTY_PATH_SET: Set<string> = new Set();
const SET_STORAGE = {
  serialize: (s: Set<string>) => JSON.stringify([...s]),
  deserialize: (raw: string) => new Set<string>(JSON.parse(raw))
};

// Memoized: App re-renders per frame while a mini card tracks the map; the sidebar
// (and its recursive file tree) only needs to render when its own props change.
export const ProjectSidebar = memo(function ProjectSidebar({
  selectedFilePath,
  selectedFolderPath,
  onSelectPlace,
  onSelectFolder,
  onSelectGeoJson,
  onDeletePath,
  onRenamePath,
  onMoved,
  geometryKinds
}: {
  selectedFilePath?: string;
  selectedFolderPath?: string;
  onSelectPlace?: (place: PlaceRecord, newTab?: boolean) => void;
  onSelectFolder?: (path: string, newTab?: boolean) => void;
  onSelectGeoJson?: (path: string) => void;
  onDeletePath?: (path: string, type: FileNode["type"]) => void;
  onRenamePath?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
  onMoved?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
  /** Indexed geometry per place-file path, so files on the map get map icons in the tree. */
  geometryKinds: Map<string, GeometryKind>;
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>([]);
  const vaultRoot = useVaultRoot();
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingRenamePath, setPendingRenamePath] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxData | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<
    "general" | "appearance" | "connections"
  >("general");
  const [filesGroupOpen, setFilesGroupOpen] = useState(true);
  // Folders the user has expanded, persisted per vault. Folders default closed
  // (Obsidian / Finder behavior); the key is null until the vault root resolves,
  // so the hook stays in-memory until then.
  const [openFolders, setOpenFolders] = useLocalStorage<Set<string>>(
    vaultRoot ? `mapos-open-folders:${vaultRoot}` : null,
    EMPTY_PATH_SET,
    SET_STORAGE
  );
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [pathAnchor, setPathAnchor] = useState<string | null>(null);

  const setFolderOpen = useCallback(
    (path: string, open: boolean) => {
      setOpenFolders((prev) => {
        const wasOpen = prev.has(path);
        if (wasOpen === open) return prev;
        const next = new Set(prev);
        if (open) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [setOpenFolders]
  );

  const load = useCallback(async () => {
    const nodes = await window.api.fs.listDir();
    setTree(nodes);
  }, []);

  useEffect(() => {
    void load();
    window.api.fs.onChange(() => {
      void load();
    });
    return () => window.api.fs.removeListeners();
  }, [load]);

  useEffect(() => {
    const clear = () => setDragOverTarget(null);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  // Returns the item's current path after the attempted move: the new path on
  // success, or the unchanged path if the move was a no-op or failed.
  const runMoveOne = useCallback(
    async (item: DragItem, destinationFolderPath: string): Promise<string> => {
      const { path: sourcePath, type: sourceType } = item;
      if (sourcePath === destinationFolderPath) return sourcePath;
      const parent = parentDir(sourcePath);
      if (parent === destinationFolderPath) return sourcePath;
      if (sourceType === "directory") {
        const slash = sourcePath.includes("\\") ? "\\" : "/";
        const prefix = sourcePath + slash;
        if (destinationFolderPath === sourcePath || destinationFolderPath.startsWith(prefix))
          return sourcePath;
      }
      const result = await window.api.fs.moveInto(sourcePath, destinationFolderPath);
      if (!result.success) {
        setMoveError(result.error);
        window.setTimeout(() => setMoveError(null), 4000);
        return sourcePath;
      }
      if (result.newPath !== sourcePath) {
        onMoved?.(sourcePath, result.newPath, sourceType === "directory");
      }
      return result.newPath;
    },
    [onMoved]
  );

  const runMove = useCallback(
    async (items: DragItem[], destinationFolderPath: string) => {
      if (!vaultRoot || items.length === 0) return;
      // Drop items nested inside another moved folder — they travel with the
      // parent, and moving the parent first would invalidate their paths.
      const movedDirs = items.filter((it) => it.type === "directory").map((it) => it.path);
      const top = items.filter(
        (item) =>
          !movedDirs.some(
            (dir) =>
              dir !== item.path && item.path.startsWith(dir + (dir.includes("\\") ? "\\" : "/"))
          )
      );
      // Sequential so the index/undo stack stay in sync between moves.
      const newPaths: string[] = [];
      for (const item of top) {
        newPaths.push(await runMoveOne(item, destinationFolderPath));
      }
      // Keep the moved items selected at their new locations.
      setSelectedPaths(new Set(newPaths));
      setPathAnchor(newPaths.length === 1 ? newPaths[0] : null);
    },
    [vaultRoot, runMoveOne]
  );

  const flatVisiblePaths = useCallback((): { path: string; type: FileNode["type"] }[] => {
    const out: { path: string; type: FileNode["type"] }[] = [];
    function walk(node: FileNode) {
      out.push({ path: node.path, type: node.type });
      if (node.type === "directory" && openFolders.has(node.path) && node.children) {
        for (const child of node.children) walk(child);
      }
    }
    for (const root of tree) walk(root);
    return out;
  }, [tree, openFolders]);

  const collectNodesByPaths = useCallback(
    (paths: Set<string>): FileNode[] => {
      const out: FileNode[] = [];
      function walk(node: FileNode) {
        if (paths.has(node.path)) out.push(node);
        if (node.type === "directory" && node.children) {
          for (const child of node.children) walk(child);
        }
      }
      for (const root of tree) walk(root);
      return out;
    },
    [tree]
  );

  const dndBridge = useMemo<SidebarDndBridge | undefined>(() => {
    if (!vaultRoot) return undefined;
    return {
      dragOverTarget,
      onDragStartNode: (e, path, type) => {
        // If the dragged node is part of a multi-selection, move the whole
        // selection; otherwise move just this node.
        const items: DragItem[] =
          selectedPaths.has(path) && selectedPaths.size > 1
            ? collectNodesByPaths(selectedPaths).map((n) => ({ path: n.path, type: n.type }))
            : [{ path, type }];
        e.dataTransfer.setData(MAPOS_DRAG_MIME, JSON.stringify({ items }));
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => setDragOverTarget(null),
      onFolderDragOver: (_e, folderPath) => {
        setDragOverTarget(folderPath);
      },
      onFolderDragLeave: () => {},
      onFolderDrop: (e, folderPath) => {
        setDragOverTarget(null);
        void runMove(parseDragPayload(e), folderPath);
      }
    };
  }, [vaultRoot, dragOverTarget, runMove, selectedPaths, collectNodesByPaths]);

  const openPath = useCallback(
    async (node: FileNode, newTab: boolean) => {
      if (node.type === "directory") {
        onSelectFolder?.(node.path, newTab);
        return;
      }
      if (node.path.toLowerCase().endsWith(".geojson")) {
        onSelectGeoJson?.(node.path);
        return;
      }
      // Images aren't places — peek them in the lightbox (same interaction as
      // inline note images), regardless of the new-tab modifier.
      if (isServableImageFile(node.name) && vaultRoot && node.path.startsWith(vaultRoot)) {
        const rel = node.path
          .slice(vaultRoot.length)
          .replace(/^[/\\]+/, "")
          .replaceAll("\\", "/");
        setLightbox({ src: vaultImageUrl(rel), caption: node.name });
        return;
      }
      const place = await window.api.places.getByPath(node.path);
      if (place) onSelectPlace?.(place, newTab);
    },
    [onSelectFolder, onSelectGeoJson, onSelectPlace, vaultRoot]
  );

  const handlePathClick = useCallback(
    (node: FileNode, e: React.MouseEvent) => {
      if (e.shiftKey && pathAnchor) {
        const flat = flatVisiblePaths();
        const a = flat.findIndex((x) => x.path === pathAnchor);
        const b = flat.findIndex((x) => x.path === node.path);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelectedPaths(new Set(flat.slice(lo, hi + 1).map((x) => x.path)));
          return;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl+click → open in a new (background) tab, browser convention.
        void openPath(node, true);
        return;
      }
      // Plain click: collapse multi-selection and open.
      setSelectedPaths(new Set([node.path]));
      setPathAnchor(node.path);
      void openPath(node, false);
    },
    [pathAnchor, flatVisiblePaths, openPath]
  );

  const handleOpenInNewTab = useCallback(
    (node: FileNode) => {
      void openPath(node, true);
    },
    [openPath]
  );

  async function confirmDelete() {
    if (!pendingDelete || isDeleting) return;
    setDeleteError(null);
    setIsDeleting(true);
    // Deleting a folder removes its contents; skip any selected descendants
    // so we don't error out trying to delete files that already vanished.
    const folderPaths = pendingDelete.nodes
      .filter((n) => n.type === "directory")
      .map((n) => n.path);
    const toDelete = pendingDelete.nodes.filter((n) => {
      for (const folder of folderPaths) {
        if (n.path === folder) continue;
        if (n.path.startsWith(`${folder}/`) || n.path.startsWith(`${folder}\\`)) {
          return false;
        }
      }
      return true;
    });
    for (const node of toDelete) {
      const result = await window.api.fs.deletePath(node.path);
      if (!result.success) {
        setDeleteError(result.error);
        setIsDeleting(false);
        return;
      }
      onDeletePath?.(node.path, node.type);
    }
    setSelectedPaths(new Set());
    setPathAnchor(null);
    setIsDeleting(false);
    setPendingDelete(null);
    await load();
  }

  const requestDeleteSelection = useCallback(() => {
    if (pendingDelete) return;
    if (selectedPaths.size > 0) {
      const nodes = collectNodesByPaths(selectedPaths);
      if (nodes.length === 0) return;
      setDeleteError(null);
      setPendingDelete({ kind: "files", nodes });
    }
  }, [pendingDelete, selectedPaths, collectNodesByPaths]);

  const clearMultiSelection = useCallback(() => {
    setSelectedPaths((prev) => (prev.size === 0 ? prev : new Set()));
    setPathAnchor(null);
  }, []);

  useShortcuts([
    { def: { key: "n", meta: true }, handler: () => void createNoteIn(vaultRoot) },
    {
      def: { key: ",", meta: true },
      handler: () => {
        setSettingsInitialPage("general");
        setSettingsOpen(true);
      }
    },
    { def: { key: "Backspace" }, handler: requestDeleteSelection },
    { def: { key: "Delete" }, handler: requestDeleteSelection },
    { def: { key: "Escape" }, handler: clearMultiSelection }
  ]);

  // Allow other components to deep-link into a specific settings page.
  useEffect(() => {
    function handleOpenSettings(e: Event): void {
      const detail = (e as CustomEvent<{ section?: "general" | "appearance" | "connections" }>)
        .detail;
      setSettingsInitialPage(detail?.section ?? "general");
      setSettingsOpen(true);
    }
    window.addEventListener("mapos:open-settings", handleOpenSettings);
    return () => window.removeEventListener("mapos:open-settings", handleOpenSettings);
  }, []);

  async function createNoteIn(parentPath: string | null) {
    if (!parentPath) return;
    const result = await window.api.fs.createNoteFile({ parentFolderPath: parentPath });
    if (result.success) {
      // The note opens in the panel with its title selected (justCreated), so we
      // don't also start an inline rename in the tree — two focus targets conflict.
      const filePath = result.filePath;
      const title = (filePath.split(/[/\\]/).pop() ?? "Untitled.md").replace(/\.md$/i, "");
      const place: PlaceRecord = (await window.api.places.getByPath(filePath)) ?? {
        title,
        type: "note",
        filePath
      };
      onSelectPlace?.({ ...place, justCreated: true });
    }
  }

  async function createFolderIn(parentPath: string | null) {
    if (!parentPath) return;
    const result = await window.api.fs.createFolder({
      parentFolderPath: parentPath,
      folderName: "New folder"
    });
    if (result.success) {
      setPendingRenamePath(result.folderPath);
    }
  }

  return (
    <Sidebar collapsible="offcanvas" variant="sidebar">
      {/* Clears the floating top-bar controls that sit over the sidebar's top edge. */}
      <div className="h-10 shrink-0" aria-hidden />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => void createNoteIn(vaultRoot)}>
                      <SquarePenIcon /> New note
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                }
              />
              <NewNoteTooltipContent side="right" />
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => {
                        setSettingsInitialPage("general");
                        setSettingsOpen(true);
                      }}
                    >
                      <SettingsIcon /> Settings
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                }
              />
              <TooltipContent side="right">
                Manage configurations
                <KbdGroup>
                  <Kbd>{modSymbol}</Kbd>
                  <Kbd>,</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="pb-0">
          <div className="group/group-header relative mb-0.5 flex flex-col">
            <CollapsibleGroupLabel
              label="Vault"
              open={filesGroupOpen}
              onToggle={() => setFilesGroupOpen((o) => !o)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarGroupAction
                    title="Add"
                    className="top-1.5 right-1 opacity-0 transition-opacity group-hover/group-header:opacity-100 focus-visible:opacity-100 data-open:opacity-100 hover:bg-hover-strong hover:text-sidebar-accent-foreground"
                  >
                    <PlusIcon />
                    <span className="sr-only">Add file or folder</span>
                  </SidebarGroupAction>
                }
              />
              <DropdownMenuContent side="right" align="start" className="w-auto">
                <DropdownMenuItem
                  onClick={() => {
                    setFilesGroupOpen(true);
                    void createNoteIn(vaultRoot);
                  }}
                >
                  <SquarePenIcon />
                  New note
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setFilesGroupOpen(true);
                    void createFolderIn(vaultRoot);
                  }}
                >
                  <FolderPlusIcon />
                  New folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {moveError ? (
            <p className="mx-1 mb-2 text-xs text-destructive" role="alert">
              {moveError}
            </p>
          ) : null}
          {filesGroupOpen && (
            <div className="flex min-h-0 flex-1 flex-col">
              <ContextMenu>
                <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>
                  <div className="flex min-h-0 flex-1 flex-col">
                    {tree.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-sidebar-foreground/50">No files</p>
                    ) : null}
                    <SidebarMenu className="shrink-0 gap-0.5">
                      {tree.map((node) => (
                        <FileTreeNode
                          key={node.path}
                          node={node}
                          depth={0}
                          selectedFilePath={selectedFilePath}
                          selectedFolderPath={selectedFolderPath}
                          selectedPaths={selectedPaths}
                          openFolders={openFolders}
                          setFolderOpen={setFolderOpen}
                          autoRenamePath={pendingRenamePath}
                          onAutoRenameConsumed={() => setPendingRenamePath(null)}
                          onPathClick={handlePathClick}
                          onOpenInNewTab={handleOpenInNewTab}
                          onRequestDelete={(node) => {
                            setDeleteError(null);
                            // If the right-clicked item is part of an active multi-selection,
                            // delete the whole selection. Otherwise delete just the one.
                            if (selectedPaths.size > 1 && selectedPaths.has(node.path)) {
                              const nodes = collectNodesByPaths(selectedPaths);
                              setPendingDelete({ kind: "files", nodes });
                            } else {
                              setPendingDelete({ kind: "files", nodes: [node] });
                            }
                          }}
                          onRenameComplete={onRenamePath}
                          onCreateFolderIn={(path) => void createFolderIn(path)}
                          onCreateNoteIn={(path) => void createNoteIn(path)}
                          geometryKinds={geometryKinds}
                          dnd={dndBridge}
                        />
                      ))}
                    </SidebarMenu>
                    {vaultRoot && dndBridge ? (
                      <div
                        aria-hidden
                        className="h-6"
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          setDragOverTarget(vaultRoot);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragOverTarget(null);
                          void runMove(parseDragPayload(e), vaultRoot);
                        }}
                      />
                    ) : null}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => void createNoteIn(vaultRoot)}>
                    <SquarePenIcon />
                    New note
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => void createFolderIn(vaultRoot)}>
                    <FolderPlusIcon />
                    New folder
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarGroup className="p-0">
          <VaultSwitcher />
        </SidebarGroup>
      </SidebarFooter>
      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          {(() => {
            if (!pendingDelete) {
              return (
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete?</AlertDialogTitle>
                </AlertDialogHeader>
              );
            }
            const { title, description } = describePendingDelete(pendingDelete);
            return (
              <AlertDialogHeader>
                <AlertDialogTitle>{title}</AlertDialogTitle>
                <AlertDialogDescription>{description}</AlertDialogDescription>
                {deleteError ? (
                  <AlertDialogDescription className="text-destructive">
                    {deleteError}
                  </AlertDialogDescription>
                ) : null}
              </AlertDialogHeader>
            );
          })()}
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (isDeleting) return;
                setPendingDelete(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={() => {
                void confirmDelete();
              }}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialPage={settingsInitialPage}
      />
      {lightbox && (
        <ImageLightbox key={lightbox.src} image={lightbox} onClose={() => setLightbox(null)} />
      )}
    </Sidebar>
  );
});
