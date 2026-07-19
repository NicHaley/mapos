import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

/** Legacy global localStorage key from before theme became per-vault state in
 * `.mapos/appearance.json`. Read only by the one-time boot migration (and as a
 * staging write when appearance IPC is unavailable during onboarding). */
export const THEME_KEY = "mapos_theme";
const CHANGE_EVENT = "mapos:theme-changed";

// The canonical value lives in the vault's appearance.json; this module keeps a
// synchronous in-memory mirror (hydrated at boot, before first paint) so
// useSyncExternalStore snapshots stay sync.
let currentTheme: Theme = "system";

export function parseTheme(value: unknown): Theme {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function getTheme(): Theme {
  return currentTheme;
}

function applyThemeDom(theme: Theme): void {
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", prefersDark);
  } else {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
}

/** Apply without persisting — used at boot with the value read from appearance.json. */
export function hydrateTheme(theme: Theme): void {
  currentTheme = theme;
  applyThemeDom(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Apply and persist to the active vault's appearance.json. Falls back to the
 * legacy localStorage key when IPC isn't available yet (onboarding) so the
 * value survives the post-complete reload and can be migrated. */
export function setTheme(theme: Theme): void {
  hydrateTheme(theme);
  void window.api.appearance
    .set({ theme })
    .then((r) => {
      if (r.ok) {
        localStorage.removeItem(THEME_KEY);
      } else {
        localStorage.setItem(THEME_KEY, theme);
        console.error("Failed to save theme:", r.error);
      }
    })
    .catch((e) => {
      localStorage.setItem(THEME_KEY, theme);
      console.error("Failed to save theme:", e);
    });
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}
