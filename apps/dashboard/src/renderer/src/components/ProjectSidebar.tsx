import { cn } from "@renderer/lib/utils";
import type { FileNode } from "@shared/types";
import {
  ChevronRightIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  MessageCirclePlusIcon,
  SettingsIcon,
  SquarePenIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modSymbol, useShortcuts } from "../hooks/useShortcuts";
import type { PlaceRecord } from "./MapView";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "./ui/context-menu";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "./ui/sidebar";
import { ErrorTooltip, Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const MAPOS_DRAG_MIME = "application/x-mapos-node";

function parentDir(filePath: string): string {
  const n = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (n <= 0) return filePath.slice(0, 1);
  return filePath.slice(0, n);
}

export type SidebarDndBridge = {
  dragOverTarget: string | null;
  onDragStartNode: (e: React.DragEvent, path: string, type: FileNode["type"]) => void;
  onDragEnd: () => void;
  onFolderDragOver: (e: React.DragEvent, folderPath: string) => void;
  onFolderDragLeave: (e: React.DragEvent) => void;
  onFolderDrop: (e: React.DragEvent, folderPath: string) => void;
};

function parseDragPayload(e: React.DragEvent): { path: string; type: FileNode["type"] } | null {
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

function fileIcon(name: string) {
  if (name.endsWith(".md"))
    return <FileTextIcon className="size-3.5 shrink-0 text-sidebar-foreground/50" />;
  return <FileIcon className="size-3.5 shrink-0 text-sidebar-foreground/50" />;
}

function FileTreeNode({
  node,
  depth,
  selectedFilePath,
  selectedFolderPath,
  autoRenamePath,
  onAutoRenameConsumed,
  onSelectPlace,
  onSelectFolder,
  onRequestDelete,
  onRenameComplete,
  onCreateFolderIn,
  onCreateNoteIn,
  dnd
}: {
  node: FileNode;
  depth: number;
  selectedFilePath?: string;
  selectedFolderPath?: string;
  autoRenamePath?: string | null;
  onAutoRenameConsumed?: () => void;
  onSelectPlace?: (place: PlaceRecord, newTab?: boolean) => void;
  onSelectFolder?: (path: string) => void;
  onRequestDelete?: (node: FileNode) => void;
  onRenameComplete?: (oldPath: string, newPath: string) => void;
  onCreateFolderIn?: (path: string) => void;
  onCreateNoteIn?: (path: string) => void;
  dnd?: SidebarDndBridge;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    if (!autoRenamePath || node.type !== "directory") return;
    if (autoRenamePath === node.path) {
      setOpen(true);
      startRename();
      onAutoRenameConsumed?.();
    } else if (autoRenamePath.startsWith(`${node.path}/`)) {
      setOpen(true);
    }
  }, [autoRenamePath, node.path, node.type, onAutoRenameConsumed]);

  function startRename() {
    const displayName = node.type === "file" ? node.name.replace(/\.md$/, "") : node.name;
    setRenameDraft(displayName);
    setRenameError(null);
    setIsRenaming(true);
  }

  async function commitRename() {
    const draft = renameDraft.trim();
    if (!draft) {
      setRenameError("Name cannot be empty");
      inputRef.current?.focus();
      return;
    }
    const originalDisplay = node.type === "file" ? node.name.replace(/\.md$/, "") : node.name;
    if (draft === originalDisplay) {
      setIsRenaming(false);
      setRenameError(null);
      return;
    }
    const result = await window.api.fs.renameFile(node.path, draft);
    if (!result.success) {
      setRenameError(result.error ?? "Rename failed");
      inputRef.current?.focus();
      return;
    }
    setIsRenaming(false);
    setRenameError(null);
    onRenameComplete?.(node.path, result.newPath);
  }

  function cancelRename() {
    setIsRenaming(false);
    setRenameError(null);
  }

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  const renameInput = (
    <div className="flex min-h-0 flex-1 min-w-0 items-center">
      <ErrorTooltip error={renameError}>
        <input
          ref={inputRef}
          value={renameDraft}
          onChange={(e) => {
            setRenameDraft(e.target.value);
            setRenameError(null);
          }}
          onKeyDown={handleRenameKeyDown}
          onBlur={cancelRename}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "w-full h-5 min-h-5 box-border rounded p-0 text-sm leading-5",
            "bg-sidebar-background text-sidebar-foreground border-0 outline-none appearance-none",
            renameError ? "ring-2 ring-inset ring-destructive" : "ring-2 ring-inset ring-blue-500"
          )}
        />
      </ErrorTooltip>
    </div>
  );

  const menuItems = (
    <>
      <ContextMenuItem onClick={() => void window.api.fs.revealInFinder(node.path)}>
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => onRequestDelete?.(node)}>
        Delete
      </ContextMenuItem>
    </>
  );

  const folderMenuItems = (
    <>
      <ContextMenuItem onClick={() => onCreateNoteIn?.(node.path)}>New Note</ContextMenuItem>
      <ContextMenuItem onClick={() => onCreateFolderIn?.(node.path)}>New Folder</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void window.api.fs.revealInFinder(node.path)}>
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => onRequestDelete?.(node)}>
        Delete
      </ContextMenuItem>
    </>
  );

  if (node.type === "directory") {
    const isActive = node.path === selectedFolderPath;
    const folderDropZone = Boolean(dnd && dnd.dragOverTarget === node.path);
    return (
      <div className={cn("rounded", folderDropZone && "bg-blue-600/10")}>
        <ContextMenu>
          <ContextMenuTrigger render={<div />}>
            <div
              draggable={Boolean(dnd) && !isRenaming}
              onDragStart={(e) => {
                if (!dnd || isRenaming) return;
                dnd.onDragStartNode(e, node.path, "directory");
              }}
              onDragEnd={() => dnd?.onDragEnd()}
              onDragOver={(e) => {
                if (!dnd) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                dnd.onFolderDragOver(e, node.path);
              }}
              onDragLeave={(e) => dnd?.onFolderDragLeave(e)}
              onDrop={(e) => {
                if (!dnd) return;
                e.preventDefault();
                e.stopPropagation();
                dnd.onFolderDrop(e, node.path);
              }}
              className={cn(
                "flex items-center rounded text-sm",
                folderDropZone
                  ? "bg-blue-600/90 text-white [&_svg]:text-white/90"
                  : isActive
                    ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
              )}
              style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
            >
              <button
                onClick={() => setOpen((o) => !o)}
                className="p-1 shrink-0 hover:bg-white/10 rounded"
                type="button"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3 shrink-0 text-sidebar-foreground/40 transition-transform",
                    open && "rotate-90"
                  )}
                />
              </button>
              <button
                onClick={() => {
                  if (!isRenaming) onSelectFolder?.(node.path);
                }}
                className="flex flex-1 items-center gap-1.5 py-1 pr-2 text-left min-w-0"
                type="button"
              >
                {open ? (
                  <FolderOpenIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
                ) : (
                  <FolderIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
                )}
                {isRenaming ? renameInput : <span className="truncate">{node.name}</span>}
              </button>
            </div>
            {open && node.children && (
              <div>
                {node.children.map((child) => (
                  <FileTreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    selectedFilePath={selectedFilePath}
                    selectedFolderPath={selectedFolderPath}
                    autoRenamePath={autoRenamePath}
                    onAutoRenameConsumed={onAutoRenameConsumed}
                    onSelectPlace={onSelectPlace}
                    onSelectFolder={onSelectFolder}
                    onRequestDelete={onRequestDelete}
                    onRenameComplete={onRenameComplete}
                    onCreateFolderIn={onCreateFolderIn}
                    onCreateNoteIn={onCreateNoteIn}
                    dnd={dnd}
                  />
                ))}
              </div>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>{folderMenuItems}</ContextMenuContent>
        </ContextMenu>
      </div>
    );
  }

  const isActive = node.path === selectedFilePath;
  const parentFolder = parentDir(node.path);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          isRenaming ? (
            <div
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm",
                isActive
                  ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                  : "text-sidebar-foreground"
              )}
              style={{ paddingLeft: `${0.5 + depth * 0.875 + 0.875}rem` }}
            />
          ) : (
            <button
              draggable={Boolean(dnd) && !isRenaming}
              onDragStart={(e) => {
                if (!dnd || isRenaming) return;
                dnd.onDragStartNode(e, node.path, "file");
              }}
              onDragEnd={() => dnd?.onDragEnd()}
              onDragOver={(e) => {
                if (!dnd || isRenaming) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                dnd.onFolderDragOver(e, parentFolder);
              }}
              onDrop={(e) => {
                if (!dnd || isRenaming) return;
                e.preventDefault();
                e.stopPropagation();
                dnd.onFolderDrop(e, parentFolder);
              }}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-sidebar-accent",
                isActive
                  ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                  : "text-sidebar-foreground"
              )}
              style={{ paddingLeft: `${0.5 + depth * 0.875 + 0.875}rem` }}
              onClick={async (e) => {
                const place = await window.api.places.getByPath(node.path);
                if (place) onSelectPlace?.(place, e.metaKey || e.ctrlKey);
              }}
              type="button"
            />
          )
        }
      >
        {fileIcon(node.name)}
        {isRenaming ? (
          renameInput
        ) : (
          <span className="truncate">{node.name.replace(/\.[^.]+$/, "")}</span>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>{menuItems}</ContextMenuContent>
    </ContextMenu>
  );
}

export function ProjectSidebar({
  selectedFilePath,
  selectedFolderPath,
  onSelectPlace,
  onSelectFolder,
  onDeletePath,
  onRenamePath,
  onMoved
}: {
  selectedFilePath?: string;
  selectedFolderPath?: string;
  onSelectPlace?: (place: PlaceRecord, newTab?: boolean) => void;
  onSelectFolder?: (path: string) => void;
  onDeletePath?: (path: string, type: FileNode["type"]) => void;
  onRenamePath?: (oldPath: string, newPath: string) => void;
  onMoved?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [vaultRoot, setVaultRoot] = useState<string>("");
  const [pendingDelete, setPendingDelete] = useState<FileNode | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingRenamePath, setPendingRenamePath] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const nodes = await window.api.fs.listDir();
    setTree(nodes);
  }, []);

  useEffect(() => {
    void load();
    void window.api.fs.getVaultRoot().then(setVaultRoot);
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

  const runMove = useCallback(
    async (sourcePath: string, sourceType: FileNode["type"], destinationFolderPath: string) => {
      if (!vaultRoot) return;
      if (sourcePath === destinationFolderPath) return;
      const parent = parentDir(sourcePath);
      if (parent === destinationFolderPath) return;
      if (sourceType === "directory") {
        const slash = sourcePath.includes("\\") ? "\\" : "/";
        const prefix = sourcePath + slash;
        if (destinationFolderPath === sourcePath || destinationFolderPath.startsWith(prefix))
          return;
      }
      const result = await window.api.fs.moveInto(sourcePath, destinationFolderPath);
      if (!result.success) {
        setMoveError(result.error);
        window.setTimeout(() => setMoveError(null), 4000);
        return;
      }
      if (result.newPath !== sourcePath) {
        onMoved?.(sourcePath, result.newPath, sourceType === "directory");
      }
    },
    [vaultRoot, onMoved]
  );

  const dndBridge = useMemo<SidebarDndBridge | undefined>(() => {
    if (!vaultRoot) return undefined;
    return {
      dragOverTarget,
      onDragStartNode: (e, path, type) => {
        e.dataTransfer.setData(MAPOS_DRAG_MIME, JSON.stringify({ path, type }));
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => setDragOverTarget(null),
      onFolderDragOver: (_e, folderPath) => {
        setDragOverTarget(folderPath);
      },
      onFolderDragLeave: () => {},
      onFolderDrop: (e, folderPath) => {
        setDragOverTarget(null);
        const payload = parseDragPayload(e);
        if (!payload) return;
        void runMove(payload.path, payload.type, folderPath);
      }
    };
  }, [vaultRoot, dragOverTarget, runMove]);

  async function confirmDelete() {
    if (!pendingDelete || isDeleting) return;
    setDeleteError(null);
    setIsDeleting(true);
    const result = await window.api.fs.deletePath(pendingDelete.path);
    setIsDeleting(false);
    if (!result.success) {
      setDeleteError(result.error);
      return;
    }
    onDeletePath?.(pendingDelete.path, pendingDelete.type);
    setPendingDelete(null);
    await load();
  }

  useShortcuts([{ def: { key: "n", meta: true }, handler: () => void createNoteIn(vaultRoot) }]);

  async function createNoteIn(parentPath: string) {
    if (!parentPath) return;
    const result = await window.api.fs.createNoteFile({ parentFolderPath: parentPath });
    if (result.success) {
      setPendingRenamePath(result.filePath);
      const filePath = result.filePath;
      const title = (filePath.split(/[/\\]/).pop() ?? "Untitled.md").replace(/\.md$/i, "");
      const place = (await window.api.places.getByPath(filePath)) ?? {
        title,
        type: "note",
        filePath
      };
      onSelectPlace?.(place);
    }
  }

  async function createFolderIn(parentPath: string) {
    if (!parentPath) return;
    const result = await window.api.fs.createFolder({
      parentFolderPath: parentPath,
      folderName: "New Folder"
    });
    if (result.success) {
      setPendingRenamePath(result.folderPath);
    }
  }

  return (
    <Sidebar className="pr-0" collapsible="offcanvas" variant="floating">
      {/* <SidebarHeader>

      </SidebarHeader> */}
      <SidebarContent className="flex min-h-0 flex-1 flex-col px-1 py-2">
        <SidebarGroup>
          <SidebarMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuItem>
                    <SidebarMenuButton onClick={() => void createNoteIn(vaultRoot)}>
                      <SquarePenIcon /> New Note
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                }
              />
              <TooltipContent side="right">
                Create a local note
                <KbdGroup>
                  <Kbd>{modSymbol}</Kbd>
                  <Kbd>N</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <MessageCirclePlusIcon /> New Chat
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                }
              />
              <TooltipContent side="right">
                Start a chat with the agent
                <KbdGroup>
                  <Kbd>{modSymbol}</Kbd>
                  <Kbd>⇧</Kbd>
                  <Kbd>{"\\"}</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuItem>
                    <SidebarMenuButton>
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
        <SidebarGroup>
          <SidebarGroupLabel>Files</SidebarGroupLabel>
          {moveError ? (
            <p className="mx-1 mb-2 text-xs text-destructive" role="alert">
              {moveError}
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col">
            <ContextMenu>
              <ContextMenuTrigger render={<div className="flex min-h-0 flex-1 flex-col" />}>
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="shrink-0 rounded -mx-1 px-1">
                    {tree.map((node) => (
                      <FileTreeNode
                        key={node.path}
                        node={node}
                        depth={0}
                        selectedFilePath={selectedFilePath}
                        selectedFolderPath={selectedFolderPath}
                        autoRenamePath={pendingRenamePath}
                        onAutoRenameConsumed={() => setPendingRenamePath(null)}
                        onSelectPlace={onSelectPlace}
                        onSelectFolder={onSelectFolder}
                        onRequestDelete={(node) => {
                          setDeleteError(null);
                          setPendingDelete(node);
                        }}
                        onRenameComplete={onRenamePath}
                        onCreateFolderIn={(path) => void createFolderIn(path)}
                        onCreateNoteIn={(path) => void createNoteIn(path)}
                        dnd={dndBridge}
                      />
                    ))}
                  </div>
                  {vaultRoot && dndBridge ? (
                    <div
                      aria-hidden
                      className="min-h-8 flex-1"
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDragOverTarget(vaultRoot);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverTarget(null);
                        const payload = parseDragPayload(e);
                        if (!payload) return;
                        void runMove(payload.path, payload.type, vaultRoot);
                      }}
                    />
                  ) : null}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => void createNoteIn(vaultRoot)}>
                  New Note
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void createFolderIn(vaultRoot)}>
                  New Folder
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </SidebarGroup>
      </SidebarContent>
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
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.type === "directory" ? "folder" : "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.type === "directory"
                ? `This will permanently delete "${pendingDelete?.name}" and all its contents.`
                : `This will permanently delete "${pendingDelete?.name}".`}
            </AlertDialogDescription>
            {deleteError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
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
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  );
}
