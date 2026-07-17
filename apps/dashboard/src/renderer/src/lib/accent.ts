import { useSyncExternalStore } from "react";

/** UI accent colour — orthogonal to the light/dark theme and the map-color setting.
 * Monochrome is the adaptive greyscale default (tracks light/dark); every other
 * option is a fixed Tailwind -500 hue that reads the same in both themes. */
export type Accent =
  | "monochrome"
  | "blue"
  | "purple"
  | "pink"
  | "red"
  | "orange"
  | "yellow"
  | "green";

export type AccentOption = {
  id: Accent;
  label: string;
  /** null for monochrome — means "fall back to the stylesheet's adaptive greys". */
  hex: string | null;
  /** Readable foreground on top of `hex` (white for most, near-black for yellow). */
  foreground: string;
};

export const ACCENT_PALETTE: AccentOption[] = [
  { id: "monochrome", label: "Monochrome", hex: null, foreground: "#ffffff" },
  { id: "blue", label: "Blue", hex: "#3b82f6", foreground: "#ffffff" },
  { id: "purple", label: "Purple", hex: "#a855f7", foreground: "#ffffff" },
  { id: "pink", label: "Pink", hex: "#ec4899", foreground: "#ffffff" },
  { id: "red", label: "Red", hex: "#ef4444", foreground: "#ffffff" },
  { id: "orange", label: "Orange", hex: "#f97316", foreground: "#ffffff" },
  { id: "yellow", label: "Yellow", hex: "#eab308", foreground: "#1c1917" },
  { id: "green", label: "Green", hex: "#22c55e", foreground: "#ffffff" }
];

export const ACCENT_KEY = "mapos_accent";
const CHANGE_EVENT = "mapos:accent-changed";

/** Grey used for un-coloured map features when the accent is monochrome — matches
 * the historical default so monochrome behaves exactly as before this feature. */
const MONOCHROME_FEATURE_COLOR = "#6b7280";

function optionFor(accent: Accent): AccentOption {
  return ACCENT_PALETTE.find((o) => o.id === accent) ?? ACCENT_PALETTE[0];
}

export function readStoredAccent(): Accent {
  const stored = localStorage.getItem(ACCENT_KEY);
  return ACCENT_PALETTE.some((o) => o.id === stored) ? (stored as Accent) : "monochrome";
}

/** Override the primary/sidebar-primary CSS custom properties inline on the root
 * element (beats both the :root and .dark stylesheet blocks) for a coloured accent,
 * or remove them so the adaptive greyscale returns for monochrome. */
export function applyAccent(accent: Accent): void {
  const { hex, foreground } = optionFor(accent);
  const root = document.documentElement.style;
  const vars = ["--primary", "--sidebar-primary"];
  const fgVars = ["--primary-foreground", "--sidebar-primary-foreground"];
  if (hex) {
    for (const v of vars) root.setProperty(v, hex);
    for (const v of fgVars) root.setProperty(v, foreground);
  } else {
    for (const v of [...vars, ...fgVars]) root.removeProperty(v);
  }
  localStorage.setItem(ACCENT_KEY, accent);
  // Notify same-document listeners (the `storage` event only fires cross-tab).
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The default colour for map features with no explicit `color` frontmatter:
 * the accent hue, or the historical grey when monochrome. */
export function featureDefaultColor(accent: Accent): string {
  return optionFor(accent).hex ?? MONOCHROME_FEATURE_COLOR;
}

/** The accent hue as a hex string, or null for monochrome (callers pick a
 * theme-adaptive fallback). Used by map overlays that were previously a fixed hue. */
export function accentHex(accent: Accent): string | null {
  return optionFor(accent).hex;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useAccent(): Accent {
  return useSyncExternalStore(subscribe, readStoredAccent);
}
