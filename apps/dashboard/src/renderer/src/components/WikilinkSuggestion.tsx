import { cn } from "@renderer/lib/utils";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface WikilinkItem {
  title: string;
  filePath: string;
}

export interface WikilinkSuggestionProps {
  items: WikilinkItem[];
  command: (item: WikilinkItem) => void;
  clientRect?: (() => DOMRect | null) | null;
}

export interface WikilinkSuggestionRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const WikilinkSuggestion = forwardRef<
  WikilinkSuggestionRef,
  WikilinkSuggestionProps
>(({ items, command, clientRect }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when item list identity changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    const rect = clientRect?.();
    if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
  }, [clientRect]);

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
    },
  }));

  if (!pos || !items.length) return null;

  return createPortal(
    <div
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
      className="rounded-lg border border-sidebar-border bg-sidebar shadow-lg py-1 min-w-[180px] max-w-xs"
    >
      {items.map((item, i) => (
        <button
          key={item.filePath}
          type="button"
          className={cn(
            "w-full text-left px-3 py-1.5 text-xs text-sidebar-foreground transition-colors",
            i === selectedIndex
              ? "bg-sidebar-accent"
              : "hover:bg-sidebar-accent/50"
          )}
          onMouseEnter={() => setSelectedIndex(i)}
          onClick={() => command(item)}
        >
          <span className="text-sidebar-foreground/50">[[</span>
          {item.title}
          <span className="text-sidebar-foreground/50">]]</span>
        </button>
      ))}
    </div>,
    document.body
  );
});

WikilinkSuggestion.displayName = "WikilinkSuggestion";
