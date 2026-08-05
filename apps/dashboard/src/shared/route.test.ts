import { describe, expect, it } from "vitest";
import {
  type RouteStop,
  defaultRouteTitle,
  parseRouteFrontmatter,
  routeIsDirty,
  routeKey
} from "./route";

const HOME: RouteStop = { label: "Home", lat: 45.5017, lng: -73.5673 };
const WORK: RouteStop = { label: "Work", lat: 45.4956, lng: -73.5712 };

describe("parseRouteFrontmatter", () => {
  it("reads a well-formed route", () => {
    expect(
      parseRouteFrontmatter({
        mode: "bicycle",
        stops: [
          { label: "Home", lat: 45.5017, lng: -73.5673 },
          { label: "Work", lat: 45.4956, lng: -73.5712 }
        ]
      })
    ).toEqual({ mode: "bicycle", stops: [HOME, WORK] });
  });

  it("coerces quoted coordinates", () => {
    const parsed = parseRouteFrontmatter({
      mode: "auto",
      stops: [
        { label: "Home", lat: "45.5017", lng: "-73.5673" },
        { label: "Work", lat: "45.4956", lng: "-73.5712" }
      ]
    });
    expect(parsed?.stops).toEqual([HOME, WORK]);
  });

  it("defaults an unknown or missing mode to auto", () => {
    expect(parseRouteFrontmatter({ mode: "teleport", stops: [HOME, WORK] })?.mode).toBe("auto");
    expect(parseRouteFrontmatter({ stops: [HOME, WORK] })?.mode).toBe("auto");
  });

  it("names an unlabelled stop by position", () => {
    const parsed = parseRouteFrontmatter({
      stops: [
        { lat: 45.5017, lng: -73.5673 },
        { label: "   ", lat: 45.4956, lng: -73.5712 }
      ]
    });
    expect(parsed?.stops.map((s) => s.label)).toEqual(["Stop 1", "Stop 2"]);
  });

  it("keeps a stop's wikilink", () => {
    const parsed = parseRouteFrontmatter({
      stops: [{ ...HOME, file: "[[Home]]" }, WORK]
    });
    expect(parsed?.stops[0].file).toBe("[[Home]]");
    expect(parsed?.stops[1].file).toBeUndefined();
  });

  it("drops a blank or non-string wikilink rather than failing the route", () => {
    const parsed = parseRouteFrontmatter({
      stops: [
        { ...HOME, file: "  " },
        { ...WORK, file: 42 }
      ]
    });
    expect(parsed?.stops.map((s) => s.file)).toEqual([undefined, undefined]);
  });

  it("accepts a stop list right up to the cap", () => {
    const stops = Array.from({ length: 25 }, (_, i) => ({ label: `S${i}`, lat: 45, lng: -73 }));
    expect(parseRouteFrontmatter({ stops })?.stops).toHaveLength(25);
  });

  // Clipping to the first 25 would reopen the panel with a shorter trip than the file holds,
  // and a save from there would overwrite the original with it.
  it("rejects a pathologically long stop list rather than clipping it", () => {
    const stops = Array.from({ length: 40 }, (_, i) => ({ label: `S${i}`, lat: 45, lng: -73 }));
    expect(parseRouteFrontmatter({ stops })).toBeNull();
  });

  // A malformed route must cost the route, never the file: parseRouteFrontmatter runs
  // inside parsePlaceFile's try/catch, where a throw drops the place from the index.
  it.each([
    ["not an object", "LINESTRING(0 0, 1 1)"],
    ["an array", [HOME, WORK]],
    ["null", null],
    ["undefined", undefined],
    ["missing stops", { mode: "auto" }],
    ["stops not an array", { stops: "Home, Work" }],
    ["a single stop", { stops: [HOME] }],
    ["an empty stop list", { stops: [] }],
    ["a non-object stop", { stops: ["Home", "Work"] }],
    ["an unparseable coordinate", { stops: [{ label: "Home", lat: "north", lng: -73 }, WORK] }],
    ["an out-of-range latitude", { stops: [{ label: "Home", lat: 91, lng: -73 }, WORK] }],
    ["an out-of-range longitude", { stops: [{ label: "Home", lat: 45, lng: 181 }, WORK] }],
    ["a missing coordinate", { stops: [{ label: "Home" }, WORK] }]
  ])("returns null for %s", (_name, value) => {
    expect(parseRouteFrontmatter(value)).toBeNull();
  });
});

describe("routeKey", () => {
  it("ignores float noise below ~10cm", () => {
    expect(routeKey([HOME, WORK], "auto")).toBe(
      routeKey([{ ...HOME, lat: 45.50170000001 }, WORK], "auto")
    );
  });

  it("separates mode, order, and position", () => {
    expect(routeKey([HOME, WORK], "auto")).not.toBe(routeKey([HOME, WORK], "bicycle"));
    expect(routeKey([HOME, WORK], "auto")).not.toBe(routeKey([WORK, HOME], "auto"));
    expect(routeKey([HOME, WORK], "auto")).not.toBe(
      routeKey([{ ...HOME, lat: 45.51 }, WORK], "auto")
    );
  });

  // A link is identity, not geometry — gaining or losing one must not make a route
  // whose trip hasn't changed read as "unsaved".
  it("ignores wikilinks", () => {
    expect(routeKey([{ ...HOME, file: "[[Home]]" }, WORK], "auto")).toBe(
      routeKey([HOME, WORK], "auto")
    );
  });

  it("ignores labels, which are cosmetic", () => {
    expect(routeKey([{ ...HOME, label: "Casa" }, WORK], "auto")).toBe(
      routeKey([HOME, WORK], "auto")
    );
  });
});

describe("routeIsDirty", () => {
  it("treats an unsaved route as dirty", () => {
    expect(routeIsDirty(null, [HOME, WORK], "auto")).toBe(true);
  });

  it("is clean against an identical saved route", () => {
    expect(routeIsDirty({ mode: "auto", stops: [HOME, WORK] }, [HOME, WORK], "auto")).toBe(false);
  });

  it("is dirty when the mode or a stop changed", () => {
    const saved = { mode: "auto" as const, stops: [HOME, WORK] };
    expect(routeIsDirty(saved, [HOME, WORK], "bicycle")).toBe(true);
    expect(routeIsDirty(saved, [HOME, WORK, HOME], "auto")).toBe(true);
  });
});

describe("defaultRouteTitle", () => {
  it("joins the endpoints", () => {
    expect(defaultRouteTitle([HOME, WORK])).toBe("Home to Work");
  });

  it("names the endpoints, not the stops between them", () => {
    expect(defaultRouteTitle([HOME, { ...WORK, label: "Midpoint" }, WORK])).toBe("Home to Work");
  });

  it("clips labels so two of them can't exceed the filename limit", () => {
    const long = "1250 Boulevard René-Lévesque Ouest, Ville-Marie, Montréal, QC H3B 4W8";
    const title = defaultRouteTitle([
      { ...HOME, label: long },
      { ...WORK, label: long }
    ]);
    expect(title.length).toBeLessThan(100);
    expect(title).toContain(" to ");
  });

  it("falls back when a label is missing", () => {
    expect(defaultRouteTitle([])).toBe("Route");
  });
});
