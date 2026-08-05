/**
 * Reading a route's elevation series into figures a person can act on.
 *
 * Valhalla hands back a bare array of metres sampled at a fixed interval. Two things make
 * that unsafe to display as-is — a no-data floor that looks like real terrain, and sampling
 * noise that inflates total climb — and both are handled here so every consumer (the
 * directions panel, the MCP tools) gets the same numbers.
 */

/**
 * Valhalla clamps unknown elevation to `kMinElevation` (-500 m) rather than omitting it, so a
 * pack built before elevation was baked into the graph answers a route request with a full
 * series pinned just above that floor instead of with nothing at all. Presence of the array
 * therefore proves nothing; the values have to be screened.
 *
 * The ceiling sits well above the floor but below the lowest exposed land on earth (the Dead
 * Sea shore, about -430 m), so no real route is mistaken for missing data.
 */
const NO_DATA_CEILING_M = -450;

/**
 * Smallest climb, in metres, that counts as a change of direction.
 *
 * Summing every rise between adjacent samples also sums the DEM's noise, and because the
 * error accumulates in one direction the total drifts upward the longer the route — which is
 * why a naive profile reports far more climb than a GPS watch. Committing only once a run
 * exceeds this threshold discards the oscillation while keeping genuine short climbs.
 */
const HYSTERESIS_M = 3;

/** Whether a series carries real terrain rather than Valhalla's no-data floor. */
export function hasElevationData(samples: readonly number[] | undefined): boolean {
  return samples?.some((v) => v > NO_DATA_CEILING_M) ?? false;
}

export type ElevationStats = {
  /** Total climb, noise-filtered. */
  gainMeters: number;
  /** Total descent, as a positive number. */
  lossMeters: number;
  minMeters: number;
  maxMeters: number;
};

/**
 * Cumulative gain/loss and range for a sampled series, or `null` when it holds no real data.
 *
 * A no-data run breaks the series rather than ending it: the reference resets, so the step
 * back onto real terrain on the far side of a gap is not counted as a cliff.
 */
export function elevationStats(samples: readonly number[]): ElevationStats | null {
  let gain = 0;
  let loss = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  // Last committed elevation, or null while inside a no-data run.
  let ref: number | null = null;
  let seen = false;

  for (const v of samples) {
    if (v <= NO_DATA_CEILING_M) {
      ref = null;
      continue;
    }
    seen = true;
    if (v < min) min = v;
    if (v > max) max = v;
    if (ref === null) {
      ref = v;
      continue;
    }
    const delta = v - ref;
    if (delta >= HYSTERESIS_M) {
      gain += delta;
      ref = v;
    } else if (delta <= -HYSTERESIS_M) {
      loss -= delta;
      ref = v;
    }
  }

  if (!seen) return null;
  return {
    gainMeters: Math.round(gain),
    lossMeters: Math.round(loss),
    minMeters: Math.round(min),
    maxMeters: Math.round(max)
  };
}

/**
 * Distance along the route of sample `index`, in metres.
 *
 * Samples are evenly spaced from the start, so this is the x-axis of the profile and what a
 * hover on the chart maps back to.
 */
export function sampleDistanceMeters(index: number, intervalMeters: number): number {
  return index * intervalMeters;
}
