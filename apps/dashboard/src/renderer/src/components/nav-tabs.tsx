import { modSymbol } from "@renderer/hooks/use-shortcuts";
import { iconForFilename } from "@renderer/lib/file-icons";
import { cn } from "@mapos/ui/lib/utils";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  MessageCircleIcon,
  XIcon
} from "lucide-react";
import { Reorder, motion } from "motion/react";
import { Button } from "@mapos/ui/components/button";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { Separator } from "@mapos/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";

export type NavTabData =
  | { id: string; title: string; kind: "place"; filePath: string }
  | { id: string; title: string; kind: "folder" }
  | { id: string; title: string; kind: "chat" };

type NavTabsProps = {
  tabs: NavTabData[];
  activeTabIndex: number;
  canBack: boolean;
  canForward: boolean;
  onTabActivate: (index: number) => void;
  onTabClose: (index: number) => void;
  onTabReorder: (newOrder: string[]) => void;
  onBack: () => void;
  onForward: () => void;
};

const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;

function tabIcon(tab: NavTabData): React.ElementType {
  if (tab.kind === "chat") return MessageCircleIcon;
  if (tab.kind === "folder") return FolderIcon;
  return iconForFilename(tab.filePath);
}

export function NavTabs({
  tabs,
  activeTabIndex,
  canBack,
  canForward,
  onTabActivate,
  onTabClose,
  onTabReorder,
  onBack,
  onForward
}: NavTabsProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 items-center gap-0.5" style={dragRegion}>
      <div className="flex shrink-0 items-center gap-0.5" style={noDrag}>
        <Button variant="ghost" size="icon-sm" onClick={onBack} disabled={!canBack}>
          <ChevronLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onForward} disabled={!canForward}>
          <ChevronRightIcon />
        </Button>

        <Separator orientation="vertical" className="mx-0.5 h-4! self-auto" />
      </div>

      <motion.div
        layoutScroll
        className="flex min-h-0 min-w-0 shrink overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ ...noDrag, flex: "0 1 auto" } as React.CSSProperties}
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
                  "group relative inline-flex h-7 max-w-[160px] shrink-0 cursor-pointer items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-transparent bg-clip-padding pr-1 pl-2 text-[0.8rem] font-medium outline-none select-none transition-colors",
                  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent"
                    : "bg-sidebar-accent/40 text-sidebar-foreground/50 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/80"
                )}
              >
                <Icon className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{tab.title}</span>
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

      {/* Fills remaining top-bar width so the window can be dragged beside the tab strip */}
      <div className="min-h-0 min-w-0 flex-1 self-stretch" style={dragRegion} aria-hidden />
    </div>
  );
}
