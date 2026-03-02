import { useCallback, useEffect, useMemo, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import MapGL, { Layer, Marker, Source } from "react-map-gl/maplibre";

type PlaceRecord = {
  id: string;
  lat: number;
  lng: number;
  title: string;
  status: string;
  type: string;
  category?: string;
  tags?: string[];
  filePath: string;
};

type PlaceUpdate =
  | { event: "add" | "change"; place: PlaceRecord }
  | { event: "unlink"; filePath: string };

const STATUS_COLORS: Record<string, string> = {
  "want-to-go": "#3b82f6",
  visited: "#22c55e",
  maybe: "#f59e0b"
};

type OverlayPoint = {
  id: string;
  lat: number;
  lng: number;
  title: string;
};

type OverlayLine = {
  id: string;
  coordinates: [number, number][];
  title?: string;
};

type OverlayPolygon = {
  id: string;
  coordinates: [number, number][][];
  title?: string;
};

type OverlayData = {
  points: OverlayPoint[];
  lines: OverlayLine[];
  polygons: OverlayPolygon[];
};

const EMPTY_OVERLAY: OverlayData = { points: [], lines: [], polygons: [] };

const POLYGON_FILTER = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]];
const LINESTRING_FILTER = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString"]]];

export default function MapView(): React.JSX.Element {
  const [places, setPlaces] = useState<Map<string, PlaceRecord>>(new Map());
  const [overlay, setOverlay] = useState<OverlayData>(EMPTY_OVERLAY);

  const applyUpdate = useCallback((update: PlaceUpdate) => {
    setPlaces((prev) => {
      const next = new Map(prev);
      if (update.event === "unlink") next.delete(update.filePath);
      else next.set(update.place.filePath, update.place);
      return next;
    });
  }, []);

  useEffect(() => {
    window.api.places.onInitial((initialPlaces) => {
      console.log("[places:initial]", initialPlaces);
      const m = new Map<string, PlaceRecord>();
      for (const p of initialPlaces) {
        m.set(p.filePath, p);
      }
      setPlaces(m);
    });
    window.api.places.onUpdated((u) => {
      console.log("[places:updated]", u);
      applyUpdate(u as PlaceUpdate);
    });
    window.api.map.onOverlay(({ points = [], lines = [], polygons = [] }) =>
      setOverlay({ points, lines, polygons })
    );
    window.api.map.onOverlayClear(() => setOverlay(EMPTY_OVERLAY));
    console.log("[MapView] requesting initial places");
    window.api.places.requestInitial();
    return () => {
      window.api.places.removeListeners();
      window.api.map.removeListeners();
    };
  }, [applyUpdate]);

  const overlayGeoJSON = useMemo(() => {
    const features: Array<{
      type: "Feature";
      geometry: { type: "LineString"; coordinates: [number, number][] } | { type: "Polygon"; coordinates: [number, number][][] };
      properties?: Record<string, unknown>;
    }> = [];
    for (const l of overlay.lines) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: l.coordinates },
        properties: { id: l.id, title: l.title } as Record<string, unknown>
      });
    }
    for (const p of overlay.polygons) {
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: p.coordinates },
        properties: { id: p.id, title: p.title } as Record<string, unknown>
      });
    }
    if (features.length === 0) return null;
    return { type: "FeatureCollection" as const, features };
  }, [overlay.lines, overlay.polygons]);

  const hasOverlayGeoJSON = overlayGeoJSON && overlayGeoJSON.features.length > 0;

  return (
    <MapGL
      initialViewState={{ longitude: 0, latitude: 20, zoom: 2 }}
      style={{ width: "100%", height: "100%" }}
      mapStyle="https://tiles.openfreemap.org/styles/liberty"
    >
      {Array.from(places.values()).map((place) => (
        <Marker key={place.filePath} longitude={place.lng} latitude={place.lat} anchor="center">
          <div
            title={place.title}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              backgroundColor: STATUS_COLORS[place.status] ?? "#6b7280",
              border: "2px solid white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              cursor: "pointer"
            }}
          />
        </Marker>
      ))}
      {overlay.points.map((p) => (
        <Marker key={p.id} longitude={p.lng} latitude={p.lat} anchor="center">
          <div
            title={p.title}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              backgroundColor: "#8b5cf6",
              border: "2px dashed white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              cursor: "pointer"
            }}
          />
        </Marker>
      ))}
      {hasOverlayGeoJSON && (
        // @ts-expect-error - GeoJSON structure is valid; maplibre types are strict
        <Source id="overlay-geojson" type="geojson" data={overlayGeoJSON}>
          <Layer
            id="overlay-polygons"
            type="fill"
            // @ts-expect-error - MapLibre filter expression; types are strict
            filter={POLYGON_FILTER}
            paint={{ "fill-color": "#8b5cf6", "fill-opacity": 0.25 }}
          />
          <Layer
            id="overlay-polygon-outline"
            type="line"
            // @ts-expect-error - MapLibre filter expression
            filter={POLYGON_FILTER}
            paint={{ "line-color": "#8b5cf6", "line-width": 2, "line-dasharray": [2, 1] }}
          />
          <Layer
            id="overlay-lines"
            type="line"
            // @ts-expect-error - MapLibre filter expression
            filter={LINESTRING_FILTER}
            paint={{ "line-color": "#8b5cf6", "line-width": 2, "line-dasharray": [2, 1] }}
          />
        </Source>
      )}
    </MapGL>
  );
}
