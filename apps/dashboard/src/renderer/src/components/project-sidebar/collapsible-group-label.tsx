import { SidebarGroupLabel } from "@mapos/ui/components/sidebar";
import { cn } from "@mapos/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";

export function CollapsibleGroupLabel({
  label,
  open,
  onToggle
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <SidebarGroupLabel
      render={
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="group/group-label cursor-pointer gap-1 hover:bg-hover hover:text-sidebar-accent-foreground group-hover/group-header:bg-hover group-hover/group-header:text-sidebar-accent-foreground"
        />
      }
    >
      <span>{label}</span>
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 text-sidebar-foreground/50 opacity-0 transition-[transform,opacity] group-hover/group-label:opacity-100",
          open && "rotate-90"
        )}
      />
    </SidebarGroupLabel>
  );
}
