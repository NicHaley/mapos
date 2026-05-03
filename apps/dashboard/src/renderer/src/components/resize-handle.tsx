import { cn } from "@mapos/ui/lib/utils";

interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  side?: "left" | "right";
  className?: string;
  ariaLabel?: string;
  /** Pixel offset of the rail line from the parent's edge. Positive shifts outward. */
  offset?: number;
}

export function ResizeHandle({
  onPointerDown,
  side = "right",
  className,
  ariaLabel = "Resize",
  offset = 0
}: ResizeHandleProps) {
  const inset = -(4 + offset);
  return (
    <button
      type="button"
      data-slot="resize-handle"
      data-side={side}
      aria-label={ariaLabel}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      style={side === "right" ? { right: inset } : { left: inset }}
      className={cn(
        "absolute inset-y-0 z-30 w-2 cursor-ew-resize touch-none select-none bg-transparent",
        "after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-sidebar-foreground/40 active:after:bg-sidebar-foreground/60",
        className
      )}
    />
  );
}
