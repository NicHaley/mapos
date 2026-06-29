import { useCallback, useRef, useState } from "react";

export interface UseLocalStorageOptions<T> {
  /** Turn the value into a string for storage. Defaults to JSON.stringify. */
  serialize?: (value: T) => string;
  /** Parse the stored string back into a value. Defaults to JSON.parse. */
  deserialize?: (raw: string) => T;
}

type SetValue<T> = (value: T | ((prev: T) => T)) => void;

/**
 * State backed by localStorage. Behaves like `useState`, but the value is
 * restored from storage on mount and written back on every change.
 *
 * `key` may be `null` while it is still being resolved (e.g. an async vault
 * path). While null the hook is purely in-memory; once a key arrives — or
 * changes — the value is re-read for that key synchronously during render, so
 * effects in the same commit observe the restored value (no hydration flag or
 * load-order race). Writes only happen through the returned setter, so the
 * restore step never clobbers stored data.
 */
export function useLocalStorage<T>(
  key: string | null,
  initialValue: T,
  options: UseLocalStorageOptions<T> = {}
): [T, SetValue<T>] {
  const serializeRef = useRef(options.serialize ?? ((v: T) => JSON.stringify(v)));
  serializeRef.current = options.serialize ?? serializeRef.current;
  const deserializeRef = useRef(options.deserialize ?? ((raw: string) => JSON.parse(raw) as T));
  deserializeRef.current = options.deserialize ?? deserializeRef.current;
  const initialRef = useRef(initialValue);
  const keyRef = useRef(key);
  keyRef.current = key;

  const read = (k: string): T => {
    try {
      const raw = window.localStorage.getItem(k);
      return raw == null ? initialRef.current : deserializeRef.current(raw);
    } catch {
      return initialRef.current;
    }
  };

  const [value, setState] = useState<T>(() => (key ? read(key) : initialRef.current));

  // Re-read when the key changes (async resolution or a switch). Adjusting state
  // during render is React's documented pattern — it re-renders before commit, so
  // the restored value is visible to this render's effects.
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setState(key ? read(key) : initialRef.current);
  }

  const setValue = useCallback<SetValue<T>>((update) => {
    setState((prev) => {
      const next = typeof update === "function" ? (update as (p: T) => T)(prev) : update;
      const k = keyRef.current;
      if (k) {
        try {
          window.localStorage.setItem(k, serializeRef.current(next));
        } catch {
          // Ignore quota / serialization errors — persistence is best-effort.
        }
      }
      return next;
    });
  }, []);

  return [value, setValue];
}
