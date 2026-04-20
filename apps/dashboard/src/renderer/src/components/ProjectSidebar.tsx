import { cn } from "@renderer/lib/utils";
import type { FileNode } from "@shared/types";
import {
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Layers2Icon,
  MessageCirclePlusIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modSymbol, useShortcuts } from "../hooks/useShortcuts";
import type { PlaceRecord } from "./MapView";
import { SettingsDialog } from "./SettingsDialog";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
  return <Layers2Icon className="size-3.5 shrink-0 text-sidebar-foreground/50" />;
}

type VaultOption = {
  path: string;
  name: string;
  subtitle: string;
  logo: React.ElementType;
};

function vaultBasename(path: string): string {
  const n = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const s = n >= 0 ? path.slice(n + 1) : path;
  return (s || path).trim() || path;
}

function VaultSwitcher() {
  const { isMobile } = useSidebar();
  const [vaultOptions, setVaultOptions] = useState<VaultOption[]>([]);
  const [activeVaultPath, setActiveVaultPath] = useState<string | null>(null);
  const [addVaultOpen, setAddVaultOpen] = useState(false);
  const [addVaultBusy, setAddVaultBusy] = useState(false);
  const [addVaultError, setAddVaultError] = useState<string | null>(null);

  const reloadVaults = useCallback(() => {
    void window.api.mapos.getVaultsConfig().then(({ vaults, activeVaultPath: active }) => {
      const trimmed = vaults.map((p) => p.trim()).filter(Boolean);
      setActiveVaultPath(active);
      setVaultOptions(
        trimmed.map((path) => ({
          path,
          name: vaultBasename(path),
          subtitle: path,
          logo: path === active ? FolderOpenIcon : FolderIcon
        }))
      );
    });
  }, []);

  useEffect(() => {
    reloadVaults();
  }, [reloadVaults]);

  const activeVault = useMemo((): VaultOption => {
    const found = vaultOptions.find((v) => v.path === activeVaultPath);
    if (found) return found;
    if (vaultOptions[0]) return vaultOptions[0];
    return {
      path: "",
      name: "Vault",
      subtitle: "Loading…",
      logo: FolderOpenIcon
    };
  }, [vaultOptions, activeVaultPath]);

  const runCreateNewVault = useCallback(async () => {
    setAddVaultBusy(true);
    setAddVaultError(null);
    try {
      const r = await window.api.mapos.createNewVault();
      if ("canceled" in r && r.canceled) return;
      if ("ok" in r && r.ok === false) {
        setAddVaultError(r.error);
        return;
      }
      if ("ok" in r && r.ok) {
        setAddVaultOpen(false);
        reloadVaults();
      }
    } finally {
      setAddVaultBusy(false);
    }
  }, [reloadVaults]);

  const runSetFolderAsVault = useCallback(async () => {
    setAddVaultBusy(true);
    setAddVaultError(null);
    try {
      const r = await window.api.mapos.setFolderAsVault();
      if ("canceled" in r && r.canceled) return;
      if ("ok" in r && r.ok === false) {
        setAddVaultError(r.error);
        return;
      }
      if ("ok" in r && r.ok) {
        setAddVaultOpen(false);
        reloadVaults();
      }
    } finally {
      setAddVaultBusy(false);
    }
  }, [reloadVaults]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Dialog
          open={addVaultOpen}
          onOpenChange={(open) => {
            setAddVaultOpen(open);
            if (!open) setAddVaultError(null);
          }}
        >
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
                {vaultOptions.map((vault) => {
                  const isActive = vault.path === activeVaultPath;
                  return (
                    <DropdownMenuItem
                      key={vault.path}
                      className="gap-2 p-2"
                      onClick={() => {
                        if (isActive) return;
                        void window.api.mapos.switchVault(vault.path);
                      }}
                    >
                      <div className="flex size-6 items-center justify-center rounded-md border border-sidebar-border">
                        <vault.logo className="size-3.5 shrink-0" />
                      </div>
                      <div className="grid min-w-0 flex-1">
                        <span className="truncate font-medium">{vault.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {vault.subtitle}
                        </span>
                      </div>
                      {isActive && <CheckIcon className="ml-auto size-4 shrink-0 opacity-70" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 p-2"
                onClick={() => {
                  setAddVaultOpen(true);
                }}
              >
                <div className="flex size-6 items-center justify-center rounded-md border border-sidebar-border bg-transparent">
                  <PlusIcon className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">Add vault</div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DialogContent className="sm:max-w-md" showCloseButton={!addVaultBusy}>
            <DialogHeader>
              <DialogTitle>Add vault</DialogTitle>
              <DialogDescription>
                Register another folder in MapOS. Select it from the vault switcher to relaunch with
                that vault active.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal"
                disabled={addVaultBusy}
                onClick={() => void runCreateNewVault()}
              >
                <FolderPlusIcon className="size-5 shrink-0 opacity-80" />
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">Create new vault</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    Pick a parent location. MapOS creates an empty folder named &quot;MapOS
                    Vault&quot; (or MapOS Vault 1, …) and adds it to your list.
                  </span>
                </div>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal"
                disabled={addVaultBusy}
                onClick={() => void runSetFolderAsVault()}
              >
                <FolderInputIcon className="size-5 shrink-0 opacity-80" />
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">Set folder as vault</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    Choose an existing folder on disk and add its path to your vault list.
                  </span>
                </div>
              </Button>
            </div>
            {addVaultError ? (
              <p className="text-destructive text-sm" role="alert">
                {addVaultError}
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
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
  onSelectGeoJson,
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
  onSelectGeoJson?: (path: string) => void;
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
              <div
                className={cn(
                  "flex min-h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md pl-1 pr-2 ring-sidebar-ring outline-hidden transition-[color,background-color,box-shadow]",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                  folderDropZone && "bg-sidebar-accent"
                )}
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
              />
            }
          >
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Collapse folder" : "Expand folder"}
              className={cn(
                "my-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none transition-[color,background-color]",
                "text-sidebar-foreground/50 hover:text-sidebar-accent-foreground",
                "hover:bg-sidebar-accent-foreground/10",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-0"
              )}
              onClick={() => {
                if (isRenaming) return;
                setOpen((o) => !o);
              }}
            >
              <ChevronRightIcon
                className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
              />
            </button>
            <SidebarMenuButton
              isActive={isActive}
              className={cn(
                "min-h-8 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 shadow-none",
                "hover:bg-transparent focus-visible:bg-transparent active:bg-transparent",
                "data-active:bg-transparent data-active:hover:bg-transparent",
                folderDropZone && "bg-transparent"
              )}
              onClick={() => {
                if (isRenaming) return;
                onSelectFolder?.(node.path);
              }}
              onDoubleClick={(e) => {
                if (isRenaming) return;
                e.preventDefault();
                setOpen((o) => !o);
              }}
            >
              {open ? (
                <FolderOpenIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
              ) : (
                <FolderIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
              )}
              {isRenaming ? renameInput : <span className="truncate">{node.name}</span>}
            </SidebarMenuButton>
          </ContextMenuTrigger>
          <ContextMenuContent>{folderMenuItems}</ContextMenuContent>
        </ContextMenu>
        {open && node.children && node.children.length > 0 && (
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
                onSelectGeoJson={onSelectGeoJson}
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
                if (node.path.toLowerCase().endsWith(".geojson")) {
                  onSelectGeoJson?.(node.path);
                  return;
                }
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
  onSelectGeoJson,
  onDeletePath,
  onRenamePath,
  onMoved
}: {
  selectedFilePath?: string;
  selectedFolderPath?: string;
  onSelectPlace?: (place: PlaceRecord, newTab?: boolean) => void;
  onSelectFolder?: (path: string) => void;
  onSelectGeoJson?: (path: string) => void;
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
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  useShortcuts([
    { def: { key: "n", meta: true }, handler: () => void createNoteIn(vaultRoot) },
    { def: { key: ",", meta: true }, handler: () => setSettingsOpen(true) }
  ]);

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
                    <SidebarMenuButton onClick={() => setSettingsOpen(true)}>
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
                  <SidebarMenu className="shrink-0 gap-0.5">
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
                        onSelectGeoJson={onSelectGeoJson}
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
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Sidebar>
  );
}
