import { describe, expect, it } from "vitest";
import type { PlaceRecord } from "../../../shared/types";
import { waypointFromPlace } from "./place-waypoint";

function place(over: Partial<PlaceRecord>): PlaceRecord {
  return { filePath: "/vault/a.md", title: "A", type: "place", ...over };
}

const LINE = JSON.stringify({
  type: "LineString",
  coordinates: [
    [-73.1, 45.1],
    [-73.2, 45.2],
    [-73.3, 45.3]
  ]
});

describe("waypointFromPlace", () => {
  it("uses a point's own coordinate", () => {
    const wp = waypointFromPlace(
      place({ geometry: JSON.stringify({ type: "Point", coordinates: [-73.5, 45.5] }) })
    );
    expect(wp).toMatchObject({ lat: 45.5, lng: -73.5, label: "A" });
  });

  it("returns null without geometry", () => {
    expect(waypointFromPlace(place({}))).toBeNull();
  });

  it("returns null for a saved route: a trip is not a destination", () => {
    const route = place({
      geometry: LINE,
      route: {
        mode: "pedestrian",
        stops: [
          { label: "Home", lat: 45.1, lng: -73.1 },
          { label: "Work", lat: 45.3, lng: -73.3 }
        ]
      }
    });
    expect(waypointFromPlace(route)).toBeNull();
  });

  it("still routes to a drawn line, which is a shape rather than a trip", () => {
    // Guards the distinction the route check rests on: `route` frontmatter, not
    // LineString geometry, is what makes a place un-routable-to.
    expect(waypointFromPlace(place({ geometry: LINE }))).toMatchObject({ lat: 45.2, lng: -73.2 });
  });

  it("carries filePath for real vault files but not synthetic previews", () => {
    const geometry = JSON.stringify({ type: "Point", coordinates: [-73.5, 45.5] });
    expect(waypointFromPlace(place({ geometry }))?.filePath).toBe("/vault/a.md");
    expect(
      waypointFromPlace(place({ geometry, filePath: "geocode-search:abc" }))?.filePath
    ).toBeUndefined();
  });
});
