import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Button } from "./ui/button";
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
  onForward,
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
            <Button
              key={tab.id}
              variant="ghost"
              size="sm"
              onClick={() => onTabActivate(i)}
              className={`
                group flex-shrink-0 max-w-[160px] gap-1 pr-1
                ${isActive
                  ? "bg-sidebar-foreground/15 hover:bg-sidebar-foreground/20 text-sidebar-foreground"
                  : "text-sidebar-foreground/50 hover:text-sidebar-foreground/80"
                }
              `}
            >
              <span className="truncate">{tab.title}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(i);
                }}
                className={`
                  flex-shrink-0 rounded
                  ${isActive
                    ? "opacity-60 hover:opacity-100"
                    : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
                  }
                `}
              >
                <XIcon />
              </Button>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
