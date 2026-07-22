import { Checkbox } from "@mapos/ui/components/checkbox";
import { cn } from "@mapos/ui/lib/utils";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import type { MapColor } from "../lib/map-color";

type Palette = { land: string; road: string; water: string; park: string; border: string };

function palette(mono: boolean, isDark: boolean): Palette {
  if (mono) {
    return isDark
      ? { land: "#0c0c0e", road: "#3c3c42", water: "#191920", park: "#232329", border: "#2c2c33" }
      : { land: "#ffffff", road: "#d9d9df", water: "#e8e8ec", park: "#ededf1", border: "#dcdce2" };
  }
  return isDark
    ? { land: "#161a20", road: "#3a414b", water: "#123047", park: "#183a24", border: "#1f4a2c" }
    : { land: "#e9e6df", road: "#ffffff", water: "#a7d4ec", park: "#c6e4c1", border: "#aed4a6" };
}

// Vertical/horizontal street grid; a couple of avenues are drawn heavier.
const V_STREETS = [16, 34, 52, 70, 88, 106];
const H_STREETS = [14, 30, 46, 62, 78];
const V_AVENUES = new Set([52, 88]);
const H_AVENUES = new Set([46]);

/** A miniature but plausible city: a perpendicular street grid with two heavier
 * avenues, a rectangular park, and a river bending down the right side. */
function CityThumbnail({ color, isDark }: { color: MapColor; isDark: boolean }): React.JSX.Element {
  const p = palette(color === "monochrome", isDark);
  return (
    <svg viewBox="0 0 120 84" className="block size-full" aria-hidden="true">
      <rect x="0" y="0" width="120" height="84" fill={p.land} />
      {/* Street grid (drawn first; the park and river cover it where they sit). */}
      <g stroke={p.road} strokeLinecap="square">
        {V_STREETS.map((x) => (
          <line
            key={`v${x}`}
            x1={x}
            y1="0"
            x2={x}
            y2="84"
            strokeWidth={V_AVENUES.has(x) ? 2.6 : 1.4}
          />
        ))}
        {H_STREETS.map((y) => (
          <line
            key={`h${y}`}
            x1="0"
            y1={y}
            x2="120"
            y2={y}
            strokeWidth={H_AVENUES.has(y) ? 2.6 : 1.4}
          />
        ))}
      </g>
      {/* River down the right edge with a gentle bend. */}
      <polygon points="98,0 106,42 95,84 120,84 120,0" fill={p.water} />
      {/* A city park spanning a couple of blocks. */}
      <rect x="20" y="16" width="24" height="22" fill={p.park} stroke={p.border} strokeWidth="1" />
    </svg>
  );
}

const MAP_COLOR_OPTIONS: { value: MapColor; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "monochrome", label: "Monochrome" }
];

/** Two-card picker (Full / Monochrome) with miniature basemap previews that follow
 * the current theme. Mirrors ThemePicker's card size (3-col grid) so the Appearance
 * page reads as one consistent set of controls. */
export function MapColorPicker({
  value,
  onChange
}: {
  value: MapColor;
  onChange: (next: MapColor) => void;
}): React.JSX.Element {
  const isDark = useDarkMode();
  return (
    <div className="grid grid-cols-3 gap-3">
      {MAP_COLOR_OPTIONS.map(({ value: option, label }, i) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              "group flex cursor-pointer flex-col gap-2 text-center",
              // Two options in a 3-col grid (kept 3-wide to match ThemePicker's card size):
              // push the first into column 2 so the pair right-aligns instead of leaving a gap.
              i === 0 && "col-start-2"
            )}
          >
            <span
              className={cn(
                "block aspect-[120/84] overflow-hidden rounded-lg border-2 transition-colors",
                selected
                  ? "border-foreground ring-[3px] ring-foreground/15"
                  : "border-border group-hover:border-foreground/40"
              )}
            >
              <CityThumbnail color={option} isDark={isDark} />
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
