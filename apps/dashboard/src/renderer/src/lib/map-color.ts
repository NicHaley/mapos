import { useSyncExternalStore } from "react";

/** "Map color" appearance setting — orthogonal to the light/dark theme.
 * Full = the tinted light/dark basemap; Monochrome = the pure white/black one. */
export type MapColor = "full" | "monochrome";

const CHANGE_EVENT = "mapos:map-color-changed";

// The canonical value lives in the vault's appearance.json; this module keeps a
// synchronous in-memory mirror (hydrated at boot, before first paint) so
// useSyncExternalStore snapshots stay sync.
let currentMapColor: MapColor = "full";

export function parseMapColor(value: unknown): MapColor {
  return value === "monochrome" ? "monochrome" : "full";
}

export function getMapColor(): MapColor {
  return currentMapColor;
}

/** Apply without persisting — used at boot with the value read from appearance.json. */
export function hydrateMapColor(value: MapColor): void {
  currentMapColor = value;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Apply and persist to the active vault's appearance.json. */
export function setMapColor(value: MapColor): void {
  hydrateMapColor(value);
  void window.api.appearance
    .set({ mapColor: value })
    .then((r) => {
      if (!r.ok) console.error("Failed to save map color:", r.error);
    })
    .catch((e) => console.error("Failed to save map color:", e));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
  };
}

export function useMapColor(): MapColor {
  return useSyncExternalStore(subscribe, getMapColor);
}
