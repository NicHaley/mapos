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
import { bbox } from "@turf/bbox";
import MapGL, {
  Layer,
  type MapLayerMouseEvent,
  type MapRef,
  Marker,
  Source
} from "react-map-gl/maplibre";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";

const PROTOMAPS_KEY = import.meta.env.RENDERER_VITE_PROTOMAPS_KEY as string;

function useDarkMapStyle() {
  const isDark = useDarkMode();
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
  fitToPlace: (place: PlaceRecord) => void;
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

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    lat: number;
    lng: number;
  } | null>(null);

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

  const getPadding = useCallback(() => {
    const left = projectSidebarOpenRef.current ? PROJECT_SIDEBAR_WIDTH + FIT_BUFFER : FIT_BUFFER;
    const right = chatSidebarOpenRef.current ? CHAT_SIDEBAR_WIDTH + FIT_BUFFER : FIT_BUFFER;
    return { left, right, top: FIT_BUFFER, bottom: FIT_BUFFER };
  }, []);

  const fitToFolder = useCallback(async (folderPath: string) => {
    const places = await window.api.places.queryFolderAll(folderPath);
    setFolderPlaces(places);
    if (places.length === 0) return;
    const map = mapRef.current;
    if (!map) return;
    const padding = getPadding();
    // MapLibre persists padding as camera state — reset before each call so
    // the padding we pass isn't compounded onto the previous value.
    map.getMap().setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    const collection = {
      type: "FeatureCollection" as const,
      features: places.map((p) => ({
        type: "Feature" as const,
        geometry: parseGeometry(p.geometry),
        properties: {}
      }))
    };
    const [minLng, minLat, maxLng, maxLat] = bbox(collection);
    if (places.length === 1 && minLng === maxLng && minLat === maxLat) {
      map.flyTo({ center: [minLng, minLat], zoom: 14, duration: 600, padding });
    } else {
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding, duration: 600, maxZoom: 16 });
    }
  }, [getPadding]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo: (lat, lng) => {
        const map = mapRef.current;
        if (!map) return;
        // MapLibre persists padding as camera state — reset before each call so
    // the padding we pass isn't compounded onto the previous value.
    map.getMap().setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
        map.flyTo({ center: [lng, lat], zoom: 14, duration: 600 });
      },
      fitToFolder,
      fitToPlace: (place: PlaceRecord) => {
        const map = mapRef.current;
        if (!map) return;
        try {
          const geo = parseGeometry(place.geometry);
          const padding = getPadding();
          // MapLibre persists padding as camera state — reset before each call so
    // the padding we pass isn't compounded onto the previous value.
    map.getMap().setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
          if (isPoint(geo)) {
            map.flyTo({ center: geo.coordinates, zoom: 14, duration: 600, padding });
          } else {
            const [minLng, minLat, maxLng, maxLat] = bbox({ type: "Feature", geometry: geo, properties: {} });
            map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding, duration: 600, maxZoom: 16 });
          }
        } catch { /* invalid geometry */ }
      }
    }),
    [fitToFolder, getPadding]
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
    e.preventDefault();
    setContextMenu({
      x: e.point.x,
      y: e.point.y,
      lat: e.lngLat.lat,
      lng: e.lngLat.lng,
    });
  }, []);

  const handleCreatePlaceFile = useCallback(async () => {
    if (!contextMenu) return;
    setContextMenu(null);
    const result = await window.api.fs.createPlaceFile({
      parentFolderPath: selectedFolderForCreate.current ?? null,
      lat: contextMenu.lat,
      lng: contextMenu.lng
    });
    if (!result.success) {
      console.error("[MapView] create place file:", result.error);
      return;
    }
    const filePath = result.filePath;
    const basename = filePath.split(/[/\\]/).pop() ?? "new-place.md";
    const title = basename.replace(/\.md$/i, "");
    const fallbackPlace: PlaceRecord = {
      geometry: JSON.stringify({ type: "Point", coordinates: [contextMenu.lng, contextMenu.lat] }),
      title,
      type: "place",
      filePath
    };
    const createdPlace = (await window.api.places.getByPath(filePath)) ?? fallbackPlace;
    onSelectPlace?.(createdPlace);
    if (!selectedPlaceForCreate.current && selectedFolderForCreate.current) {
      setFolderPlaces((prev) => [...prev, fallbackPlace]);
    }
  }, [contextMenu, onSelectPlace]);

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

  const toFeature = useCallback(
    (p: PlaceRecord) => ({
      type: "Feature" as const,
      geometry: parseGeometry(p.geometry),
      properties: { filePath: p.filePath, color: p.color ?? "#6b7280" }
    }),
    []
  );

  // All folder places as one source (excluding selected to avoid double-render)
  const folderGeoJSON = useMemo(() => {
    const places = selectedPlace
      ? folderPlaces.filter((p) => p.filePath !== selectedPlace.filePath)
      : folderPlaces;
    if (places.length === 0) return null;
    try {
      return { type: "FeatureCollection" as const, features: places.map(toFeature) };
    } catch {
      return null;
    }
  }, [folderPlaces, selectedPlace, toFeature]);

  // Selected place as its own source for distinct styling
  const selectedGeoJSON = useMemo(() => {
    if (!selectedPlace) return null;
    try {
      return { type: "FeatureCollection" as const, features: [toFeature(selectedPlace)] };
    } catch {
      return null;
    }
  }, [selectedPlace, toFeature]);

  const handleLayerClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature?.properties?.filePath) return;
      const filePath = feature.properties.filePath as string;
      const place =
        folderPlaces.find((p) => p.filePath === filePath) ??
        (selectedPlace?.filePath === filePath ? selectedPlace : undefined);
      if (place) onSelectPlace?.(place);
    },
    [folderPlaces, selectedPlace, onSelectPlace]
  );

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = [];
    if (folderGeoJSON) ids.push("folder-circle", "folder-fill", "folder-line");
    if (selectedGeoJSON) ids.push("selected-circle", "selected-fill", "selected-line");
    return ids;
  }, [folderGeoJSON, selectedGeoJSON]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
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
                  "circle-stroke-color": "white"
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
                  "circle-stroke-color": "white"
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
                paint={{
                  "line-color": ["get", "color"],
                  "line-width": 2.5,
                  "line-dasharray": [2, 1]
                }}
              />
              <Layer
                id="selected-line"
                type="line"
                // @ts-expect-error - MapLibre filter expression
                filter={LINESTRING_FILTER}
                paint={{
                  "line-color": ["get", "color"],
                  "line-width": 2.5,
                  "line-dasharray": [2, 1]
                }}
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
      <DropdownMenu
        open={!!contextMenu}
        onOpenChange={(open) => { if (!open) setContextMenu(null); }}
      >
        <DropdownMenuTrigger
          style={{
            position: "absolute",
            left: contextMenu?.x ?? 0,
            top: contextMenu?.y ?? 0,
            width: 0,
            height: 0,
            padding: 0,
            border: "none",
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <DropdownMenuContent side="bottom" align="start" sideOffset={0}>
          <DropdownMenuItem onClick={() => void handleCreatePlaceFile()}>
            New place file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

export default MapView;
