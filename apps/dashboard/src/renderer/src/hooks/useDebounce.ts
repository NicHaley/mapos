import { useEffect, useState } from "react";

/**
 * Returns `value` after it has stayed stable for `delayMs`.
 * Empty string updates apply immediately so clears do not flash stale results.
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === "") {
      setDebounced(value);
      return;
    }
    const t = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
