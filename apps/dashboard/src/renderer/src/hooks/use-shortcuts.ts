import { useEffect, useRef } from "react";

export type ShortcutDef = {
  /** Match against `e.key` (layout-dependent). Use `code` instead when modifiers
   * change the produced character (e.g. Cmd+Shift+] reports inconsistently across OSes). */
  key?: string;
  /** Match against `e.code` (physical key, layout/modifier independent), e.g. "BracketRight". */
  code?: string;
  meta?: boolean; // Cmd on Mac, Ctrl on Windows/Linux
  shift?: boolean;
  alt?: boolean;
  enabled?: boolean; // defaults to true; when false, shortcut is skipped (allows native/Electron default)
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
      const tag = (e.target as HTMLElement).tagName;
      const isTextTarget =
        tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable;

      for (const { def, handler } of ref.current) {
        const metaMatch = def.meta ? (isMac ? e.metaKey : e.ctrlKey) : !e.metaKey && !e.ctrlKey;
        const keyMatch = def.code
          ? e.code === def.code
          : def.key
            ? e.key.toLowerCase() === def.key.toLowerCase()
            : false;
        if (
          keyMatch &&
          metaMatch &&
          !!e.shiftKey === !!def.shift &&
          !!e.altKey === !!def.alt &&
          def.enabled !== false
        ) {
          // In text inputs, only fire shortcuts that use a modifier — plain keys must reach the input.
          if (isTextTarget && !def.meta && !def.alt) return;
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
