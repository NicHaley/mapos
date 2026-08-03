import { describe, expect, it } from "vitest";
import { elevationStats, hasElevationData, sampleDistanceMeters } from "./elevation";

/** What a pack built without baked elevation actually returns: the clamp floor, not nothing. */
const NO_DATA = [-500, -499.9, -500, -499.95, -500];

describe("hasElevationData", () => {
  it("rejects the no-data floor a pre-elevation pack returns", () => {
    expect(hasElevationData(NO_DATA)).toBe(false);
  });

  it("rejects an absent series", () => {
    expect(hasElevationData(undefined)).toBe(false);
    expect(hasElevationData([])).toBe(false);
  });

  it("accepts real terrain", () => {
    expect(hasElevationData([9.7, 40.2, 80.4])).toBe(true);
  });

  it("accepts genuine below-sea-level terrain", () => {
    // The Dead Sea shore is about -430 m, the lowest exposed land there is; it must not read
    // as missing data.
    expect(hasElevationData([-430, -428, -431])).toBe(true);
  });
});

describe("elevationStats", () => {
  it("returns null for a series holding only the no-data floor", () => {
    expect(elevationStats(NO_DATA)).toBeNull();
  });

  it("sums a monotonic climb", () => {
    expect(elevationStats([10, 20, 30, 40])).toEqual({
      gainMeters: 30,
      lossMeters: 0,
      minMeters: 10,
      maxMeters: 40
    });
  });

  it("separates gain from loss over a hill", () => {
    const stats = elevationStats([100, 150, 200, 150, 120]);
    expect(stats).toEqual({
      gainMeters: 100,
      lossMeters: 80,
      minMeters: 100,
      maxMeters: 200
    });
  });

  it("discards sub-threshold oscillation instead of accumulating it", () => {
    // A flat towpath sampled over noisy 30 m DEM postings. Summing raw deltas would report
    // ~8 m of climb over ground that never rises.
    const noisy = [50, 51, 50, 51.5, 50.2, 51, 50.5, 51.2, 50];
    const stats = elevationStats(noisy);
    expect(stats?.gainMeters).toBe(0);
    expect(stats?.lossMeters).toBe(0);
  });

  it("keeps a genuine climb that a plain average would smooth away", () => {
    expect(elevationStats([10, 11, 25, 26, 40])?.gainMeters).toBe(30);
  });

  it("breaks the series across a no-data gap rather than counting a cliff", () => {
    // Real terrain at 20 m, a hole in the DEM, then real terrain at 900 m. The step across
    // the gap is an artefact of the hole and must not be counted as 880 m of climb.
    const stats = elevationStats([20, 22, -500, -500, 900, 902]);
    expect(stats?.gainMeters).toBe(0);
    expect(stats?.minMeters).toBe(20);
    expect(stats?.maxMeters).toBe(902);
  });

  it("handles a single valid sample", () => {
    expect(elevationStats([42])).toEqual({
      gainMeters: 0,
      lossMeters: 0,
      minMeters: 42,
      maxMeters: 42
    });
  });

  it("returns null for an empty series", () => {
    expect(elevationStats([])).toBeNull();
  });
});

describe("sampleDistanceMeters", () => {
  it("spaces samples evenly from the start", () => {
    expect(sampleDistanceMeters(0, 30)).toBe(0);
    expect(sampleDistanceMeters(104, 30)).toBe(3120);
  });
});
