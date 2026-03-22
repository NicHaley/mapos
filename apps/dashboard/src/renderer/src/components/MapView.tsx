import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import MapGL, { Layer, type MapRef, Marker, Source } from "react-map-gl/maplibre";

const PROTOMAPS_KEY = import.meta.env.RENDERER_VITE_PROTOMAPS_KEY as string;

function useDarkMapStyle() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const [isDark, setIsDark] = useState(mq.matches);

  useEffect(() => {
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mq]);

  return `https://api.protomaps.com/styles/v5/${isDark ? "black" : "light"}/en.json?key=${PROTOMAPS_KEY}`;
}

export type PlaceRecord = {
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

export type MapViewHandle = {
  flyTo: (lat: number, lng: number) => void;
};

const MapView = forwardRef<
  MapViewHandle,
  {
    onSelectPlace?: (place: PlaceRecord) => void;
    selectedPlace?: PlaceRecord | null;
    selectedFolder?: string | null;
  }
>(function MapView({ onSelectPlace, selectedPlace, selectedFolder }, ref) {
  const mapRef = useRef<MapRef>(null);
  const mapStyle = useDarkMapStyle();

  useImperativeHandle(ref, () => ({
    flyTo: (lat, lng) => {
      mapRef.current?.flyTo({ center: [lng, lat], zoom: 14, duration: 600 });
    }
  }));

  const boundsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedFolderRef = useRef<string | null>(null);
  selectedFolderRef.current = selectedFolder ?? null;

  const [folderPlaces, setFolderPlaces] = useState<PlaceRecord[]>([]);
  const [overlay, setOverlay] = useState<OverlayData>(EMPTY_OVERLAY);

  const fitToFolder = useCallback(async (folderPath: string) => {
    const places = await window.api.places.queryFolderAll(folderPath);
    setFolderPlaces(places);
    if (places.length === 0) return;
    const map = mapRef.current;
    if (!map) return;
    if (places.length === 1) {
      map.flyTo({ center: [places[0].lng, places[0].lat], zoom: 14, duration: 600 });
    } else {
      const lngs = places.map((p) => p.lng);
      const lats = places.map((p) => p.lat);
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)]
        ],
        { padding: 60, duration: 600, maxZoom: 16 }
      );
    }
  }, []);

  const debouncedMove = useCallback(() => {
    if (boundsTimer.current) clearTimeout(boundsTimer.current);
    boundsTimer.current = setTimeout(() => {
      const map = mapRef.current;
      if (!map) return;
      const b = map.getBounds();
      if (!b) return;
      window.api.map.sendViewport({
        north: b.getNorth(),
        south: b.getSouth(),
        east: b.getEast(),
        west: b.getWest(),
        centerLat: map.getCenter().lat,
        centerLng: map.getCenter().lng,
        zoom: map.getZoom()
      });
    }, 150);
  }, []);

  useEffect(() => {
    // File changed on disk — re-fit if a folder is selected
    window.api.places.onUpdated(() => {
      if (selectedFolderRef.current) {
        fitToFolder(selectedFolderRef.current);
      }
    });
    window.api.map.onOverlay(({ points = [], lines = [], polygons = [] }) =>
      setOverlay({ points, lines, polygons })
    );
    window.api.map.onOverlayClear(() => setOverlay(EMPTY_OVERLAY));
    window.api.map.onPanTo(({ lat, lng, zoom }) => {
      mapRef.current?.flyTo({ center: [lng, lat], zoom: zoom ?? 14, duration: 800 });
    });
    return () => {
      window.api.places.removeListeners();
      window.api.map.removeListeners();
      if (boundsTimer.current) clearTimeout(boundsTimer.current);
    };
  }, [fitToFolder]);

  useEffect(() => {
    if (selectedFolder) {
      fitToFolder(selectedFolder);
    } else {
      setFolderPlaces([]);
    }
  }, [selectedFolder, fitToFolder]);

  const overlayGeoJSON = useMemo(() => {
    const features: Array<{
      type: "Feature";
      geometry:
        | { type: "LineString"; coordinates: [number, number][] }
        | { type: "Polygon"; coordinates: [number, number][][] };
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
      ref={mapRef}
      initialViewState={{ longitude: 0, latitude: 20, zoom: 2 }}
      style={{ width: "100%", height: "100%" }}
      mapStyle={mapStyle}
      onMove={debouncedMove}
    >
      {selectedPlace ? (
        <Marker
          key={selectedPlace.filePath}
          longitude={selectedPlace.lng}
          latitude={selectedPlace.lat}
          anchor="center"
        >
          <div
            role="button"
            tabIndex={0}
            title={selectedPlace.title}
            onClick={() => onSelectPlace?.(selectedPlace)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectPlace?.(selectedPlace);
              }
            }}
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              backgroundColor: STATUS_COLORS[selectedPlace.status] ?? "#6b7280",
              border: "2px solid white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              cursor: "pointer"
            }}
          />
        </Marker>
      ) : (
        folderPlaces.map((place) => (
          <Marker key={place.filePath} longitude={place.lng} latitude={place.lat} anchor="center">
            <div
              role="button"
              tabIndex={0}
              title={place.title}
              onClick={() => onSelectPlace?.(place)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectPlace?.(place);
                }
              }}
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
        ))
      )}
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
});

export default MapView;
