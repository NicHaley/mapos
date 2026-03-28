import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";

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
      {/* Back */}
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        className="flex-shrink-0 flex items-center justify-center size-6 rounded text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-foreground/8 disabled:opacity-30 disabled:pointer-events-none transition-colors"
      >
        <ChevronLeftIcon className="size-3.5" />
      </button>

      {/* Forward */}
      <button
        type="button"
        onClick={onForward}
        disabled={!canForward}
        className="flex-shrink-0 flex items-center justify-center size-6 rounded text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-foreground/8 disabled:opacity-30 disabled:pointer-events-none transition-colors"
      >
        <ChevronRightIcon className="size-3.5" />
      </button>

      {/* Divider */}
      <div className="flex-shrink-0 w-px h-4 bg-sidebar-foreground/15 mx-0.5" />

      {/* Tab strip */}
      <div className="flex items-center gap-0.5 overflow-x-auto min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((tab, i) => {
          const isActive = i === activeTabIndex;
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => onTabActivate(i)}
              className={`
                group flex-shrink-0 flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded text-xs max-w-[160px] transition-colors
                ${isActive
                  ? "bg-sidebar-foreground/15 text-sidebar-foreground"
                  : "text-sidebar-foreground/50 hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground/80"
                }
              `}
            >
              <span className="truncate">{tab.title}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(i);
                }}
                className={`
                  flex-shrink-0 flex items-center justify-center size-4 rounded transition-colors
                  ${isActive
                    ? "opacity-60 hover:opacity-100 hover:bg-sidebar-foreground/15"
                    : "opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-sidebar-foreground/10"
                  }
                `}
              >
                <XIcon className="size-2.5" />
              </button>
            </button>
          );
        })}
      </div>
    </div>
  );
}
