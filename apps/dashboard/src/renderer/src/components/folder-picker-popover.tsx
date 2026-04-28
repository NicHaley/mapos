import type { FileNode } from "@shared/types";
import { FolderIcon, FolderPlusIcon, HomeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from "@mapos/ui/components/command";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from "@mapos/ui/components/popover";

type FolderEntry = { path: string; relPath: string; depth: number };

function flattenFolders(nodes: FileNode[], vaultRoot: string, depth = 0): FolderEntry[] {
  const out: FolderEntry[] = [];
  for (const node of nodes) {
    if (node.type !== "directory") continue;
    const relPath = vaultRoot && node.path.startsWith(vaultRoot)
      ? node.path.slice(vaultRoot.length).replace(/^[/\\]/, "")
      : node.path;
    out.push({ path: node.path, relPath, depth });
    if (node.children?.length) {
      out.push(...flattenFolders(node.children, vaultRoot, depth + 1));
    }
  }
  return out;
}

export function FolderPickerPopover({
  open,
  onOpenChange,
  trigger,
  defaultParentFolderPath,
  onSelect,
  title = "Save to folder"
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  /** Highlighted as the recommended default in the list. `null` = vault root. */
  defaultParentFolderPath: string | null;
  /** Called with the chosen folder path; `null` means vault root. */
  onSelect: (folderPath: string | null) => void;
  title?: string;
}): React.JSX.Element {
  const [vaultRoot, setVaultRoot] = useState<string>("");
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const [root, nodes] = await Promise.all([
      window.api.fs.getVaultRoot(),
      window.api.fs.listDir()
    ]);
    setVaultRoot(root);
    setFolders(flattenFolders(nodes, root));
  }, []);

  useEffect(() => {
    if (!open) {
      setCreating(false);
      setNewFolderName("");
      setCreateError(null);
      return;
    }
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (creating) {
      // Tick after render so Popover has positioned the new input.
      requestAnimationFrame(() => newFolderInputRef.current?.focus());
    }
  }, [creating]);

  const defaultLabel = useMemo(() => {
    if (!defaultParentFolderPath) return "Vault root";
    if (vaultRoot && defaultParentFolderPath.startsWith(vaultRoot)) {
      const rel = defaultParentFolderPath.slice(vaultRoot.length).replace(/^[/\\]/, "");
      return rel || "Vault root";
    }
    return defaultParentFolderPath;
  }, [defaultParentFolderPath, vaultRoot]);

  const handleSelect = useCallback(
    (folderPath: string | null) => {
      onOpenChange(false);
      onSelect(folderPath);
    },
    [onOpenChange, onSelect]
  );

  async function submitNewFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    if (!vaultRoot) return;
    const result = await window.api.fs.createFolder({
      parentFolderPath: vaultRoot,
      folderName: name
    });
    if (!result.success) {
      setCreateError(result.error ?? "Could not create folder");
      return;
    }
    handleSelect(result.folderPath);
  }

  function handleNewFolderKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitNewFolder();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setCreating(false);
      setNewFolderName("");
      setCreateError(null);
    }
  }

  const isDefaultRoot = defaultParentFolderPath === null;

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-72 p-0" align="end" side="top" sideOffset={6}>
        <PopoverTitle className="sr-only">{title}</PopoverTitle>
        <Command>
          <CommandInput placeholder="Search folders…" />
          <CommandList>
            <CommandEmpty>No folders found.</CommandEmpty>
            <CommandGroup heading="Save to">
              <CommandItem
                value="vault root"
                onSelect={() => handleSelect(null)}
              >
                <HomeIcon />
                <span className="truncate">Vault root</span>
                {isDefaultRoot && (
                  <span className="ml-auto text-xs text-muted-foreground">Default</span>
                )}
              </CommandItem>
              {folders.map((f) => {
                const isDefault = !isDefaultRoot && f.path === defaultParentFolderPath;
                return (
                  <CommandItem
                    key={f.path}
                    value={f.relPath}
                    onSelect={() => handleSelect(f.path)}
                  >
                    <span style={{ width: f.depth * 12 }} aria-hidden />
                    <FolderIcon />
                    <span className="truncate">{f.relPath.split(/[/\\]/).pop()}</span>
                    {isDefault && (
                      <span className="ml-auto text-xs text-muted-foreground">Default</span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              {creating ? (
                <div className="flex flex-col gap-1 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />
                    <input
                      ref={newFolderInputRef}
                      value={newFolderName}
                      onChange={(e) => {
                        setNewFolderName(e.target.value);
                        setCreateError(null);
                      }}
                      onKeyDown={handleNewFolderKeyDown}
                      placeholder="New folder name"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                  {createError && (
                    <span className="pl-6 text-xs text-destructive">{createError}</span>
                  )}
                </div>
              ) : (
                <CommandItem
                  value="__create_new_folder__"
                  onSelect={() => setCreating(true)}
                >
                  <FolderPlusIcon />
                  <span>New folder…</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
