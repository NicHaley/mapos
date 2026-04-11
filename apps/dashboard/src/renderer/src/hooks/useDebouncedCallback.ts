import { useCallback, useEffect, useRef } from "react";

export function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): T & { cancel: () => void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const debounced = useCallback(
    (...args: Parameters<T>) => {
      cancel();
      timer.current = setTimeout(() => {
        fnRef.current(...args);
      }, delay);
    },
    [cancel, delay]
  ) as T;

  return Object.assign(debounced, { cancel });
}
