import { cn } from "@mapos/ui/lib/utils";
import type { ConversationMeta, FileNode } from "@shared/types";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  EllipsisIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MessageCircleIcon,
  MessageCirclePlusIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  SquareIcon,
  SquarePenIcon,
  Trash2Icon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modSymbol, useShortcuts } from "../hooks/use-shortcuts";
import { iconForFilename } from "../lib/file-icons";
import { DEFAULT_VAULT_NAME, validateVaultName } from "../lib/vault-name";
import type { PlaceRecord } from "./map-view";
import { SettingsDialog } from "./settings-dialog";
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
import { Button } from "@mapos/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@mapos/ui/components/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@mapos/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar
} from "@mapos/ui/components/sidebar";
import { InputGroup, InputGroupInput } from "@mapos/ui/components/input-group";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { PulseLoader } from "@mapos/ui/components/pulse-loader";
import { ErrorTooltip, Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";

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
  const Icon = iconForFilename(name);
  return <Icon className="size-3.5 shrink-0 text-sidebar-foreground/50" />;
}

type PendingDelete =
  | { kind: "files"; nodes: FileNode[] }
  | { kind: "conversations"; ids: string[]; titles: string[] }
  | null;

function displayNameForNode(node: FileNode): string {
  return node.type === "file" ? node.name.replace(/\.(md|geojson)$/i, "") : node.name;
}

function summarizeNames(names: string[], max = 5): string {
  if (names.length <= max) return names.map((n) => `"${n}"`).join(", ");
  const head = names.slice(0, max).map((n) => `"${n}"`).join(", ");
  return `${head} and ${names.length - max} more`;
}

function describePendingDelete(p: NonNullable<PendingDelete>): {
  title: string;
  description: string;
} {
  if (p.kind === "files") {
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
  if (p.ids.length === 1) {
    return {
      title: "Delete conversation?",
      description: `This will permanently delete "${p.titles[0]}".`
    };
  }
  return {
    title: `Delete ${p.ids.length} conversations?`,
    description: `This will permanently delete ${summarizeNames(p.titles)}.`
  };
}

function CollapsibleGroupLabel({
  label,
  open,
  onToggle
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <SidebarGroupLabel
      render={
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="group/group-label cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-hover/group-header:bg-sidebar-accent group-hover/group-header:text-sidebar-accent-foreground"
        />
      }
    >
      <span>{label}</span>
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 text-sidebar-foreground/50 opacity-0 transition-[transform,opacity] group-hover/group-label:opacity-100",
          open && "rotate-90"
        )}
      />
    </SidebarGroupLabel>
  );
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

type AddVaultStep = "choose" | "name";

function VaultSwitcher() {
  const { isMobile } = useSidebar();
  const [vaultOptions, setVaultOptions] = useState<VaultOption[]>([]);
  const [activeVaultPath, setActiveVaultPath] = useState<string | null>(null);
  const [addVaultOpen, setAddVaultOpen] = useState(false);
  const [addVaultBusy, setAddVaultBusy] = useState(false);
  const [addVaultError, setAddVaultError] = useState<string | null>(null);
  const [addVaultStep, setAddVaultStep] = useState<AddVaultStep>("choose");
  const [vaultNameDraft, setVaultNameDraft] = useState<string>(DEFAULT_VAULT_NAME);

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

  const runCreateNewVault = useCallback(
    async (name: string) => {
      const local = validateVaultName(name);
      if (!local.ok) {
        setAddVaultError(local.error);
        return;
      }
      setAddVaultBusy(true);
      setAddVaultError(null);
      try {
        const r = await window.api.mapos.createNewVault(name.trim());
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
    },
    [reloadVaults]
  );

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
            if (!open) {
              setAddVaultError(null);
              setAddVaultStep("choose");
              setVaultNameDraft(DEFAULT_VAULT_NAME);
            }
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
            {addVaultStep === "choose" ? (
              <>
                <DialogHeader>
                  <DialogTitle>Add vault</DialogTitle>
                  <DialogDescription>
                    Register another folder in MapOS. Select it from the vault switcher to relaunch
                    with that vault active.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal"
                    disabled={addVaultBusy}
                    onClick={() => {
                      setAddVaultError(null);
                      setVaultNameDraft(DEFAULT_VAULT_NAME);
                      setAddVaultStep("name");
                    }}
                  >
                    <FolderPlusIcon className="size-5 shrink-0 opacity-80" />
                    <div className="grid min-w-0 gap-0.5">
                      <span className="font-medium">Create new vault</span>
                      <span className="text-muted-foreground text-xs font-normal">
                        Pick a name and a parent location. MapOS creates the folder and adds it to
                        your list.
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
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Name your vault</DialogTitle>
                  <DialogDescription>
                    Choose a name for the new vault folder. You can rename it later from Settings.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                  <InputGroup>
                    <InputGroupInput
                      autoFocus
                      value={vaultNameDraft}
                      disabled={addVaultBusy}
                      aria-invalid={!!addVaultError}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => {
                        setVaultNameDraft(e.target.value);
                        if (addVaultError) setAddVaultError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void runCreateNewVault(vaultNameDraft);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setAddVaultError(null);
                          setAddVaultStep("choose");
                        }
                      }}
                    />
                  </InputGroup>
                  {addVaultError ? (
                    <p className="text-destructive text-sm" role="alert">
                      {addVaultError}
                    </p>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      // size="sm"
                      disabled={addVaultBusy}
                      onClick={() => {
                        setAddVaultError(null);
                        setAddVaultStep("choose");
                      }}
                    >
                      <ArrowLeftIcon className="size-4" />
                      Back
                    </Button>
                    <Button
                      type="button"
                      // size="sm"
                      disabled={addVaultBusy || !localValidateVaultName(vaultNameDraft).ok}
                      onClick={() => void runCreateNewVault(vaultNameDraft)}
                    >
                      Choose location…
                    </Button>
                  </div>
                </div>
              </>
            )}
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
  selectedPaths,
  openFolders,
  setFolderOpen,
  autoRenamePath,
  onAutoRenameConsumed,
  onPathClick,
  onOpenInNewTab,
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
  selectedPaths: Set<string>;
  openFolders: Set<string>;
  setFolderOpen: (path: string, open: boolean) => void;
  autoRenamePath?: string | null;
  onAutoRenameConsumed?: () => void;
  onPathClick: (node: FileNode, e: React.MouseEvent) => void;
  onOpenInNewTab: (node: FileNode) => void;
  onRequestDelete?: (node: FileNode) => void;
  onRenameComplete?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
  onCreateFolderIn?: (path: string) => void;
  onCreateNoteIn?: (path: string) => void;
  dnd?: SidebarDndBridge;
}) {
  const open = node.type === "directory" && openFolders.has(node.path);
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
      setFolderOpen(node.path, true);
      startRename();
      onAutoRenameConsumed?.();
    } else if (autoRenamePath.startsWith(`${node.path}/`)) {
      setFolderOpen(node.path, true);
    }
  }, [autoRenamePath, node.path, node.type, onAutoRenameConsumed, setFolderOpen]);

  function startRename() {
    const displayName =
      node.type === "file" ? node.name.replace(/\.(md|geojson)$/i, "") : node.name;
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
    const originalDisplay =
      node.type === "file" ? node.name.replace(/\.(md|geojson)$/i, "") : node.name;
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
    onRenameComplete?.(node.path, result.newPath, node.type === "directory");
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
      <ContextMenuItem onClick={() => onOpenInNewTab(node)}>
        <PlusIcon />
        Open in New Tab
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void window.api.fs.revealInFinder(node.path)}>
        <FolderOpenIcon />
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={startRename}>
        <PencilIcon />
        Rename
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => onRequestDelete?.(node)}>
        <Trash2Icon />
        Delete
      </ContextMenuItem>
    </>
  );

  const dropdownMenuItems = (
    <>
      <DropdownMenuItem onClick={() => onOpenInNewTab(node)}>
        <PlusIcon />
        Open in New Tab
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void window.api.fs.revealInFinder(node.path)}>
        <FolderOpenIcon />
        Reveal in Finder
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={startRename}>
        <PencilIcon />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onClick={() => onRequestDelete?.(node)}>
        <Trash2Icon />
        Delete
      </DropdownMenuItem>
    </>
  );

  const folderMenuItems = (
    <>
      <ContextMenuItem onClick={() => onOpenInNewTab(node)}>
        <PlusIcon />
        Open in New Tab
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCreateNoteIn?.(node.path)}>
        <SquarePenIcon />
        New Note
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCreateFolderIn?.(node.path)}>
        <FolderPlusIcon />
        New Folder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => void window.api.fs.revealInFinder(node.path)}>
        <FolderOpenIcon />
        Reveal in Finder
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={startRename}>
        <PencilIcon />
        Rename
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => onRequestDelete?.(node)}>
        <Trash2Icon />
        Delete
      </ContextMenuItem>
    </>
  );

  const dropdownFolderMenuItems = (
    <>
      <DropdownMenuItem onClick={() => onOpenInNewTab(node)}>
        <PlusIcon />
        Open in New Tab
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onCreateNoteIn?.(node.path)}>
        <SquarePenIcon />
        New Note
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onCreateFolderIn?.(node.path)}>
        <FolderPlusIcon />
        New Folder
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => void window.api.fs.revealInFinder(node.path)}>
        <FolderOpenIcon />
        Reveal in Finder
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={startRename}>
        <PencilIcon />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem variant="destructive" onClick={() => onRequestDelete?.(node)}>
        <Trash2Icon />
        Delete
      </DropdownMenuItem>
    </>
  );

  const itemActionClass =
    "hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-accent-foreground data-open:bg-sidebar-accent-foreground/10 data-open:text-sidebar-accent-foreground data-open:opacity-100";

  if (node.type === "directory") {
    const isActive =
      selectedPaths.size > 1
        ? selectedPaths.has(node.path)
        : node.path === selectedFolderPath;
    const folderDropZone = Boolean(dnd && dnd.dragOverTarget === node.path);
    return (
      <li className={cn("relative", folderDropZone && "rounded-md bg-sidebar-accent")}>
        <div className="group/folder-row relative">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                className={cn(
                  "flex min-h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md pl-1 pr-2 ring-sidebar-ring outline-hidden transition-[color,background-color,box-shadow]",
                  "group-hover/folder-row:bg-sidebar-accent group-hover/folder-row:text-sidebar-accent-foreground",
                  "group-has-data-[sidebar=menu-action]/folder-row:pr-8",
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
                "my-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md outline-none transition-[color,background-color]",
                "text-sidebar-foreground/50 hover:text-sidebar-accent-foreground",
                "hover:bg-sidebar-accent-foreground/10",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-0"
              )}
              onClick={() => {
                if (isRenaming) return;
                setFolderOpen(node.path, !open);
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
              onClick={(e) => {
                if (isRenaming) return;
                onPathClick(node, e);
              }}
              onDoubleClick={(e) => {
                if (isRenaming) return;
                e.preventDefault();
                setFolderOpen(node.path, !open);
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
        {!isRenaming && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuAction
                  className={cn(
                    itemActionClass,
                    "group-focus-within/folder-row:opacity-100 group-hover/folder-row:opacity-100 aria-expanded:opacity-100 md:opacity-0"
                  )}
                >
                  <EllipsisIcon />
                  <span className="sr-only">More actions</span>
                </SidebarMenuAction>
              }
            />
            <DropdownMenuContent side="right" align="start" className="w-auto">
              {dropdownFolderMenuItems}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        </div>
        {open && node.children && node.children.length > 0 && (
          <SidebarMenuSub className="translate-x-0">
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedFilePath={selectedFilePath}
                selectedFolderPath={selectedFolderPath}
                selectedPaths={selectedPaths}
                openFolders={openFolders}
                setFolderOpen={setFolderOpen}
                autoRenamePath={autoRenamePath}
                onAutoRenameConsumed={onAutoRenameConsumed}
                onPathClick={onPathClick}
                onOpenInNewTab={onOpenInNewTab}
                onRequestDelete={onRequestDelete}
                onRenameComplete={onRenameComplete}
                onCreateFolderIn={onCreateFolderIn}
                onCreateNoteIn={onCreateNoteIn}
                dnd={dnd}
              />
            ))}
          </SidebarMenuSub>
        )}
      </li>
    );
  }

  const isActive =
    selectedPaths.size > 1
      ? selectedPaths.has(node.path)
      : node.path === selectedFilePath;
  const parentFolder = parentDir(node.path);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              // size="sm"
              isActive={isActive}
              className="group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground"
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
              onClick={(e) => {
                if (isRenaming) return;
                onPathClick(node, e);
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
      {!isRenaming && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction showOnHover className={itemActionClass}>
                <EllipsisIcon />
                <span className="sr-only">More actions</span>
              </SidebarMenuAction>
            }
          />
          <DropdownMenuContent side="right" align="start" className="w-auto">
            {dropdownMenuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </SidebarMenuItem>
  );
}

export function ProjectSidebar({
  selectedFilePath,
  selectedFolderPath,
  activeChatConvId,
  conversations,
  streamingConvIds,
  onSelectPlace,
  onSelectFolder,
  onSelectGeoJson,
  onDeletePath,
  onRenamePath,
  onMoved,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  onStopChat
}: {
  selectedFilePath?: string;
  selectedFolderPath?: string;
  activeChatConvId?: string | null;
  conversations: ConversationMeta[];
  streamingConvIds: Set<string>;
  onSelectPlace?: (place: PlaceRecord, newTab?: boolean) => void;
  onSelectFolder?: (path: string, newTab?: boolean) => void;
  onSelectGeoJson?: (path: string) => void;
  onDeletePath?: (path: string, type: FileNode["type"]) => void;
  onRenamePath?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
  onMoved?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
  onNewChat?: () => void;
  onSelectChat?: (convId: string, title: string, newTab?: boolean) => void;
  onDeleteChat?: (convId: string) => void;
  onStopChat?: (convId: string) => void;
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [vaultRoot, setVaultRoot] = useState<string>("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingRenamePath, setPendingRenamePath] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<
    "general" | "appearance" | "ai"
  >("general");
  const [filesGroupOpen, setFilesGroupOpen] = useState(true);
  const [conversationsGroupOpen, setConversationsGroupOpen] = useState(true);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  // Tracks top-level dir paths we've auto-opened at least once. Lets the watcher
  // reload the tree without re-opening folders the user has manually collapsed.
  const seenTopLevelRef = useRef<Set<string>>(new Set());
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [pathAnchor, setPathAnchor] = useState<string | null>(null);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [convAnchor, setConvAnchor] = useState<string | null>(null);

  const setFolderOpen = useCallback((path: string, open: boolean) => {
    setOpenFolders((prev) => {
      const wasOpen = prev.has(path);
      if (wasOpen === open) return prev;
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const nodes = await window.api.fs.listDir();
    setTree(nodes);
    const newTopLevelDirs: string[] = [];
    for (const n of nodes) {
      if (n.type === "directory" && !seenTopLevelRef.current.has(n.path)) {
        newTopLevelDirs.push(n.path);
        seenTopLevelRef.current.add(n.path);
      }
    }
    if (newTopLevelDirs.length > 0) {
      setOpenFolders((prev) => {
        const next = new Set(prev);
        for (const p of newTopLevelDirs) next.add(p);
        return next;
      });
    }
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
      const place = await window.api.places.getByPath(node.path);
      if (place) onSelectPlace?.(place, newTab);
    },
    [onSelectFolder, onSelectGeoJson, onSelectPlace]
  );

  const handlePathClick = useCallback(
    (node: FileNode, e: React.MouseEvent) => {
      // Clicking in the files scope clears the conversations multi-selection.
      setSelectedConvIds((prev) => (prev.size === 0 ? prev : new Set()));
      setConvAnchor(null);

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
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(node.path)) next.delete(node.path);
          else next.add(node.path);
          return next;
        });
        setPathAnchor(node.path);
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

  const handleConvClick = useCallback(
    (
      conv: ConversationMeta,
      title: string,
      e: React.MouseEvent,
      orderedIds: string[]
    ) => {
      // Clicking in the conversations scope clears the files multi-selection.
      setSelectedPaths((prev) => (prev.size === 0 ? prev : new Set()));
      setPathAnchor(null);

      if (e.shiftKey && convAnchor) {
        const a = orderedIds.indexOf(convAnchor);
        const b = orderedIds.indexOf(conv.id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelectedConvIds(new Set(orderedIds.slice(lo, hi + 1)));
          return;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        setSelectedConvIds((prev) => {
          const next = new Set(prev);
          if (next.has(conv.id)) next.delete(conv.id);
          else next.add(conv.id);
          return next;
        });
        setConvAnchor(conv.id);
        return;
      }
      setSelectedConvIds(new Set([conv.id]));
      setConvAnchor(conv.id);
      onSelectChat?.(conv.id, title, false);
    },
    [convAnchor, onSelectChat]
  );

  async function confirmDelete() {
    if (!pendingDelete || isDeleting) return;
    setDeleteError(null);
    setIsDeleting(true);
    if (pendingDelete.kind === "files") {
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
    } else {
      for (const id of pendingDelete.ids) {
        onDeleteChat?.(id);
      }
      setSelectedConvIds(new Set());
      setConvAnchor(null);
    }
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
    } else if (selectedConvIds.size > 0) {
      const ids = [...selectedConvIds];
      const titles = ids.map((id) => {
        const c = conversations.find((x) => x.id === id);
        return c?.preview || "Chat";
      });
      setDeleteError(null);
      setPendingDelete({ kind: "conversations", ids, titles });
    }
  }, [pendingDelete, selectedPaths, selectedConvIds, collectNodesByPaths, conversations]);

  const clearMultiSelection = useCallback(() => {
    setSelectedPaths((prev) => (prev.size === 0 ? prev : new Set()));
    setPathAnchor(null);
    setSelectedConvIds((prev) => (prev.size === 0 ? prev : new Set()));
    setConvAnchor(null);
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

  // Allow other components (e.g. chat empty state) to deep-link into a specific settings page.
  useEffect(() => {
    function handleOpenSettings(e: Event): void {
      const detail = (e as CustomEvent<{ section?: "general" | "appearance" | "ai" }>).detail;
      setSettingsInitialPage(detail?.section ?? "general");
      setSettingsOpen(true);
    }
    window.addEventListener("mapos:open-settings", handleOpenSettings);
    return () => window.removeEventListener("mapos:open-settings", handleOpenSettings);
  }, []);

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
                    <SidebarMenuButton onClick={onNewChat}>
                      <MessageCirclePlusIcon /> New Chat
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                }
              />
              <TooltipContent side="right">
                Start a chat with the agent
                <KbdGroup>
                  <Kbd>{modSymbol}</Kbd>
                  <Kbd>O</Kbd>
                </KbdGroup>
              </TooltipContent>
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
              label="Files"
              open={filesGroupOpen}
              onToggle={() => setFilesGroupOpen((o) => !o)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarGroupAction
                    title="Add"
                    className="top-1.5 right-1 opacity-0 transition-opacity group-hover/group-header:opacity-100 focus-visible:opacity-100 data-open:opacity-100 hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-accent-foreground"
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
                  New Note
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setFilesGroupOpen(true);
                    void createFolderIn(vaultRoot);
                  }}
                >
                  <FolderPlusIcon />
                  New Folder
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
                    <SquarePenIcon />
                    New Note
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => void createFolderIn(vaultRoot)}>
                    <FolderPlusIcon />
                    New Folder
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          )}
        </SidebarGroup>
        <SidebarGroup className="pt-0">
          <div className="group/group-header relative mb-0.5 flex flex-col">
            <CollapsibleGroupLabel
              label="Conversations"
              open={conversationsGroupOpen}
              onToggle={() => setConversationsGroupOpen((o) => !o)}
            />
            <SidebarGroupAction
              title="New chat"
              className="top-1.5 right-1 opacity-0 transition-opacity group-hover/group-header:opacity-100 focus-visible:opacity-100 hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-accent-foreground"
              onClick={() => {
                setConversationsGroupOpen(true);
                onNewChat?.();
              }}
            >
              <PlusIcon />
              <span className="sr-only">New chat</span>
            </SidebarGroupAction>
          </div>
          {conversationsGroupOpen && (
            <SidebarMenu className="gap-0.5">
              {conversations.length === 0 ? (
                <li className="px-2 py-1 text-xs text-sidebar-foreground/50">No conversations</li>
              ) : (
                (() => {
                  const orderedIds = conversations.map((c) => c.id);
                  return conversations.map((conv) => {
                    const title = conv.preview || "Chat";
                    const isActive =
                      selectedConvIds.size > 1
                        ? selectedConvIds.has(conv.id)
                        : conv.id === activeChatConvId;
                    const isStreaming = streamingConvIds.has(conv.id);
                    const requestDeleteConv = () => {
                      if (selectedConvIds.size > 1 && selectedConvIds.has(conv.id)) {
                        const ids = [...selectedConvIds];
                        const titles = ids.map((id) => {
                          const c = conversations.find((x) => x.id === id);
                          return c?.preview || "Chat";
                        });
                        setPendingDelete({ kind: "conversations", ids, titles });
                      } else {
                        // Preserve existing single-conversation no-confirm UX.
                        onDeleteChat?.(conv.id);
                      }
                    };
                    return (
                      <SidebarMenuItem key={conv.id}>
                        <ContextMenu>
                          <ContextMenuTrigger
                            render={
                              <SidebarMenuButton
                                isActive={isActive}
                                className="group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground"
                                onClick={(e) => handleConvClick(conv, title, e, orderedIds)}
                              />
                            }
                          >
                            {isStreaming ? (
                              <PulseLoader aria-label="Streaming" color="text-white" />
                            ) : (
                              <MessageCircleIcon className="size-3.5 shrink-0 text-sidebar-foreground/50" />
                            )}
                            <span className="truncate">{title}</span>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onClick={() => onSelectChat?.(conv.id, title, true)}
                            >
                              <PlusIcon />
                              Open in New Tab
                            </ContextMenuItem>
                            {isStreaming && (
                              <ContextMenuItem onClick={() => onStopChat?.(conv.id)}>
                                <SquareIcon />
                                Stop
                              </ContextMenuItem>
                            )}
                            <ContextMenuSeparator />
                            <ContextMenuItem variant="destructive" onClick={requestDeleteConv}>
                              <Trash2Icon />
                              {selectedConvIds.size > 1 && selectedConvIds.has(conv.id)
                                ? `Delete ${selectedConvIds.size} conversations`
                                : "Delete"}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <SidebarMenuAction
                                showOnHover
                                className="hover:bg-sidebar-accent-foreground/10 hover:text-sidebar-accent-foreground data-open:bg-sidebar-accent-foreground/10 data-open:text-sidebar-accent-foreground data-open:opacity-100"
                              >
                                <EllipsisIcon />
                                <span className="sr-only">More actions</span>
                              </SidebarMenuAction>
                            }
                          />
                          <DropdownMenuContent side="right" align="start" className="w-auto">
                            <DropdownMenuItem
                              onClick={() => onSelectChat?.(conv.id, title, true)}
                            >
                              <PlusIcon />
                              Open in New Tab
                            </DropdownMenuItem>
                            {isStreaming && (
                              <DropdownMenuItem onClick={() => onStopChat?.(conv.id)}>
                                <SquareIcon />
                                Stop
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={requestDeleteConv}>
                              <Trash2Icon />
                              {selectedConvIds.size > 1 && selectedConvIds.has(conv.id)
                                ? `Delete ${selectedConvIds.size} conversations`
                                : "Delete"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    );
                  });
                })()
              )}
            </SidebarMenu>
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
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialPage={settingsInitialPage}
      />
    </Sidebar>
  );
}
