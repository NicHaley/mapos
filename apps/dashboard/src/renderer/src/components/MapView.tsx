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

import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import type { PlaceRecord } from "../../../shared/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "./ui/dropdown-menu";

export type { PlaceRecord };

const PROTOMAPS_KEY = import.meta.env.RENDERER_VITE_PROTOMAPS_KEY as string;

function useDarkMapStyle() {
  const isDark = useDarkMode();
  return `https://api.protomaps.com/styles/v5/${isDark ? "black" : "light"}/en.json?key=${PROTOMAPS_KEY}`;
}

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

type FitPadding = { left: number; right: number; top: number; bottom: number };

export type MapViewHandle = {
  flyTo: (lat: number, lng: number) => void;
  fitToFolder: (folderPath: string, padding: FitPadding) => void;
  fitToPlace: (place: PlaceRecord, padding: FitPadding) => void;
};

/**
 * Compute the camera position (center + zoom) for a bounding box with the given padding,
 * independent of the map's current transform.padding state.
 *
 * maplibre's cameraForBounds *adds* options.padding to the transform's stored padding when
 * computing available viewport space. To get a predictable result we temporarily zero out
 * the transform padding (synchronously, without firing events or triggering a repaint) so
 * that the calculation only accounts for the padding we actually want.
 */
function cameraForBounds(
  map: MapRef,
  bounds: [[number, number], [number, number]],
  padding: FitPadding
) {
  const nativeMap = map.getMap();
  const savedPadding = nativeMap.getPadding();
  nativeMap.transform.setPadding(padding);
  const cam = nativeMap.cameraForBounds(bounds, { maxZoom: 16 });
  nativeMap.transform.setPadding(savedPadding);
  return cam;
}

function getGeometryCenter(geo: GeoJSONGeometry): [number, number] {
  if (isPoint(geo)) return geo.coordinates;
  const [minLng, minLat, maxLng, maxLat] = bbox({ type: "Feature", geometry: geo, properties: {} });
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

const MapView = forwardRef<
  MapViewHandle,
  {
    onSelectPlace?: (place: PlaceRecord) => void;
    onCreatePlace?: (place: PlaceRecord) => void;
    onMapClickEmpty?: () => void;
    selectedPlace?: PlaceRecord | null;
    selectedFolder?: string | null;
    onSelectedFeaturePosition?: (x: number, y: number) => void;
  }
>(function MapView(
  {
    onSelectPlace,
    onCreatePlace,
    onMapClickEmpty,
    selectedPlace,
    selectedFolder,
    onSelectedFeaturePosition
  },
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

  const onSelectedFeaturePositionRef = useRef(onSelectedFeaturePosition);
  onSelectedFeaturePositionRef.current = onSelectedFeaturePosition;
  const selectedPlaceRef = useRef(selectedPlace);
  selectedPlaceRef.current = selectedPlace;

  const emitFeaturePosition = useCallback(() => {
    const map = mapRef.current;
    const place = selectedPlaceRef.current;
    const cb = onSelectedFeaturePositionRef.current;
    if (!map || !place || !cb || !place.geometry) return;
    try {
      const center = getGeometryCenter(parseGeometry(place.geometry));
      const pt = map.project(center);
      cb(pt.x, pt.y);
    } catch {
      /* invalid geometry */
    }
  }, []);

  const selectedFolderForCreate = useRef(selectedFolder);
  selectedFolderForCreate.current = selectedFolder;
  const selectedPlaceForCreate = useRef(selectedPlace);
  selectedPlaceForCreate.current = selectedPlace;

  const loadFolderPlaces = useCallback(async (folderPath: string) => {
    const places = await window.api.places.queryFolderAll(folderPath);
    setFolderPlaces(places);
    return places;
  }, []);

  const fitToFolder = useCallback(
    async (folderPath: string, padding: FitPadding) => {
      const places = await loadFolderPlaces(folderPath);
      const placesWithGeo = places.filter((p): p is PlaceRecord & { geometry: string } =>
        Boolean(p.geometry)
      );
      if (placesWithGeo.length === 0) return;
      const map = mapRef.current;
      if (!map) return;
      const collection = {
        type: "FeatureCollection" as const,
        features: placesWithGeo.map((p) => ({
          type: "Feature" as const,
          geometry: parseGeometry(p.geometry),
          properties: {}
        }))
      };
      const [minLng, minLat, maxLng, maxLat] = bbox(collection);
      if (placesWithGeo.length === 1 && minLng === maxLng && minLat === maxLat) {
        map.flyTo({ center: [minLng, minLat], zoom: 14, duration: 600, padding });
      } else {
        const cam = cameraForBounds(
          map,
          [
            [minLng, minLat],
            [maxLng, maxLat]
          ],
          padding
        );
        if (cam) map.flyTo({ ...cam, duration: 600, padding });
      }
    },
    [loadFolderPlaces]
  );

  useImperativeHandle(
    ref,
    () => ({
      flyTo: (lat, lng) => {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({ center: [lng, lat], zoom: 14, duration: 600 });
      },
      fitToFolder,
      fitToPlace: (place: PlaceRecord, padding: FitPadding) => {
        const map = mapRef.current;
        if (!map || !place.geometry) return;
        try {
          const geo = parseGeometry(place.geometry);
          if (isPoint(geo)) {
            map.flyTo({ center: geo.coordinates, zoom: 14, duration: 600, padding });
          } else {
            const [minLng, minLat, maxLng, maxLat] = bbox({
              type: "Feature",
              geometry: geo,
              properties: {}
            });
            const cam = cameraForBounds(
              map,
              [
                [minLng, minLat],
                [maxLng, maxLat]
              ],
              padding
            );
            if (cam) map.flyTo({ ...cam, duration: 600, padding });
          }
        } catch {
          /* invalid geometry */
        }
      }
    }),
    [fitToFolder]
  );

  const debouncedMove = useCallback(() => {
    emitFeaturePosition();
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
  }, [emitFeaturePosition]);

  useEffect(() => {
    // File changed on disk — refresh folder places without moving the camera
    window.api.places.onUpdated(() => {
      if (selectedFolderRef.current) {
        void loadFolderPlaces(selectedFolderRef.current);
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
  }, [loadFolderPlaces]);

  useEffect(() => {
    if (selectedFolder) {
      void loadFolderPlaces(selectedFolder);
    } else {
      setFolderPlaces([]);
    }
  }, [selectedFolder, loadFolderPlaces]);

  useEffect(() => {
    emitFeaturePosition();
  }, [selectedPlace, emitFeaturePosition]);

  const handleContextMenu = useCallback((e: MapLayerMouseEvent) => {
    e.preventDefault();
    setContextMenu({
      x: e.point.x,
      y: e.point.y,
      lat: e.lngLat.lat,
      lng: e.lngLat.lng
    });
  }, []);

  const handleCreatePlaceFile = useCallback(async () => {
    if (!contextMenu) return;
    setContextMenu(null);
    const result = await window.api.fs.createNoteFile({
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
    onCreatePlace?.(createdPlace);
    if (!selectedPlaceForCreate.current && selectedFolderForCreate.current) {
      setFolderPlaces((prev) => [...prev, fallbackPlace]);
    }
  }, [contextMenu, onCreatePlace]);

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

  const toFeature = useCallback((p: PlaceRecord & { geometry: string }) => {
    return {
      type: "Feature" as const,
      geometry: parseGeometry(p.geometry),
      properties: { filePath: p.filePath, color: p.color ?? "#6b7280" }
    };
  }, []);

  // All folder places as one source (excluding selected to avoid double-render)
  const folderGeoJSON = useMemo(() => {
    const places = (
      selectedPlace
        ? folderPlaces.filter((p) => p.filePath !== selectedPlace.filePath)
        : folderPlaces
    ).filter((p): p is PlaceRecord & { geometry: string } => Boolean(p.geometry));
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
    const { geometry } = selectedPlace;
    if (!geometry) return null;
    try {
      return {
        type: "FeatureCollection" as const,
        features: [toFeature({ ...selectedPlace, geometry })]
      };
    } catch {
      return null;
    }
  }, [selectedPlace, toFeature]);

  const handleLayerClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature?.properties?.filePath) {
        onMapClickEmpty?.();
        return;
      }
      const filePath = feature.properties.filePath as string;
      const place =
        folderPlaces.find((p) => p.filePath === filePath) ??
        (selectedPlace?.filePath === filePath ? selectedPlace : undefined);
      if (place) onSelectPlace?.(place);
    },
    [folderPlaces, selectedPlace, onSelectPlace, onMapClickEmpty]
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
                "circle-radius": 3,
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
        modal
        open={!!contextMenu}
        onOpenChange={(open, details) => {
          if (
            !open &&
            (details.reason === "escape-key" ||
              details.reason === "outside-press" ||
              details.reason === "item-press")
          ) {
            setContextMenu(null);
          }
        }}
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
            pointerEvents: "none"
          }}
        />
        <DropdownMenuContent side="bottom" align="start" sideOffset={0}>
          <DropdownMenuItem onClick={() => void handleCreatePlaceFile()}>New Note</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

export default MapView;
