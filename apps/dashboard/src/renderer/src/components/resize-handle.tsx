import { cn } from "@mapos/ui/lib/utils";

interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  side?: "left" | "right";
  className?: string;
  ariaLabel?: string;
}

export function ResizeHandle({
  onPointerDown,
  side = "right",
  className,
  ariaLabel = "Resize"
}: ResizeHandleProps) {
  return (
    <button
      type="button"
      data-slot="resize-handle"
      data-side={side}
      aria-label={ariaLabel}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      className={cn(
        "absolute inset-y-0 z-30 w-2 cursor-ew-resize touch-none select-none bg-transparent",
        "after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-sidebar-border active:after:bg-sidebar-border",
        side === "right" ? "-right-1" : "-left-1",
        className
      )}
    />
  );
}
