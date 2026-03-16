import { cn } from "@renderer/lib/utils";
import { ChevronRightIcon, FileIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlaceRecord } from "./MapView";
import { Sidebar, SidebarContent, SidebarHeader, SidebarTrigger } from "./ui/sidebar";

function fileIcon(name: string) {
  if (name.endsWith(".md"))
    return <FileTextIcon className="size-3.5 shrink-0 text-sidebar-foreground/50" />;
  return <FileIcon className="size-3.5 shrink-0 text-sidebar-foreground/50" />;
}

function FileTreeNode({
  node,
  depth,
  selectedFilePath,
  onSelectPlace
}: {
  node: FileNode;
  depth: number;
  selectedFilePath?: string;
  onSelectPlace?: (place: PlaceRecord) => void;
}) {
  const [open, setOpen] = useState(depth === 0);

  if (node.type === "directory") {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent"
          style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
          type="button"
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-sidebar-foreground/40 transition-transform",
              open && "rotate-90"
            )}
          />
          {open ? (
            <FolderOpenIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
          ) : (
            <FolderIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children && (
          <div>
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedFilePath={selectedFilePath}
                onSelectPlace={onSelectPlace}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isActive = node.path === selectedFilePath;

  return (
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
    >
      {fileIcon(node.name)}
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function ProjectSidebar({
  selectedFilePath,
  onSelectPlace
}: {
  selectedFilePath?: string;
  onSelectPlace?: (place: PlaceRecord) => void;
}): React.JSX.Element {
  const [tree, setTree] = useState<FileNode[]>([]);

  async function load() {
    const nodes = await window.api.fs.listDir();
    setTree(nodes);
  }

  useEffect(() => {
    load();
    window.api.fs.onChange(load);
    return () => window.api.fs.removeListeners();
  }, []);

  return (
    <Sidebar collapsible="offcanvas" variant="floating">
      <SidebarHeader className="flex-row items-center justify-between px-3 py-2 border-b border-sidebar-border">
        <span className="text-xs font-semibold tracking-widest text-sidebar-foreground/60 uppercase">
          MapOS
        </span>
        <SidebarTrigger />
      </SidebarHeader>
      <SidebarContent className="px-1 py-2">
        {tree.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedFilePath={selectedFilePath}
            onSelectPlace={onSelectPlace}
          />
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
