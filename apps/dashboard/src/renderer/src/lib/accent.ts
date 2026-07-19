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
  /** The -500 hue. null for monochrome — means "fall back to the stylesheet's adaptive greys". */
  hex: string | null;
  /** Readable foreground on top of `hex` (white for most, near-black for yellow). */
  foreground: string;
  /** Soft -200 tint for the vault-icon container background (null = monochrome default). */
  softBg: string | null;
  /** Strong -700 shade for the vault icon itself, legible on `softBg` (null = monochrome default). */
  strongFg: string | null;
};

// Tailwind -500 (hue), -200 (soft container bg), -700 (strong icon). Monochrome keeps the
// stylesheet's adaptive greys, so it carries no hexes.
export const ACCENT_PALETTE: AccentOption[] = [
  {
    id: "monochrome",
    label: "Monochrome",
    hex: null,
    foreground: "#ffffff",
    softBg: null,
    strongFg: null
  },
  {
    id: "blue",
    label: "Blue",
    hex: "#3b82f6",
    foreground: "#ffffff",
    softBg: "#bfdbfe",
    strongFg: "#1d4ed8"
  },
  {
    id: "purple",
    label: "Purple",
    hex: "#a855f7",
    foreground: "#ffffff",
    softBg: "#e9d5ff",
    strongFg: "#7e22ce"
  },
  {
    id: "pink",
    label: "Pink",
    hex: "#ec4899",
    foreground: "#ffffff",
    softBg: "#fbcfe8",
    strongFg: "#be185d"
  },
  {
    id: "red",
    label: "Red",
    hex: "#ef4444",
    foreground: "#ffffff",
    softBg: "#fecaca",
    strongFg: "#b91c1c"
  },
  {
    id: "orange",
    label: "Orange",
    hex: "#f97316",
    foreground: "#ffffff",
    softBg: "#fed7aa",
    strongFg: "#c2410c"
  },
  {
    id: "yellow",
    label: "Yellow",
    hex: "#eab308",
    foreground: "#1c1917",
    softBg: "#fef08a",
    strongFg: "#a16207"
  },
  {
    id: "green",
    label: "Green",
    hex: "#22c55e",
    foreground: "#ffffff",
    softBg: "#bbf7d0",
    strongFg: "#15803d"
  }
];

const CHANGE_EVENT = "mapos:accent-changed";

/** Grey used for un-coloured map features when the accent is monochrome — matches
 * the historical default so monochrome behaves exactly as before this feature. */
const MONOCHROME_FEATURE_COLOR = "#6b7280";

// The canonical value lives in the vault's appearance.json; this module keeps a
// synchronous in-memory mirror (hydrated at boot, before first paint) so
// useSyncExternalStore snapshots stay sync.
let currentAccent: Accent = "monochrome";

function optionFor(accent: Accent): AccentOption {
  return ACCENT_PALETTE.find((o) => o.id === accent) ?? ACCENT_PALETTE[0];
}

export function parseAccent(value: unknown): Accent {
  return ACCENT_PALETTE.some((o) => o.id === value) ? (value as Accent) : "monochrome";
}

export function getAccent(): Accent {
  return currentAccent;
}

/** Override the primary/sidebar-primary CSS custom properties inline on the root
 * element (beats both the :root and .dark stylesheet blocks) for a coloured accent,
 * or remove them so the adaptive greyscale returns for monochrome. Buttons get the
 * solid -500; the vault-icon container gets a soft -200 bg with a -700 icon. */
function applyAccentDom(accent: Accent): void {
  const { hex, foreground, softBg, strongFg } = optionFor(accent);
  const root = document.documentElement.style;
  const props: Record<string, string | null> = {
    "--primary": hex,
    "--primary-foreground": hex ? foreground : null,
    "--sidebar-primary": softBg,
    "--sidebar-primary-foreground": strongFg
  };
  for (const [key, value] of Object.entries(props)) {
    if (value) root.setProperty(key, value);
    else root.removeProperty(key);
  }
}

/** Apply without persisting — used at boot with the value read from appearance.json. */
export function hydrateAccent(accent: Accent): void {
  currentAccent = accent;
  applyAccentDom(accent);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Apply and persist to the active vault's appearance.json. */
export function setAccent(accent: Accent): void {
  hydrateAccent(accent);
  void window.api.appearance
    .set({ accent })
    .then((r) => {
      if (!r.ok) console.error("Failed to save accent:", r.error);
    })
    .catch((e) => console.error("Failed to save accent:", e));
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
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
  };
}

export function useAccent(): Accent {
  return useSyncExternalStore(subscribe, getAccent);
}
