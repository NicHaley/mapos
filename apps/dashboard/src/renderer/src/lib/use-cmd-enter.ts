import { useEffect } from "react";

/**
 * Fire `handler` when the user presses ⌘↵ (or Ctrl+Enter on non-mac). Used across the
 * onboarding steps so the primary action ("Continue", "Save & continue", "Open MapOS") has a
 * consistent keyboard shortcut. Pass `enabled: false` to mirror a disabled primary button so
 * the shortcut can't trigger an action the user can't click.
 */
export function useCmdEnter(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handler, enabled]);
}
