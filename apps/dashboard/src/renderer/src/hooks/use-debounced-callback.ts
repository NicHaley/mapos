import { useCallback, useRef } from "react";

export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number
): ((...args: A) => void) & { cancel: () => void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const debounced = useCallback(
    (...args: A) => {
      cancel();
      timer.current = setTimeout(() => {
        fnRef.current(...args);
      }, delay);
    },
    [cancel, delay]
  ) as (...args: A) => void;

  return Object.assign(debounced, { cancel }) as ((...args: A) => void) & {
    cancel: () => void;
  };
}
