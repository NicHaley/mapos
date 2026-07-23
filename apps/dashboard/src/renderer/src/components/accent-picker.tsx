import { cn } from "@mapos/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import { ACCENT_PALETTE, type Accent } from "../lib/accent";

/**
 * A row of circular colour swatches (macOS "Accent colour" style). Controlled — the
 * caller owns the value and applies it. Monochrome is shown as an adaptive graphite dot
 * (it follows the light/dark theme); every other swatch is a fixed hue. The selected
 * swatch gets a ring in its own colour and a check mark; its label shows beneath the row.
 */
export function AccentPicker({
  value,
  onChange
}: {
  value: Accent;
  onChange: (next: Accent) => void;
}): React.JSX.Element {
  const selectedLabel = ACCENT_PALETTE.find((o) => o.id === value)?.label ?? "Monochrome";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        {ACCENT_PALETTE.map(({ id, label, hex, foreground }) => {
          const selected = value === id;
          // Monochrome is a fixed half-white / half-black split; every other option is a solid hue.
          const background = hex ?? "linear-gradient(135deg, #ffffff 0 50%, #000000 50% 100%)";
          const ringColor = hex ?? "var(--foreground)";
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              title={label}
              aria-label={label}
              aria-pressed={selected}
              className="flex size-6 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-110 focus-visible:outline-none"
              style={{
                background,
                boxShadow: selected
                  ? `0 0 0 2px var(--background), 0 0 0 4px ${ringColor}`
                  : undefined
              }}
            >
              {selected && hex && (
                <CheckIcon className="size-3" strokeWidth={3} style={{ color: foreground }} />
              )}
            </button>
          );
        })}
      </div>
      <span className={cn("text-sm text-muted-foreground")}>{selectedLabel}</span>
    </div>
  );
}
