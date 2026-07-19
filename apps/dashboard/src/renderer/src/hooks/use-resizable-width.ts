import { useCallback, useEffect, useRef, useState } from "react";

interface UseResizableWidthOptions {
  /** May be `null` while it is still being resolved (e.g. an async vault path);
   * the hook is purely in-memory until a key arrives. */
  storageKey: string | null;
  /** Pre-scoping key to seed from (and clean up) when `storageKey` has no value yet. */
  legacyStorageKey?: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

interface UseResizableWidthResult {
  width: number;
  setWidth: (w: number) => void;
  startDrag: (e: React.PointerEvent) => void;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

function readInitialWidth(opts: UseResizableWidthOptions, key: string): number {
  if (typeof window === "undefined") return opts.defaultWidth;
  try {
    const raw =
      window.localStorage.getItem(key) ??
      (opts.legacyStorageKey != null ? window.localStorage.getItem(opts.legacyStorageKey) : null);
    if (raw == null) return opts.defaultWidth;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return opts.defaultWidth;
    return clamp(parsed, opts.minWidth, opts.maxWidth);
  } catch {
    return opts.defaultWidth;
  }
}

export function useResizableWidth(opts: UseResizableWidthOptions): UseResizableWidthResult {
  const { storageKey, legacyStorageKey, minWidth, maxWidth } = opts;
  const [width, setWidthState] = useState<number>(() =>
    storageKey != null ? readInitialWidth(opts, storageKey) : opts.defaultWidth
  );

  // Re-read when the key changes (async resolution or a switch). Adjusting state
  // during render — not in an effect — so the persist effect below never sees
  // (and writes) the stale default under the new key.
  const [prevKey, setPrevKey] = useState(storageKey);
  if (storageKey !== prevKey) {
    setPrevKey(storageKey);
    setWidthState(storageKey != null ? readInitialWidth(opts, storageKey) : opts.defaultWidth);
  }

  useEffect(() => {
    if (storageKey == null) return;
    try {
      window.localStorage.setItem(storageKey, String(width));
      if (legacyStorageKey != null) window.localStorage.removeItem(legacyStorageKey);
    } catch {
      // ignore quota / privacy errors
    }
  }, [storageKey, legacyStorageKey, width]);

  const setWidth = useCallback(
    (w: number) => {
      setWidthState(clamp(w, minWidth, maxWidth));
    },
    [minWidth, maxWidth]
  );

  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      dragStateRef.current = { startX: event.clientX, startWidth: width };

      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        const drag = dragStateRef.current;
        if (!drag) return;
        const next = drag.startWidth + (e.clientX - drag.startX);
        setWidthState(clamp(next, minWidth, maxWidth));
      };

      const onUp = () => {
        dragStateRef.current = null;
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [width, minWidth, maxWidth]
  );

  return { width, setWidth, startDrag };
}
