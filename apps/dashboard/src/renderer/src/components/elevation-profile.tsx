import { cn } from "@mapos/ui/lib/utils";
import { formatDistance } from "@renderer/lib/format";
import { sampleDistanceMeters } from "@shared/elevation";
import type React from "react";
import { useMemo, useState } from "react";

/**
 * Elevation against distance for a computed route.
 *
 * Drawn in a unit-height viewBox and stretched to the panel width with
 * `preserveAspectRatio="none"`, which keeps it responsive without measuring the DOM. The
 * distortion that implies is why the line carries `vector-effect="non-scaling-stroke"` and why
 * the hover readout is HTML positioned over the chart rather than SVG text — anything with
 * intrinsic proportions would come out stretched.
 */

/** Matches `NO_DATA_CEILING_M` in `@shared/elevation`: samples at or below this are holes. */
const NO_DATA_CEILING_M = -450;

/** Vertical breathing room, as a fraction of the elevation range, so the line never sits flush
 *  against the top or bottom edge. */
const Y_PAD = 0.12;

/** Cap on plotted points. A long route sampled every 30 m runs to thousands, far more than
 *  there are pixels; striding keeps the path cheap. Hover still reads the full series, so the
 *  readout stays exact even where the drawn line is decimated. */
const MAX_PLOT_POINTS = 1200;

type Props = {
  samples: number[];
  intervalMeters: number;
  className?: string;
};

/**
 * Split into runs of real terrain, dropping no-data holes. Returned indices are into the
 * original series so the x-axis still reflects true distance across a gap, and the line breaks
 * over the hole rather than plunging to the floor.
 */
function realRuns(samples: number[]): { index: number; value: number }[][] {
  const runs: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  for (const [index, value] of samples.entries()) {
    if (value <= NO_DATA_CEILING_M) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push({ index, value });
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

export function ElevationProfile({
  samples,
  intervalMeters,
  className
}: Props): React.JSX.Element | null {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const plot = useMemo(() => {
    const runs = realRuns(samples);
    if (runs.length === 0) return null;

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const run of runs) {
      for (const { value } of run) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    // A dead-flat route has no range to scale against; centring it beats dividing by zero.
    const span = max - min;
    const pad = span === 0 ? 1 : span * Y_PAD;
    const lo = min - pad;
    const hi = max + pad;

    const lastIndex = Math.max(1, samples.length - 1);
    const x = (index: number): number => index / lastIndex;
    const y = (value: number): number => 1 - (value - lo) / (hi - lo);
    const stride = Math.max(1, Math.ceil(samples.length / MAX_PLOT_POINTS));

    const lines: string[] = [];
    const areas: string[] = [];
    for (const run of runs) {
      const pts = run.filter((_, i) => i % stride === 0 || i === run.length - 1);
      if (pts.length < 2) continue;
      const d = pts
        .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.index).toFixed(5)},${y(p.value).toFixed(5)}`)
        .join(" ");
      lines.push(d);
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first && last) {
        areas.push(`${d} L${x(last.index).toFixed(5)},1 L${x(first.index).toFixed(5)},1 Z`);
      }
    }
    return { lines, areas, min, max, x };
  }, [samples]);

  if (!plot) return null;

  const hovered = hoverIndex === null ? null : samples[hoverIndex];
  const hoveredValid = hovered !== undefined && hovered !== null && hovered > NO_DATA_CEILING_M;
  const hoverFraction = hoverIndex === null ? 0 : plot.x(hoverIndex);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div
        className="relative h-16 w-full cursor-crosshair text-primary"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect.width === 0) return;
          const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          setHoverIndex(Math.round(fraction * (samples.length - 1)));
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <svg
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="h-full w-full overflow-visible"
          role="img"
        >
          <title>
            Elevation profile: {Math.round(plot.min)} m to {Math.round(plot.max)} m
          </title>
          {plot.areas.map((d) => (
            <path key={d} d={d} fill="currentColor" className="opacity-15" />
          ))}
          {plot.lines.map((d) => (
            <path
              key={d}
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hoverIndex !== null && (
            <line
              x1={hoverFraction}
              x2={hoverFraction}
              y1={0}
              y2={1}
              stroke="currentColor"
              strokeWidth={1}
              className="opacity-40"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {hoverIndex !== null && hoveredValid && (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-popover-foreground text-xs tabular-nums shadow-sm"
            // Clamped so the readout stays inside the panel at either end of the route.
            style={{ left: `${Math.min(88, Math.max(12, hoverFraction * 100))}%` }}
          >
            {formatDistance(sampleDistanceMeters(hoverIndex, intervalMeters))} ·{" "}
            {Math.round(hovered)} m
          </div>
        )}
      </div>
      <div className="flex justify-between px-0.5 text-[10px] text-muted-foreground tabular-nums">
        <span>{Math.round(plot.min)} m</span>
        <span>{Math.round(plot.max)} m</span>
      </div>
    </div>
  );
}
