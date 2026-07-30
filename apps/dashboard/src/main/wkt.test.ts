import { describe, expect, it } from "vitest";
import { geometryToWkt, parseWkt } from "./wkt";

// Geometry is stored as WKT in place-file frontmatter and converted to GeoJSON
// for queries and rendering, so a round-trip that silently drops precision or
// swaps lng/lat would move places on the map.

describe("parseWkt", () => {
  it("parses a point as [lng, lat]", () => {
    expect(parseWkt("POINT(139.7 35.68)")).toEqual({
      type: "Point",
      coordinates: [139.7, 35.68]
    });
  });

  it("parses a linestring", () => {
    expect(parseWkt("LINESTRING(0 0, 1 1, 2 3)")).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 3]
      ]
    });
  });

  it("parses a polygon", () => {
    expect(parseWkt("POLYGON((0 0, 1 0, 1 1, 0 0))")).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0]
        ]
      ]
    });
  });

  it("preserves negative and fractional coordinates", () => {
    expect(parseWkt("POINT(-73.5673 45.5017)")).toEqual({
      type: "Point",
      coordinates: [-73.5673, 45.5017]
    });
  });

  it("rejects geometry types the renderer does not support", () => {
    expect(parseWkt("MULTIPOINT(0 0, 1 1)")).toBeNull();
    expect(parseWkt("GEOMETRYCOLLECTION(POINT(0 0))")).toBeNull();
  });

  it("rejects unparseable, empty, and non-string input", () => {
    expect(parseWkt("not wkt at all")).toBeNull();
    expect(parseWkt("")).toBeNull();
    expect(parseWkt("   ")).toBeNull();
    expect(parseWkt(null)).toBeNull();
    expect(parseWkt(42)).toBeNull();
    expect(parseWkt({ type: "Point" })).toBeNull();
  });
});

describe("geometryToWkt", () => {
  it("serializes the three supported geometry types", () => {
    expect(geometryToWkt({ type: "Point", coordinates: [139.7, 35.68] })).toBe(
      "POINT(139.7 35.68)"
    );
    expect(
      geometryToWkt({
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1]
        ]
      })
    ).toBe("LINESTRING(0 0, 1 1)");
    expect(
      geometryToWkt({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0]
          ]
        ]
      })
    ).toBe("POLYGON((0 0, 1 0, 1 1, 0 0))");
  });

  it("returns null rather than writing a geometry the map cannot render", () => {
    expect(geometryToWkt({ type: "MultiPolygon", coordinates: [] })).toBeNull();
    expect(geometryToWkt(null)).toBeNull();
    expect(geometryToWkt(undefined)).toBeNull();
    expect(geometryToWkt("POINT(0 0)")).toBeNull();
    expect(geometryToWkt({})).toBeNull();
  });
});

describe("round-trip", () => {
  const cases = [
    "POINT(139.7 35.68)",
    "POINT(-73.5673 45.5017)",
    "LINESTRING(0 0, 1 1, 2 3)",
    "POLYGON((0 0, 1 0, 1 1, 0 0))"
  ];

  for (const wkt of cases) {
    it(`survives WKT -> GeoJSON -> WKT: ${wkt}`, () => {
      const parsed = parseWkt(wkt);
      expect(parsed).not.toBeNull();
      expect(geometryToWkt(parsed)).toBe(wkt);
    });
  }
});
