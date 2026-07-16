import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@mapos/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub
} from "@mapos/ui/components/sidebar";
import { ErrorTooltip } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { type FileNode, isServableImageFile } from "@shared/types";
import {
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  SquarePenIcon,
  Trash2Icon
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { iconForFilename } from "../../lib/file-icons";
import { type SidebarDndBridge, parentDir } from "./dnd";

function fileIcon(name: string) {
  const Icon = iconForFilename(name);
  return <Icon className="size-3.5 shrink-0 text-sidebar-foreground/50" />;
}

export function FileTreeNode({
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

  // Images open in the lightbox, not a tab — the new-tab action doesn't apply.
  const isImage = node.type === "file" && isServableImageFile(node.name);

  const menuItems = (
    <>
      {!isImage && (
        <ContextMenuItem onClick={() => onOpenInNewTab(node)}>
          <PlusIcon />
          Open in New Tab
        </ContextMenuItem>
      )}
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
      {!isImage && (
        <DropdownMenuItem onClick={() => onOpenInNewTab(node)}>
          <PlusIcon />
          Open in New Tab
        </DropdownMenuItem>
      )}
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
    "hover:bg-hover-strong hover:text-sidebar-accent-foreground data-open:bg-hover-strong data-open:text-sidebar-accent-foreground data-open:opacity-100";

  if (node.type === "directory") {
    const isActive =
      selectedPaths.size > 1 ? selectedPaths.has(node.path) : node.path === selectedFolderPath;
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
                    "group-hover/folder-row:bg-hover group-hover/folder-row:text-sidebar-accent-foreground",
                    "group-has-data-[sidebar=menu-action]/folder-row:pr-8",
                    isActive && "bg-hover font-medium text-sidebar-accent-foreground",
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
                  "hover:bg-hover-strong",
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
          <SidebarMenuSub className="mr-0 translate-x-0 pr-0">
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
    selectedPaths.size > 1 ? selectedPaths.has(node.path) : node.path === selectedFilePath;
  const parentFolder = parentDir(node.path);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              isActive={isActive}
              className="group-hover/menu-item:bg-hover group-hover/menu-item:text-sidebar-accent-foreground data-active:bg-hover"
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
