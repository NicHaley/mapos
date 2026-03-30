import { useEffect, useRef } from "react";

export type ShortcutDef = {
  key: string;
  meta?: boolean; // Cmd on Mac, Ctrl on Windows/Linux
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutEntry = {
  def: ShortcutDef;
  handler: () => void;
};

const isMac = navigator.platform.toUpperCase().includes("MAC");

/** Symbol to display for the platform modifier key (⌘ on Mac, Ctrl elsewhere). */
export const modSymbol = isMac ? "⌘" : "Ctrl";

export function useShortcuts(shortcuts: ShortcutEntry[]) {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Don't fire when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable)
        return;

      for (const { def, handler } of ref.current) {
        const metaMatch = def.meta ? (isMac ? e.metaKey : e.ctrlKey) : !e.metaKey && !e.ctrlKey;
        if (
          e.key.toLowerCase() === def.key.toLowerCase() &&
          metaMatch &&
          !!e.shiftKey === !!def.shift &&
          !!e.altKey === !!def.alt
        ) {
          e.preventDefault();
          handler();
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
