import { describe, expect, it } from "vitest";
import {
  type LngLat,
  applyRouteDragEdit,
  insertionIndexForSegment,
  snapToPolyline,
  stopVertexIndices
} from "./route-drag";

/** A straight east-west line at the equator, one vertex per degree of longitude. */
const STRAIGHT: LngLat[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [4, 0]
];

describe("snapToPolyline", () => {
  it("projects onto the segment, not the nearest vertex", () => {
    const snapped = snapToPolyline(STRAIGHT, [1.5, 0.2]);
    expect(snapped?.point[0]).toBeCloseTo(1.5, 6);
    expect(snapped?.point[1]).toBeCloseTo(0, 6);
    expect(snapped?.segmentIndex).toBe(1);
  });

  it("clamps to an endpoint for a point past the end of the line", () => {
    const snapped = snapToPolyline(STRAIGHT, [9, 0]);
    expect(snapped?.point).toEqual([4, 0]);
  });

  it("returns null for an empty line", () => {
    expect(snapToPolyline([], [0, 0])).toBeNull();
  });
});

describe("stopVertexIndices", () => {
  it("locates each stop along the line", () => {
    const stops: LngLat[] = [
      [0, 0],
      [2, 0],
      [4, 0]
    ];
    expect(stopVertexIndices(STRAIGHT, stops)).toEqual([0, 2, 4]);
  });

  it("stays monotone when the route doubles back over itself", () => {
    // Out and back: the return leg revisits lng 1, which is nearer to vertex 1 than to
    // vertex 3 in absolute terms. A non-monotone match would send the last stop backwards.
    const outAndBack: LngLat[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 0],
      [0, 0]
    ];
    const stops: LngLat[] = [
      [0, 0],
      [2, 0],
      [1, 0]
    ];
    expect(stopVertexIndices(outAndBack, stops)).toEqual([0, 2, 3]);
  });
});

describe("insertionIndexForSegment", () => {
  const stopIndices = [0, 4, 8]; // origin, one waypoint, destination

  it("inserts before the waypoint for a drop on the first leg", () => {
    expect(insertionIndexForSegment(stopIndices, 1)).toBe(1);
  });

  it("inserts before the destination for a drop on the last leg", () => {
    expect(insertionIndexForSegment(stopIndices, 6)).toBe(2);
  });

  it("never appends after the destination", () => {
    expect(insertionIndexForSegment(stopIndices, 99)).toBe(2);
    expect(insertionIndexForSegment([0, 8], 99)).toBe(1);
  });
});

describe("applyRouteDragEdit", () => {
  const at = (point: { lat: number; lng: number }): string => `${point.lat},${point.lng}`;
  const point = { lat: 9, lng: 9 };

  it("inserts on the leg the point was dropped on", () => {
    expect(applyRouteDragEdit(["a", "b"], { kind: "insert", index: 1, point }, at)).toEqual([
      "a",
      "9,9",
      "b"
    ]);
  });

  it("moves an existing stop in place", () => {
    expect(applyRouteDragEdit(["a", "b", "c"], { kind: "move", index: 1, point }, at)).toEqual([
      "a",
      "9,9",
      "c"
    ]);
  });

  it("skips blank rows when resolving the index", () => {
    // Routed stops are [a, b, c]; a drop on the b→c leg is index 2 and must land after `b`,
    // not at raw position 2 (which is `b` itself).
    expect(
      applyRouteDragEdit(["a", null, "b", "c"], { kind: "insert", index: 2, point }, at)
    ).toEqual(["a", null, "b", "9,9", "c"]);
    expect(
      applyRouteDragEdit(["a", null, "b", "c"], { kind: "move", index: 1, point }, at)
    ).toEqual(["a", null, "9,9", "c"]);
  });

  it("leaves the list alone when the index doesn't resolve", () => {
    const stops = ["a", "b"];
    expect(applyRouteDragEdit(stops, { kind: "move", index: 5, point }, at)).toBe(stops);
  });
});
