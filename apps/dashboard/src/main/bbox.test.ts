import { describe, expect, it } from "vitest";
import { computeBbox } from "./bbox";

// LatLng in, [west, south, east, north] out. The lng/lat ordering flip between
// the two is the bug worth guarding: it produces a bbox that looks plausible and
// pans the map to the wrong hemisphere.

describe("computeBbox", () => {
  it("returns null for an empty list", () => {
    expect(computeBbox([])).toBeNull();
  });

  it("returns a degenerate box for a single point", () => {
    expect(computeBbox([{ lat: 35.68, lng: 139.7 }])).toEqual({
      west: 139.7,
      south: 35.68,
      east: 139.7,
      north: 35.68
    });
  });

  it("does not confuse lat and lng", () => {
    // Deliberately asymmetric ranges: lat spans 10..20, lng spans 100..130, so a
    // swap cannot coincidentally produce the same numbers.
    const box = computeBbox([
      { lat: 10, lng: 100 },
      { lat: 20, lng: 130 }
    ]);
    expect(box).toEqual({ west: 100, south: 10, east: 130, north: 20 });
  });

  it("spans the extremes of an unordered list", () => {
    const box = computeBbox([
      { lat: 45.5, lng: -73.6 },
      { lat: 35.7, lng: 139.7 },
      { lat: 51.5, lng: -0.1 }
    ]);
    expect(box).toEqual({ west: -73.6, south: 35.7, east: 139.7, north: 51.5 });
  });

  it("handles points across the equator and prime meridian", () => {
    const box = computeBbox([
      { lat: -34.6, lng: -58.4 },
      { lat: 12.3, lng: 4.5 }
    ]);
    expect(box).toEqual({ west: -58.4, south: -34.6, east: 4.5, north: 12.3 });
  });
});
