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
import bbox from "@turf/bbox";
import MapGL, {
  Layer,
  type MapLayerMouseEvent,
  type MapRef,
  Marker,
  Source,
} from "react-map-gl/maplibre";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";

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
  geometry: string; // GeoJSON geometry JSON string
  title: string;
  color?: string;
  type: string;
  tags?: string[];
  filePath: string;
};

type GeoJSONPoint = { type: "Point"; coordinates: [number, number] };
/** Matches stored place geometries; keeps literal `type` for Turf / GeoJSON typings. */
type GeoJSONGeometry =
  | GeoJSONPoint
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] };

function isPoint(geo: GeoJSONGeometry): geo is GeoJSONPoint {
  return geo.type === "Point";
}

function parseGeometry(geometryJson: string): GeoJSONGeometry {
  return JSON.parse(geometryJson) as GeoJSONGeometry;
}

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

const POINT_FILTER = ["==", ["geometry-type"], "Point"];
const POLYGON_FILTER = ["==", ["geometry-type"], "Polygon"];
const LINESTRING_FILTER = ["==", ["geometry-type"], "LineString"];

export type MapViewHandle = {
  flyTo: (lat: number, lng: number) => void;
  fitToFolder: (folderPath: string) => void;
};

const PROJECT_SIDEBAR_WIDTH = 256; // 16rem
const CHAT_SIDEBAR_WIDTH = 360;
const FIT_BUFFER = 40;

const MapView = forwardRef<
  MapViewHandle,
  {
    onSelectPlace?: (place: PlaceRecord) => void;
    selectedPlace?: PlaceRecord | null;
    selectedFolder?: string | null;
    projectSidebarOpen?: boolean;
    chatSidebarOpen?: boolean;
  }
>(function MapView(
  { onSelectPlace, selectedPlace, selectedFolder, projectSidebarOpen, chatSidebarOpen },
  ref
) {
  const mapRef = useRef<MapRef>(null);
  const mapStyle = useDarkMapStyle();

  const boundsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedFolderRef = useRef<string | null>(null);
  selectedFolderRef.current = selectedFolder ?? null;

  const contextLatLngRef = useRef<{ lat: number; lng: number } | null>(null);

  const [folderPlaces, setFolderPlaces] = useState<PlaceRecord[]>([]);
  const [overlay, setOverlay] = useState<OverlayData>(EMPTY_OVERLAY);

  const projectSidebarOpenRef = useRef(projectSidebarOpen);
  projectSidebarOpenRef.current = projectSidebarOpen;
  const chatSidebarOpenRef = useRef(chatSidebarOpen);
  chatSidebarOpenRef.current = chatSidebarOpen;

  const selectedFolderForCreate = useRef(selectedFolder);
  selectedFolderForCreate.current = selectedFolder;
  const selectedPlaceForCreate = useRef(selectedPlace);
  selectedPlaceForCreate.current = selectedPlace;

  const fitToFolder = useCallback(async (folderPath: string) => {
    const places = await window.api.places.queryFolderAll(folderPath);
    setFolderPlaces(places);
    if (places.length === 0) return;
    const map = mapRef.current;
    if (!map) return;
    const paddingLeft = projectSidebarOpenRef.current
      ? PROJECT_SIDEBAR_WIDTH + FIT_BUFFER
      : FIT_BUFFER;
    const paddingRight = chatSidebarOpenRef.current ? CHAT_SIDEBAR_WIDTH + FIT_BUFFER : FIT_BUFFER;
    const collection = {
      type: "FeatureCollection" as const,
      features: places.map((p) => ({ type: "Feature" as const, geometry: parseGeometry(p.geometry), properties: {} }))
    };
    const [minLng, minLat, maxLng, maxLat] = bbox(collection);
    if (places.length === 1 && minLng === maxLng && minLat === maxLat) {
      map.flyTo({
        center: [minLng, minLat],
        zoom: 14,
        duration: 600,
        padding: { left: paddingLeft, right: paddingRight, top: FIT_BUFFER, bottom: FIT_BUFFER }
      });
    } else {
      map.fitBounds(
        [[minLng, minLat], [maxLng, maxLat]],
        {
          padding: { left: paddingLeft, right: paddingRight, top: FIT_BUFFER, bottom: FIT_BUFFER },
          duration: 600,
          maxZoom: 16
        }
      );
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flyTo: (lat, lng) => {
        mapRef.current?.flyTo({ center: [lng, lat], zoom: 14, duration: 600 });
      },
      fitToFolder
    }),
    [fitToFolder]
  );

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

  const handleContextMenu = useCallback((e: MapLayerMouseEvent) => {
    contextLatLngRef.current = { lat: e.lngLat.lat, lng: e.lngLat.lng };
  }, []);

  const handleCreatePlaceFile = useCallback(async () => {
    const latLng = contextLatLngRef.current;
    if (!latLng) return;
    const result = await window.api.fs.createPlaceFile({
      parentFolderPath: selectedFolderForCreate.current ?? null,
      lat: latLng.lat,
      lng: latLng.lng
    });
    if (!result.success) {
      console.error("[MapView] create place file:", result.error);
      return;
    }
    const filePath = result.filePath;
    const basename = filePath.split(/[/\\]/).pop() ?? "new-place.md";
    const title = basename.replace(/\.md$/i, "");
    const fallbackPlace: PlaceRecord = {
      geometry: JSON.stringify({ type: "Point", coordinates: [latLng.lng, latLng.lat] }),
      title,
      type: "place",
      filePath
    };
    const createdPlace = (await window.api.places.getByPath(filePath)) ?? fallbackPlace;
    onSelectPlace?.(createdPlace);
    if (!selectedPlaceForCreate.current && selectedFolderForCreate.current) {
      setFolderPlaces((prev) => [...prev, fallbackPlace]);
    }
  }, [onSelectPlace]);

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

  const toFeature = (p: PlaceRecord) => ({
    type: "Feature" as const,
    geometry: parseGeometry(p.geometry),
    properties: { filePath: p.filePath, color: p.color ?? "#6b7280" }
  });

  // All folder places as one source (excluding selected to avoid double-render)
  const folderGeoJSON = useMemo(() => {
    const places = selectedPlace
      ? folderPlaces.filter((p) => p.filePath !== selectedPlace.filePath)
      : folderPlaces;
    if (places.length === 0) return null;
    try {
      return { type: "FeatureCollection" as const, features: places.map(toFeature) };
    } catch { return null; }
  }, [folderPlaces, selectedPlace]);

  // Selected place as its own source for distinct styling
  const selectedGeoJSON = useMemo(() => {
    if (!selectedPlace) return null;
    try {
      return { type: "FeatureCollection" as const, features: [toFeature(selectedPlace)] };
    } catch { return null; }
  }, [selectedPlace]);

  const handleLayerClick = useCallback((e: MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    if (!feature?.properties?.filePath) return;
    const filePath = feature.properties.filePath as string;
    const place = folderPlaces.find((p) => p.filePath === filePath)
      ?? (selectedPlace?.filePath === filePath ? selectedPlace : undefined);
    if (place) onSelectPlace?.(place);
  }, [folderPlaces, selectedPlace, onSelectPlace]);

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = [];
    if (folderGeoJSON) ids.push("folder-circle", "folder-fill", "folder-line");
    if (selectedGeoJSON) ids.push("selected-circle", "selected-fill", "selected-line");
    return ids;
  }, [folderGeoJSON, selectedGeoJSON]);

  return (
    <ContextMenu>
      <ContextMenuTrigger style={{ display: "contents" }}>
        <MapGL
          ref={mapRef}
          initialViewState={{ longitude: 0, latitude: 20, zoom: 2 }}
          style={{ width: "100%", height: "100%" }}
          mapStyle={mapStyle}
          onMove={debouncedMove}
          onContextMenu={handleContextMenu}
          interactiveLayerIds={interactiveLayerIds}
          onClick={handleLayerClick}
        >
        {folderGeoJSON && (
          // @ts-expect-error - GeoJSON structure is valid; maplibre types are strict
          <Source id="folder-geojson" type="geojson" data={folderGeoJSON}>
            <Layer
              id="folder-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={POINT_FILTER}
              paint={{
                "circle-radius": 6,
                "circle-color": ["get", "color"],
                "circle-stroke-width": 1.5,
                "circle-stroke-color": "white",
              }}
            />
            <Layer
              id="folder-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{ "fill-color": ["get", "color"], "fill-opacity": 0.25 }}
            />
            <Layer
              id="folder-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{ "line-color": ["get", "color"], "line-width": 2 }}
            />
            <Layer
              id="folder-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{ "line-color": ["get", "color"], "line-width": 2 }}
            />
          </Source>
        )}
        {selectedGeoJSON && (
          // @ts-expect-error - GeoJSON structure is valid; maplibre types are strict
          <Source id="selected-geojson" type="geojson" data={selectedGeoJSON}>
            <Layer
              id="selected-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={POINT_FILTER}
              paint={{
                "circle-radius": 7,
                "circle-color": ["get", "color"],
                "circle-stroke-width": 2,
                "circle-stroke-color": "white",
              }}
            />
            <Layer
              id="selected-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{ "fill-color": ["get", "color"], "fill-opacity": 0.35 }}
            />
            <Layer
              id="selected-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{ "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": [2, 1] }}
            />
            <Layer
              id="selected-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{ "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": [2, 1] }}
            />
          </Source>
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => void handleCreatePlaceFile()}>
          New place file
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export default MapView;
