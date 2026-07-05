import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
/**
 * Styling mirrors DropdownMenuContent + DropdownMenuItem from ui/dropdown-menu.tsx.
 * We can't use those components directly because they require Menu.Root context,
 * which steals editor focus and breaks TipTap's keyboard routing.
 * Positioning uses @floating-ui/dom (same lib base-ui uses internally).
 */
import { cn } from "@mapos/ui/lib/utils";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface WikilinkItem {
  title: string;
  /** Vault-relative path without the `.md` extension (e.g. `tokyo/kinka-izakaya`). */
  relPath: string;
  filePath: string;
  /** Link text to insert — the relPath when the title alone is ambiguous, else the title. */
  linkTarget: string;
}

export interface WikilinkSuggestionProps {
  items: WikilinkItem[];
  command: (item: WikilinkItem) => void;
  clientRect?: (() => DOMRect | null) | null;
  onDismiss?: () => void;
}

export interface WikilinkSuggestionRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const WikilinkSuggestion = forwardRef<WikilinkSuggestionRef, WikilinkSuggestionProps>(
  ({ items, command, clientRect, onDismiss }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [style, setStyle] = useState<React.CSSProperties>({
      position: "fixed",
      visibility: "hidden"
    });
    const popupRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const clientRectRef = useRef(clientRect);
    clientRectRef.current = clientRect;

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset on new item list
    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useEffect(() => {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    useEffect(() => {
      if (!onDismiss) return;
      function handleMouseDown(e: MouseEvent) {
        if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
          onDismiss?.();
        }
      }
      document.addEventListener("mousedown", handleMouseDown);
      return () => document.removeEventListener("mousedown", handleMouseDown);
    }, [onDismiss]);

    // Virtual anchor: an object with getBoundingClientRect that floating-ui can position against.
    // autoUpdate re-runs computePosition on scroll/resize so the popup tracks the cursor.
    useEffect(() => {
      if (!popupRef.current || !items.length) return;

      const virtualEl = {
        getBoundingClientRect: () => clientRectRef.current?.() ?? new DOMRect()
      };

      const cleanup = autoUpdate(virtualEl, popupRef.current, () => {
        if (!popupRef.current) return;
        computePosition(virtualEl, popupRef.current, {
          placement: "bottom-start",
          middleware: [offset(6), flip(), shift({ padding: 8 })]
        }).then(({ x, y }) => {
          setStyle({ position: "fixed", top: y, left: x, visibility: "visible" });
        });
      });

      return cleanup;
    }, [items.length]);

    useImperativeHandle(ref, () => ({
      onKeyDown({ event }) {
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        return false;
      }
    }));

    if (!items.length) return null;

    return createPortal(
      <div
        ref={popupRef}
        style={{ ...style, zIndex: 9999 }}
        // DropdownMenuContent styling (minus anchor-width / transform-origin CSS vars that need
        // base-ui). Scrolling lives on an inner element: the before: backdrop-blur layer is only
        // viewport-sized, so it would scroll out of view with the content.
        className="z-50 min-w-32 rounded-lg text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none relative bg-popover/70 before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:backdrop-blur-2xl before:backdrop-saturate-150"
      >
        <div className="max-h-72 overflow-y-auto rounded-[inherit] p-1">
          {items.map((item, i) => (
            <button
              key={item.filePath}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              // DropdownMenuItem styling
              className={cn(
                "group/dropdown-menu-item relative flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none select-none",
                i === selectedIndex && "bg-foreground/10 text-popover-foreground"
              )}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => command(item)}
            >
              <span className="truncate">{item.title}</span>
              {item.linkTarget !== item.title && (
                <span className="ml-auto truncate text-xs text-muted-foreground">
                  {item.relPath.slice(0, item.relPath.length - item.title.length - 1)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>,
      document.body
    );
  }
);

WikilinkSuggestion.displayName = "WikilinkSuggestion";
