import { useSyncExternalStore } from "react";

/** "Map color" appearance setting — orthogonal to the light/dark theme.
 * Full = the tinted light/dark basemap; Monochrome = the pure white/black one. */
export type MapColor = "full" | "monochrome";

export const MAP_COLOR_KEY = "mapos_map_color";
const CHANGE_EVENT = "mapos:map-color-changed";

export function readStoredMapColor(): MapColor {
  return localStorage.getItem(MAP_COLOR_KEY) === "monochrome" ? "monochrome" : "full";
}

export function applyMapColor(value: MapColor): void {
  localStorage.setItem(MAP_COLOR_KEY, value);
  // Notify same-document listeners (the `storage` event only fires cross-tab).
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useMapColor(): MapColor {
  return useSyncExternalStore(subscribe, readStoredMapColor);
}
