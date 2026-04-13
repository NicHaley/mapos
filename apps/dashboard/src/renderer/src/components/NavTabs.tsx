import { cn } from "@renderer/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Reorder, motion } from "motion/react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

type NavTabsProps = {
  tabs: Array<{ id: string; title: string }>;
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
    <div className="flex h-full min-w-0 flex-1 items-center gap-0.5" style={noDrag}>
      <Button variant="ghost" size="icon-sm" onClick={onBack} disabled={!canBack}>
        <ChevronLeftIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onForward} disabled={!canForward}>
        <ChevronRightIcon />
      </Button>

      <Separator orientation="vertical" className="mx-0.5 h-4! self-auto" />

      <motion.div
        layoutScroll
        className="flex min-h-0 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Reorder.Group
          axis="x"
          values={tabs.map((t) => t.id)}
          onReorder={onTabReorder}
          as="div"
          className="flex w-max items-center gap-0.5"
        >
          {tabs.map((tab, i) => {
            const isActive = i === activeTabIndex;
            return (
              <Reorder.Item
                key={tab.id}
                value={tab.id}
                as="div"
                role="tab"
                tabIndex={0}
                onClick={() => onTabActivate(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onTabActivate(i);
                }}
                className={cn(
                  // Avoid buttonVariants: base `active:translate-y-px` + `transition-all` conflict with Motion drag.
                  "group relative inline-flex h-7 max-w-[160px] shrink-0 cursor-pointer items-center gap-1 rounded-[min(var(--radius-md),12px)] border border-transparent bg-clip-padding pr-1 pl-2.5 text-[0.8rem] font-medium outline-none select-none transition-colors",
                  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent"
                    : "text-sidebar-foreground/50 hover:text-sidebar-foreground/80"
                )}
              >
                <span className="truncate">{tab.title}</span>
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
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      </motion.div>
    </div>
  );
}
