import type { FileNode } from "@shared/types";
import { FolderIcon, HomeIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
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
    const relPath =
      vaultRoot && node.path.startsWith(vaultRoot)
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
  const [folders, setFolders] = useState<FolderEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const [root, nodes] = await Promise.all([
        window.api.fs.getVaultRoot(),
        window.api.fs.listDir()
      ]);
      setFolders(flattenFolders(nodes, root));
    })();
  }, [open]);

  const handleSelect = useCallback(
    (folderPath: string | null) => {
      onOpenChange(false);
      onSelect(folderPath);
    },
    [onOpenChange, onSelect]
  );

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
              <CommandItem value="vault root" onSelect={() => handleSelect(null)}>
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
