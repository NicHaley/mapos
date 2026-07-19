import { Checkbox } from "@mapos/ui/components/checkbox";
import { cn } from "@mapos/ui/lib/utils";
import { useId } from "react";
import type { Theme } from "../lib/theme";

// Fixed illustrative palettes — a theme preview must always read light/dark regardless of the
// app's *current* theme, so these can't be the live CSS tokens. Tuned to our zinc-based scale.
type Palette = {
  win: string;
  map: string;
  sidebar: string;
  row: string;
  rowFaint: string;
  pin: string;
  pinMuted: string;
};

const LIGHT: Palette = {
  win: "#f4f4f5",
  map: "#e4e4e7",
  sidebar: "#fafafa",
  row: "#d4d4d8",
  rowFaint: "#e4e4e7",
  pin: "#18181b",
  pinMuted: "#a1a1aa"
};

const DARK: Palette = {
  win: "#121316",
  map: "#1c1d20",
  sidebar: "#0e0f12",
  row: "#3f3f46",
  rowFaint: "#27272a",
  pin: "#fafafa",
  pinMuted: "#52525b"
};

// A miniature MapOS window: sidebar with rows on the left, map pane on the right, two pins.
function Window({ p }: { p: Palette }): React.JSX.Element {
  return (
    <g>
      <rect x="0" y="0" width="120" height="84" fill={p.win} />
      <rect x="40" y="0" width="80" height="84" fill={p.map} />
      <circle cx="74" cy="36" r="3" fill={p.pin} />
      <circle cx="94" cy="54" r="3" fill={p.pinMuted} />
      <rect x="0" y="0" width="40" height="84" fill={p.sidebar} />
      <rect x="8" y="14" width="24" height="5" rx="2.5" fill={p.row} />
      <rect x="8" y="24" width="17" height="5" rx="2.5" fill={p.rowFaint} />
      <rect x="8" y="34" width="20" height="5" rx="2.5" fill={p.rowFaint} />
      <rect x="8" y="64" width="24" height="9" rx="3" fill={p.row} />
    </g>
  );
}

/** A small light/dark/system preview of the MapOS window, for the appearance picker cards. */
export function ThemeThumbnail({ variant }: { variant: Theme }): React.JSX.Element {
  const raw = useId();
  const clipId = `tt-${raw.replace(/[:]/g, "")}`;

  return (
    <svg viewBox="0 0 120 84" className="block size-full" aria-hidden="true">
      {variant === "light" && <Window p={LIGHT} />}
      {variant === "dark" && <Window p={DARK} />}
      {variant === "system" && (
        <>
          <Window p={LIGHT} />
          <clipPath id={clipId}>
            {/* Lower-left triangle below the diagonal gets the dark variant. */}
            <path d="M0 0 L0 84 L120 84 Z" />
          </clipPath>
          <g clipPath={`url(#${clipId})`}>
            <Window p={DARK} />
          </g>
          <line x1="0" y1="0" x2="120" y2="84" stroke="#000" strokeOpacity="0.25" strokeWidth="1" />
        </>
      )}
    </svg>
  );
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

/**
 * A 3-card theme picker (Light / Dark / System) with miniature window previews. Controlled —
 * the caller owns the value and applies it. Shared by onboarding's Appearance step and the
 * Settings → Appearance page so the two stay identical.
 */
export function ThemePicker({
  value,
  onChange
}: {
  value: Theme;
  onChange: (next: Theme) => void;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-3">
      {THEME_OPTIONS.map(({ value: option, label }) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className="group flex cursor-pointer flex-col gap-2 text-center"
          >
            <span
              className={cn(
                "block aspect-[120/84] overflow-hidden rounded-lg border-2 transition-colors",
                selected
                  ? "border-foreground ring-[3px] ring-foreground/15"
                  : "border-border group-hover:border-foreground/40"
              )}
            >
              <ThemeThumbnail variant={option} />
            </span>
            <span className="flex items-center justify-center gap-2 text-sm font-medium">
              <Checkbox
                checked={selected}
                readOnly
                tabIndex={-1}
                aria-hidden
                className="pointer-events-none rounded-full"
              />
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
