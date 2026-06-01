import DottedMap from "dotted-map";
import { useMemo } from "react";
import { useDarkMode } from "../../hooks/use-dark-mode";

export type RegionMarker = {
  id: string;
  /** [lng, lat] — matches our manifest `center`. */
  center: [number, number];
  /** CSS color for the pin dot. */
  color: string;
};

/**
 * Frame aspect ratio — wider than the ~2:1 world map. The map fits to the frame's
 * (short) height and centers, so the leftover width becomes padding on the sides:
 * the band stays short without cropping the map or distorting its proportions.
 */
const FRAME_RATIO = 2.8;

/**
 * A static dotted world map with one pin per available region — the calmer
 * sibling of the old spinning cobe globe. The dotted base is expensive to build
 * (it rasterizes a grid against country polygons), so it's memoized per theme and
 * rendered as plain <circle>s; pins are overlaid as larger circles positioned via
 * the same map instance, so highlighting a hovered region is a cheap radius swap.
 * The list, not the map, is the authoritative selector.
 */
export function RegionMap({
  markers,
  focus
}: {
  markers: RegionMarker[];
  /** Marker id to highlight (e.g. the row the user is hovering). */
  focus?: string | null;
}) {
  const dark = useDarkMode();

  const { dots, width, height, pins } = useMemo(() => {
    // Lower dot count → dots spread further apart across the same width.
    // Equirectangular (vs the default Mercator) drops the polar vertical stretch,
    // and the lat crop trims empty polar rows — together they keep the map short
    // and wide while still covering everywhere a region pack could live.
    const map = new DottedMap({
      height: 36,
      grid: "diagonal",
      projection: { name: "miller" }
      // projection: { name: "equirectangular" }
      // region: { lat: { min: -55, max: 74 }, lng: { min: -180, max: 180 } }
    });
    const { width, height } = map.image;
    const dots = map.getPoints();
    const pins = markers.flatMap((m) => {
      // center is [lng, lat]; dotted-map wants { lat, lng }.
      const p = map.getPin({ lat: m.center[1], lng: m.center[0] });
      return p ? [{ ...m, x: p.x, y: p.y }] : [];
    });
    return { dots, width, height, pins };
  }, [markers]);

  const dotColor = dark ? "#3f3f46" : "#d4d4d8";

  return (
    <div
      className="flex items-center justify-center overflow-hidden rounded-lg border bg-muted/30 p-3"
      style={{ aspectRatio: FRAME_RATIO }}
    >
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
          const active = focus === p.id;
          return (
            <circle
              key={p.id}
              cx={p.x}
              cy={p.y}
              r={active ? 1.6 : 1}
              fill={p.color}
              className="transition-all duration-200"
            />
          );
        })}
      </svg>
    </div>
  );
}
