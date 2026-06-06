import { cn } from "@mapos/ui/lib/utils";
import DottedMap from "dotted-map";
import { useMemo, useState } from "react";
import { useDarkMode } from "../../hooks/use-dark-mode";

export type RegionMarker = {
  id: string;
  /** Display name, shown in the hover tooltip. */
  name: string;
  /** [lng, lat] — matches our manifest `center`. */
  center: [number, number];
  /** CSS color for the pin dot. */
  color: string;
  /** Quiet pin — hidden until hovered or focused. Used for not-yet-downloaded regions. */
  subtle?: boolean;
};

const FRAME_RATIO = 2.8;

export function RegionMap({
  markers,
  focus,
  onSelect
}: {
  markers: RegionMarker[];
  /** Marker id to highlight (e.g. the row the user is hovering). */
  focus?: string | null;
  /** Called with the marker id when a pin is clicked. */
  onSelect?: (id: string) => void;
}) {
  const dark = useDarkMode();
  const [hovered, setHovered] = useState<string | null>(null);

  const { map, dots, width, height } = useMemo(() => {
    const map = new DottedMap({
      height: 36,
      grid: "diagonal",
      projection: { name: "miller" }
    });
    const { width, height } = map.image;
    return { map, dots: map.getPoints(), width, height };
  }, []);

  const pins = markers.flatMap((m) => {
    // center is [lng, lat]; dotted-map wants { lat, lng }.
    const p = map.getPin({ lat: m.center[1], lng: m.center[0] });
    return p ? [{ ...m, x: p.x, y: p.y }] : [];
  });

  const dotColor = dark ? "#3f3f46" : "#d4d4d8";

  // One tooltip for the whole map — positioned by the pin's viewBox coords as
  // percentages, so no per-pin DOM measurement or portal is needed. List focus
  // shows it too, mirroring the hovered row onto the map.
  const tip = pins.find((p) => p.id === (hovered ?? focus));

  // The label keeps rendering the last-shown pin after hover ends so it can fade
  // out in place instead of vanishing (opacity is driven by `tip` below). Render-
  // phase state adjustment, keyed by id so it settles in one pass.
  const [lastTip, setLastTip] = useState(tip);
  if (tip && tip.id !== lastTip?.id) setLastTip(tip);
  const shown = tip ?? lastTip;

  return (
    <div
      className="flex items-center justify-center overflow-hidden rounded-lg border bg-muted/30 p-3"
      style={{ aspectRatio: FRAME_RATIO }}
    >
      <div className="relative h-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-full w-auto overflow-visible"
          role="img"
          aria-label="World map of available offline regions"
        >
          {dots.map((d, i) => (
            // r is in grid units where dots sit 1 unit apart, so a small radius (vs
            // the docs' default 0.22) is what gives the airy, sparse look — shrinking
            // the dot relative to the fixed 1-unit gap, not changing the dot count.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional dots, stable order
            <circle key={i} cx={d.x} cy={d.y} r={0.22} fill={dotColor} />
          ))}
          {pins.map((p) => {
            const active = focus === p.id || hovered === p.id;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: pins are a pointer-only shortcut into the region list, which is itself keyboard-accessible
              <circle
                key={p.id}
                cx={p.x}
                cy={p.y}
                r={1}
                fill={p.color}
                // Transparent stroke widens the hover hit area without changing the
                // visual — strokes count for pointer-events as long as they're not "none".
                stroke="transparent"
                strokeWidth={1.5}
                onClick={onSelect ? () => onSelect(p.id) : undefined}
                onMouseEnter={() => setHovered(p.id)}
                onMouseLeave={() => setHovered(null)}
                // Subtle pins are invisible until hovered (opacity keeps them
                // hit-testable, unlike visibility) or focused from the list.
                className={cn(
                  "transition-all duration-200",
                  onSelect && "cursor-pointer",
                  p.subtle && !active && "opacity-0"
                )}
              />
            );
          })}
        </svg>
        {/* Always mounted so opacity transitions on first hover too. */}
        <div
          className={cn(
            "pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background transition-opacity duration-200",
            tip ? "opacity-100" : "opacity-0"
          )}
          style={{
            left: `${((shown?.x ?? 0) / width) * 100}%`,
            top: `${((shown?.y ?? 0) / height) * 100}%`,
            // Above the pin, except within the top edge rows where the frame's
            // overflow-hidden would clip it — only there it flips below.
            transform:
              (shown?.y ?? 0) < height * 0.2
                ? "translate(-50%, 8px)"
                : "translate(-50%, calc(-100% - 8px))"
          }}
        >
          {shown?.name}
        </div>
      </div>
    </div>
  );
}
