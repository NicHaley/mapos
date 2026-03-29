import { cn } from "@renderer/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button, buttonVariants } from "./ui/button";
import { Separator } from "./ui/separator";

type NavTabsProps = {
  tabs: Array<{ id: string; title: string }>;
  activeTabIndex: number;
  canBack: boolean;
  canForward: boolean;
  onTabActivate: (index: number) => void;
  onTabClose: (index: number) => void;
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
  onBack,
  onForward
}: NavTabsProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 min-w-0 h-full" style={noDrag}>
      <Button variant="ghost" size="icon-sm" onClick={onBack} disabled={!canBack}>
        <ChevronLeftIcon />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onForward} disabled={!canForward}>
        <ChevronRightIcon />
      </Button>

      <Separator orientation="vertical" className="mx-0.5 h-4! self-auto" />

      <div className="flex items-center gap-0.5 overflow-x-auto min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab, i) => {
          const isActive = i === activeTabIndex;
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              onClick={() => onTabActivate(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onTabActivate(i);
              }}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "group shrink-0 max-w-[160px] gap-1 pr-1 cursor-pointer",
                isActive
                  ? "bg-sidebar-foreground/15 hover:bg-sidebar-foreground/20 text-sidebar-foreground"
                  : "text-sidebar-foreground/50 hover:text-sidebar-foreground/80"
              )}
            >
              <span className="truncate">{tab.title}</span>
              <Button
                variant="ghost"
                size="icon-xs"
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
