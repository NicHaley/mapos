import { cn } from "@mapos/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";

export function GroupHeader({
  label,
  action
}: {
  label: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center justify-between">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {action}
    </div>
  );
}

/**
 * Collapsible continent header — the top level of the region tree. A chevron
 * rotates open, the region count sits on the right. The whole row is the toggle.
 */
export function ContinentHeader({
  label,
  count,
  expanded,
  onToggle
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex h-8 w-full items-center gap-1.5 text-left"
    >
      <ChevronRightIcon
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-transform",
          expanded && "rotate-90"
        )}
      />
      <span className="text-sm font-semibold">{label}</span>
      <span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}
