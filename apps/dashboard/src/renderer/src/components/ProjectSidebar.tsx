import { cn } from "@renderer/lib/utils";
import type { FileNode } from "@shared/types";
import {
  ChevronRightIcon,
  ChevronsUpDownIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  MessageCirclePlusIcon,
  PlusIcon,
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "./ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from "./ui/dropdown-menu";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar
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

type VaultOption = {
  name: string;
  subtitle: string;
  logo: React.ElementType;
};

const mockVaults: VaultOption[] = [
  { name: "MapOS Personal", subtitle: "Default vault", logo: FolderOpenIcon },
  { name: "Travel Archive", subtitle: "Synced", logo: FolderIcon },
  { name: "Research Notes", subtitle: "Local-only", logo: FileTextIcon }
];

function VaultSwitcher() {
  const { isMobile } = useSidebar();
  const [activeVault, setActiveVault] = useState<VaultOption>(mockVaults[0]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              />
            }
          >
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <activeVault.logo className="size-4" />
            </div>
            <div className="grid flex-1 min-w-0 text-left text-sm leading-tight">
              <span className="truncate font-medium">{activeVault.name}</span>
              <span className="truncate text-xs text-sidebar-foreground/70">
                {activeVault.subtitle}
              </span>
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--anchor-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Vaults</DropdownMenuLabel>
              {mockVaults.map((vault, index) => (
                <DropdownMenuItem
                  key={vault.name}
                  onClick={() => setActiveVault(vault)}
                  className="gap-2 p-2"
                >
                  <div className="flex size-6 items-center justify-center rounded-md border border-sidebar-border">
                    <vault.logo className="size-3.5 shrink-0" />
                  </div>
                  <span className="truncate">{vault.name}</span>
                  <DropdownMenuShortcut>{`⌘${index + 1}`}</DropdownMenuShortcut>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-md border border-sidebar-border bg-transparent">
                <PlusIcon className="size-4" />
              </div>
              <div className="font-medium text-muted-foreground">Add vault</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
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
      <SidebarMenuItem className={cn(folderDropZone && "rounded-md bg-sidebar-accent")}>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <SidebarMenuButton
                // size="sm"
                isActive={isActive}
                className={folderDropZone ? "bg-sidebar-accent" : undefined}
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
                onClick={() => {
                  if (isRenaming) return;
                  setOpen((o) => !o);
                  onSelectFolder?.(node.path);
                }}
              />
            }
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 shrink-0 text-sidebar-foreground/50 transition-transform",
                open && "rotate-90"
              )}
            />
            {open ? (
              <FolderOpenIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
            ) : (
              <FolderIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
            )}
            {isRenaming ? renameInput : <span className="truncate">{node.name}</span>}
          </ContextMenuTrigger>
          <ContextMenuContent>{folderMenuItems}</ContextMenuContent>
        </ContextMenu>
        {open && node.children && (
          <SidebarMenuSub>
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
          </SidebarMenuSub>
        )}
      </SidebarMenuItem>
    );
  }

  const isActive = node.path === selectedFilePath;
  const parentFolder = parentDir(node.path);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              // size="sm"
              isActive={isActive}
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
              onClick={async (e) => {
                if (isRenaming) return;
                const place = await window.api.places.getByPath(node.path);
                if (place) onSelectPlace?.(place, e.metaKey || e.ctrlKey);
              }}
            />
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
    </SidebarMenuItem>
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
      <SidebarContent>
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
                  <SidebarMenu className="shrink-0">
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
                  </SidebarMenu>
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
