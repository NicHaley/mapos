import { Button } from "@mapos/ui/components/button";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { Surface } from "@mapos/ui/components/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { modSymbol } from "@renderer/hooks/use-shortcuts";
import { iconForFilename } from "@renderer/lib/file-icons";
import { FolderIcon, TextSearchIcon, XIcon } from "lucide-react";
import { Reorder, motion } from "motion/react";
import { memo, useState } from "react";

export type NavTabData =
  | { id: string; title: string; kind: "place"; filePath: string }
  | { id: string; title: string; kind: "folder" }
  | { id: string; title: string; kind: "list" };

type NavTabsProps = {
  tabs: NavTabData[];
  activeTabIndex: number;
  onTabActivate: (index: number) => void;
  onTabClose: (index: number) => void;
  onTabReorder: (newOrder: string[]) => void;
};

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;

function tabIcon(tab: NavTabData): React.ElementType {
  if (tab.kind === "folder") return FolderIcon;
  if (tab.kind === "list") return TextSearchIcon;
  return iconForFilename(tab.filePath);
}

export const NavTabs = memo(function NavTabs({
  tabs,
  activeTabIndex,
  onTabActivate,
  onTabClose,
  onTabReorder
}: NavTabsProps) {
  // Tabs animate their layout only while a drag is in flight; opening, closing,
  // or switching tabs repositions instantly (transition duration 0).
  const [isDragging, setIsDragging] = useState(false);

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 items-center gap-0.5" style={dragRegion}>
      {/* One glass cluster (mirrors the left controls + map controls) holding the tabs as segments. */}
      <Surface
        variant="cluster"
        className="min-h-0 min-w-0 shrink px-0.5"
        style={{ ...noDrag, flex: "0 1 auto" } as React.CSSProperties}
      >
        {/* py/-my pair: gives the active tab's shadow vertical room to bleed past the
            cluster (overflow-x-auto forces overflow-y to clip) without changing height. */}
        <motion.div
          layoutScroll
          className="-my-1.5 flex min-h-0 min-w-0 items-center overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Reorder.Group
            axis="x"
            values={tabs.map((t) => t.id)}
            onReorder={onTabReorder}
            as="div"
            className="flex w-max max-w-full items-center gap-0.5"
          >
            {tabs.map((tab, i) => {
              const isActive = i === activeTabIndex;
              const Icon = tabIcon(tab);
              return (
                <Reorder.Item
                  key={tab.id}
                  value={tab.id}
                  layout="position"
                  transition={{ duration: isDragging ? 0.18 : 0 }}
                  onDragStart={() => setIsDragging(true)}
                  onDragEnd={() => setIsDragging(false)}
                  as="div"
                  role="tab"
                  tabIndex={0}
                  onClick={() => onTabActivate(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onTabActivate(i);
                  }}
                  style={noDrag}
                  className={cn(
                    // Avoid buttonVariants: base `active:translate-y-px` + `transition-all` conflict with Motion drag.
                    // Fixed width so every tab is the same size regardless of title length.
                    "group relative inline-flex h-7 w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-0.5 pl-2 text-[0.8rem] font-medium outline-none select-none transition-colors",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    isActive
                      ? "bg-card text-sidebar-foreground shadow-sm dark:bg-accent"
                      : "text-sidebar-foreground/50 hover:bg-hover hover:text-sidebar-foreground/80"
                  )}
                >
                  <Icon className="size-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTabClose(i);
                          }}
                          className={cn(
                            "shrink-0 rounded",
                            isActive
                              ? "opacity-60 hover:opacity-100"
                              : "opacity-0 group-hover:opacity-60 hover:opacity-100!"
                          )}
                        >
                          <XIcon />
                        </Button>
                      }
                    />
                    <TooltipContent side="bottom">
                      Close tab
                      <KbdGroup>
                        <Kbd>{modSymbol}</Kbd>
                        <Kbd>W</Kbd>
                      </KbdGroup>
                    </TooltipContent>
                  </Tooltip>
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        </motion.div>
      </Surface>

      {/* Fills remaining top-bar width so the window can be dragged beside the tab strip */}
      <div className="min-h-0 min-w-0 flex-1 self-stretch" style={dragRegion} aria-hidden />
    </div>
  );
});
