import { cn } from "@renderer/lib/utils";
import type { FileNode } from "@shared/types";
import { ChevronRightIcon, FileIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Sidebar, SidebarContent, SidebarHeader } from "./ui/sidebar";
import { ErrorTooltip } from "./ui/tooltip";

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
  onSelectPlace,
  onSelectFolder,
  onRequestDelete,
  onRenameComplete
}: {
  node: FileNode;
  depth: number;
  selectedFilePath?: string;
  selectedFolderPath?: string;
  onSelectPlace?: (place: PlaceRecord) => void;
  onSelectFolder?: (path: string) => void;
  onRequestDelete?: (node: FileNode) => void;
  onRenameComplete?: (oldPath: string, newPath: string) => void;
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

  if (node.type === "directory") {
    const isActive = node.path === selectedFolderPath;
    return (
      <ContextMenu>
        <ContextMenuTrigger render={<div />}>
          <div
            className={cn(
              "flex items-center rounded text-sm",
              isActive
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
                  onSelectPlace={onSelectPlace}
                  onSelectFolder={onSelectFolder}
                  onRequestDelete={onRequestDelete}
                  onRenameComplete={onRenameComplete}
                />
              ))}
            </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>{menuItems}</ContextMenuContent>
      </ContextMenu>
    );
  }

  const isActive = node.path === selectedFilePath;

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
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-sidebar-accent",
                isActive
                  ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                  : "text-sidebar-foreground"
              )}
              style={{ paddingLeft: `${0.5 + depth * 0.875 + 0.875}rem` }}
              onClick={async () => {
                const place = await window.api.places.getByPath(node.path);
                if (place) onSelectPlace?.(place);
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
  onRenamePath
}: {
  selectedFilePath?: string;
  selectedFolderPath?: string;
  onSelectPlace?: (place: PlaceRecord) => void;
  onSelectFolder?: (path: string) => void;
  onDeletePath?: (path: string, type: FileNode["type"]) => void;
  onRenamePath?: (oldPath: string, newPath: string) => void;
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [pendingDelete, setPendingDelete] = useState<FileNode | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  return (
    <Sidebar className="pr-0" collapsible="offcanvas" variant="floating">
      <SidebarHeader className="flex-row items-center justify-between px-3 py-2 border-b border-sidebar-border">
        <span className="text-xs font-semibold tracking-widest text-sidebar-foreground/60 uppercase">
          MapOS
        </span>
      </SidebarHeader>
      <SidebarContent className="px-1 py-2">
        {tree.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedFilePath={selectedFilePath}
            selectedFolderPath={selectedFolderPath}
            onSelectPlace={onSelectPlace}
            onSelectFolder={onSelectFolder}
            onRequestDelete={(node) => {
              setDeleteError(null);
              setPendingDelete(node);
            }}
            onRenameComplete={onRenamePath}
          />
        ))}
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
