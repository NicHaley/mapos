import { buffer } from "@turf/buffer";
import { point } from "@turf/helpers";
import type React from "react";
import { useMemo } from "react";
import { Layer, Marker, Source } from "react-map-gl/maplibre";

export type UserLocation = { lng: number; lat: number; accuracy: number };

/**
 * The "you are here" dot plus a translucent accuracy ring. Rendered as a child
 * of <MapGL> (the buttons that drive it live in the top bar). The ring is a real
 * GeoJSON circle in meters, so it scales with zoom and tells the truth about how
 * coarse desktop (wifi) positioning is.
 */
export function UserLocationLayer({ location }: { location: UserLocation }): React.JSX.Element {
  const accuracyCircle = useMemo(
    () =>
      location.accuracy > 0
        ? buffer(point([location.lng, location.lat]), location.accuracy / 1000, { steps: 64 })
        : null,
    [location]
  );

  return (
    <>
      {accuracyCircle && (
        <Source id="user-location-accuracy" type="geojson" data={accuracyCircle}>
          <Layer
            id="user-location-accuracy-fill"
            type="fill"
            paint={{ "fill-color": "#0ea5e9", "fill-opacity": 0.12 }}
          />
          <Layer
            id="user-location-accuracy-line"
            type="line"
            paint={{ "line-color": "#0ea5e9", "line-width": 1, "line-opacity": 0.35 }}
          />
        </Source>
      )}
      <Marker longitude={location.lng} latitude={location.lat}>
        <div className="size-3.5 rounded-full border-2 border-white bg-sky-500 shadow-md" />
      </Marker>
    </>
  );
}
