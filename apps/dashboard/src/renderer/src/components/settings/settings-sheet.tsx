import { Button } from "@mapos/ui/components/button";
import { cn } from "@mapos/ui/lib/utils";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useSettingsSheetSlot } from "../settings-dialog";

/**
 * A drawer-style panel that slides over the Settings dialog body, not the
 * entire viewport. Implemented as a plain transform-animated panel rather than
 * a Base UI Dialog: a nested Dialog inherits modal scroll-lock, which nudged
 * the dialog body sideways every time the panel opened.
 */
const TRANSITION_MS = 220;

export function SettingsSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  side = "right",
  width = 360,
  bodyClassName
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  side?: "right" | "left";
  width?: number;
  /** Override the body wrapper classes (default: padded + own scroll). Pass a flush, self-scrolling
   * layout when the child manages its own scroll area (e.g. a Command list filling the drawer). */
  bodyClassName?: string;
}): React.JSX.Element | null {
  const slot = useSettingsSheetSlot();
  const titleId = useId();
  const descId = useId();
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two rAFs guarantee the offscreen panel is painted before we toggle to
      // the onscreen position; otherwise the browser may coalesce both states
      // into one paint and skip the slide animation entirely.
      let raf2: number | null = null;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setActive(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2 !== null) cancelAnimationFrame(raf2);
      };
    }
    setActive(false);
    const id = window.setTimeout(() => setMounted(false), TRANSITION_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  if (!slot || !mounted) return null;

  const offscreen = side === "right" ? "translate-x-full" : "-translate-x-full";

  return createPortal(
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a pointer-only convenience; keyboard users press Escape, handled by the document listener above. */}
      <div
        className={cn(
          "pointer-events-auto absolute inset-0 z-0 bg-background/60 transition-opacity duration-200 ease-out",
          active ? "opacity-100" : "opacity-0"
        )}
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      {/* biome-ignore lint/a11y/useSemanticElements: <dialog> brings native modal behavior (showModal, top-layer) that conflicts with this in-flow slide-in panel. */}
      <div
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        style={{ width: `${width}px` }}
        className={cn(
          "pointer-events-auto absolute inset-y-0 z-10 flex max-w-full flex-col bg-sidebar/80 text-sm text-foreground shadow-xl outline-none backdrop-blur-md transition-transform duration-200 ease-out",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
          !active && offscreen
        )}
      >
        <header className="flex items-start justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-medium text-foreground">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-0.5 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <XIcon className="size-4" />
          </Button>
        </header>
        <div className={cn("flex-1 overflow-y-auto px-4 py-4", bodyClassName)}>{children}</div>
        {footer && <div className="border-t px-4 py-3">{footer}</div>}
      </div>
    </>,
    slot
  );
}
