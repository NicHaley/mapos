import { useDebouncedCallback } from "@renderer/hooks/use-debounced-callback";
import { bbox } from "@turf/bbox";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import MapGL, {
  Layer,
  type MapLayerMouseEvent,
  type MapRef,
  Marker,
  Source,
  useMap
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
// Side-effect import: registers the pmtiles:// protocol for offline tiles.
import "@renderer/lib/pmtiles-protocol";

import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { useMapViewport } from "@renderer/contexts/map-viewport";
import { RegionCoverageIndicator } from "./map/region-coverage-indicator";
import type { MapOverlayLayer, OverlayPoint, PlaceRecord } from "../../../shared/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { SquarePenIcon } from "lucide-react";

export type { PlaceRecord };

/**
 * Resolves the active tile style URL via the main-process dispatcher. Returns
 * null on first render and during dark-mode transitions until the IPC settles
 * (sub-millisecond in practice). Callers gate the MapGL render on a non-null
 * value to avoid handing MapLibre an empty string.
 */
function useDarkMapStyle(): string | null {
  const isDark = useDarkMode();
  const [styleUrl, setStyleUrl] = useState<string | null>(null);
  // Bumped when packs are added/removed. Re-resolves the style URL and — since the
  // offline style URL (mapos-region://_all/style.json) is stable while its contents
  // change — cache-busts it so react-map-gl/MapLibre actually reload the style.
  const [revision, setRevision] = useState(0);

  useEffect(() => window.api.regions.onChanged(() => setRevision((r) => r + 1)), []);

  useEffect(() => {
    let cancelled = false;
    window.api.services
      .tilesStyleUrl({ isDark })
      .then((url) => {
        if (cancelled) return;
        const busted = revision > 0 ? `${url}${url.includes("?") ? "&" : "?"}rev=${revision}` : url;
        setStyleUrl(busted);
      })
      .catch((err) => {
        console.error("[map-view] failed to resolve tile style URL", err);
        if (!cancelled) setStyleUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isDark, revision]);

  return styleUrl;
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

const EMPTY_LAYERS: MapOverlayLayer[] = [];

/** Markers/features outside the focused layer (the hovered chat card) dim to this. */
const UNFOCUSED_OPACITY = 0.3;

/** Stable, css-safe source id for an overlay layer (layer ids are tool-call ids). */
function overlaySourceId(layerId: string): string {
  return `overlay-${layerId.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

const MAP_OVERLAY_PREFIX = "map-overlay:";

function placeFromOverlayPoint(p: OverlayPoint): PlaceRecord {
  return {
    filePath: `${MAP_OVERLAY_PREFIX}${p.id}`,
    title: p.title || "Place",
    type: "Preview",
    geometry: JSON.stringify({ type: "Point", coordinates: [p.lng, p.lat] }),
    previewMarkdown: p.preview_markdown ?? ""
  };
}

function placeFromOverlayFeature(
  geometry: GeoJSONGeometry,
  id: string,
  title: string,
  previewMarkdown?: string
): PlaceRecord {
  return {
    filePath: `${MAP_OVERLAY_PREFIX}${id}`,
    title: title || "Map overlay",
    type: "Preview",
    geometry: JSON.stringify(geometry),
    previewMarkdown: previewMarkdown ?? ""
  };
}

const POINT_FILTER = ["==", ["geometry-type"], "Point"];
const POLYGON_FILTER = ["==", ["geometry-type"], "Polygon"];
const LINESTRING_FILTER = ["==", ["geometry-type"], "LineString"];

type FitPadding = { left: number; right: number; top: number; bottom: number };

type RawFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: Record<string, unknown> | null;
    properties: Record<string, unknown> | null;
  }>;
};

function formatGeoJsonProperties(props: Record<string, unknown>): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `**${k}:** ${String(v ?? "")}`).join("\n\n");
}

/** Optional second argument when the user picked a place by clicking the map. */
export type MapSelectPlaceMeta = { mapClickLngLat: { lng: number; lat: number } };

/** When set and `filePath` matches the highlighted place, non-Point pulses use this click position. */
export type SelectionPulseAnchor = { filePath: string; lng: number; lat: number };

export type MapViewHandle = {
  flyTo: (
    lat: number,
    lng: number,
    opts?: { zoom?: number; padding?: FitPadding }
  ) => void;
  fitToFolder: (folderPath: string, padding: FitPadding) => void;
  fitToPlace: (place: PlaceRecord, padding: FitPadding) => void;
  fitToPlaceAndLinks: (
    place: PlaceRecord,
    links: PlaceRecord[],
    padding: FitPadding
  ) => void;
  fitToGeoJson: (data: RawFeatureCollection, padding: FitPadding) => void;
  invalidateFolderPlace: (filePath: string) => void;
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

const SELECTION_PULSE_IMAGE_ID = "mapos-selection-pulse";

/** Canvas-backed StyleImageInterface — see MapLibre “Add an animated icon to the map”. */
function createSelectionPulsingDot(map: { triggerRepaint: () => void }) {
  const size = 64;
  const dot = {
    width: size,
    height: size,
    data: new Uint8Array(size * size * 4),
    context: undefined as CanvasRenderingContext2D | undefined,
    onAdd(this: typeof dot) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      this.context = canvas.getContext("2d") ?? undefined;
    },
    render(this: typeof dot) {
      const ctx = this.context;
      if (!ctx) return false;
      const duration = 1600;
      const t = (performance.now() % duration) / duration;
      const radius = (size / 2) * 0.3125;
      const outerRadius = (size / 2) * 0.58 * t + radius;
      ctx.clearRect(0, 0, size, size);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, outerRadius + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(30, 30, 35, ${0.22 * (1 - t)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, outerRadius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.55 * (1 - t)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 1)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.lineWidth = 1.75 + 2.4 * (1 - t);
      ctx.fill();
      ctx.stroke();
      this.data = new Uint8Array(ctx.getImageData(0, 0, size, size).data);
      map.triggerRepaint();
      return true;
    }
  };
  return dot;
}

type SelectionPulseGeoJSON = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
};

const SELECTION_PULSE_LAYER_ID = "selection-pulse-symbol";

/** Keep the pulse above basemap labels and our own circle/line layers after style churn. */
function movePulseLayerToTop(map: ReturnType<MapRef["getMap"]>) {
  try {
    if (map.getLayer(SELECTION_PULSE_LAYER_ID)) map.moveLayer(SELECTION_PULSE_LAYER_ID);
  } catch {
    /* layer or style unavailable */
  }
}

function SelectionPulseLayers({ data }: { data: SelectionPulseGeoJSON }) {
  const maps = useMap();
  const mapRef = maps.current;
  const [imageReady, setImageReady] = useState(false);
  useLayoutEffect(() => {
    if (!mapRef) return;
    const map = mapRef.getMap();
    let cancelled = false;

    const install = () => {
      if (cancelled) return;
      try {
        const pulsingDot = createSelectionPulsingDot(map);
        if (map.hasImage(SELECTION_PULSE_IMAGE_ID)) map.removeImage(SELECTION_PULSE_IMAGE_ID);
        map.addImage(SELECTION_PULSE_IMAGE_ID, pulsingDot, { pixelRatio: 2 });
        setImageReady(true);
      } catch {
        /* style not fully loaded */
      }
    };

    install();
    map.on("style.load", install);
    return () => {
      cancelled = true;
      map.off("style.load", install);
      try {
        if (map.hasImage(SELECTION_PULSE_IMAGE_ID)) map.removeImage(SELECTION_PULSE_IMAGE_ID);
      } catch {
        /* map torn down */
      }
      setImageReady(false);
    };
  }, [mapRef]);

  const pulseCoordsKey =
    data.features[0]?.geometry.type === "Point"
      ? `${data.features[0].geometry.coordinates[0]},${data.features[0].geometry.coordinates[1]}`
      : "";

  /** Pulse Source/Layer mounts only after imageReady; pin layer above circles/labels after paint & on style churn.
   * Re-run when coordinates change so the raised layer stays after GeoJSON Source updates. */
  useLayoutEffect(() => {
    void pulseCoordsKey;
    if (!mapRef || !imageReady) return;
    const map = mapRef.getMap();
    const bump = () => movePulseLayerToTop(map);
    bump();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(bump);
    });
    map.on("style.load", bump);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      map.off("style.load", bump);
    };
  }, [mapRef, imageReady, pulseCoordsKey]);

  if (!imageReady) return null;

  return (
    <Source id="selection-pulse" type="geojson" data={data}>
      <Layer
        id={SELECTION_PULSE_LAYER_ID}
        type="symbol"
        layout={{
          "icon-image": SELECTION_PULSE_IMAGE_ID,
          // ~1.5× previous on-screen size; circles use map plane — match so centers stay aligned
          "icon-size": 1.35,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-pitch-alignment": "map",
          "icon-rotation-alignment": "map"
        }}
      />
    </Source>
  );
}

const MapView = forwardRef<
  MapViewHandle,
  {
    onSelectPlace?: (place: PlaceRecord, meta?: MapSelectPlaceMeta) => void;
    onCreatePlace?: (place: PlaceRecord) => void;
    /** Fired when the user clicks the map background (no place/overlay feature). */
    onMapClickEmpty?: (pos: { lng: number; lat: number }) => void;
    selectedPlace?: PlaceRecord | null;
    selectedFolder?: string | null;
    /** Where new notes are created (context menu): explicit folder, or parent of last vault file. */
    parentFolderForNewFiles?: string | null;
    onSelectedFeaturePosition?: (x: number, y: number) => void;
    /** Accumulated MCP overlay layers; owned by App (single IPC subscription). */
    overlayLayers?: MapOverlayLayer[];
    /** Layer id to emphasize (the hovered chat card); others dim. Null = all full opacity. */
    focusedLayerId?: string | null;
    /** Only render the overlay layers when the chat sidebar is open. */
    showOverlay?: boolean;
    /** GeoJSON files loaded on-demand (not indexed in DB). */
    geoJsonLayers?: Array<{
      filePath: string;
      data: RawFeatureCollection;
      bbox: [number, number, number, number];
    }>;
    selectionPulseAnchor?: SelectionPulseAnchor | null;
    /** Places referenced by [[wikilinks]] in the currently-open file; rendered gray. */
    linkedPlaces?: PlaceRecord[];
  }
>(function MapView(
  {
    onSelectPlace,
    onCreatePlace,
    onMapClickEmpty,
    selectedPlace,
    selectedFolder,
    parentFolderForNewFiles,
    onSelectedFeaturePosition,
    overlayLayers = EMPTY_LAYERS,
    focusedLayerId = null,
    showOverlay = false,
    geoJsonLayers = [],
    selectionPulseAnchor = null,
    linkedPlaces = []
  },
  ref
) {
  const mapRef = useRef<MapRef>(null);
  const { setViewportBBox } = useMapViewport();
  const mapStyle = useDarkMapStyle();
  const isDark = useDarkMode();
  const foregroundColor = isDark ? "#fafafa" : "#252525";

  const selectedFolderRef = useRef<string | null>(null);
  selectedFolderRef.current = selectedFolder ?? null;

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    lat: number;
    lng: number;
  } | null>(null);

  const [folderPlaces, setFolderPlaces] = useState<PlaceRecord[]>([]);
  /** All overlay points across layers, each tagged with its layer id for focus dimming. */
  const overlayPoints = useMemo(
    () => overlayLayers.flatMap((l) => l.points.map((p) => ({ ...p, layerId: l.id }))),
    [overlayLayers]
  );

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

  const parentForCreate =
    parentFolderForNewFiles !== undefined ? parentFolderForNewFiles : (selectedFolder ?? null);

  const loadFolderPlaces = useCallback(async (folderPath: string) => {
    const places = await window.api.places.queryFolderAll(folderPath);
    setFolderPlaces(places);
    return places;
  }, []);

  const fitToFolder = useCallback(
    async (folderPath: string, padding: FitPadding) => {
      // Load places and GeoJSON bboxes in parallel. We read the folder's GeoJSON files
      // directly rather than reading from the `geoJsonLayers` prop because that prop is
      // populated by an async effect in the parent; on first folder click it would still
      // hold the previous folder's layers (or be empty), causing the fit to miss them.
      const [places, gjPaths] = await Promise.all([
        loadFolderPlaces(folderPath),
        window.api.fs.geoJsonFilesInFolder(folderPath)
      ]);
      const placesWithGeo = places.filter((p): p is PlaceRecord & { geometry: string } =>
        Boolean(p.geometry)
      );
      const gjDatas = await Promise.all(gjPaths.map((p) => window.api.fs.readGeoJson(p)));
      const gjBboxCorners = gjDatas.flatMap((data) => {
        if (!data) return [];
        const [minLng, minLat, maxLng, maxLat] = bbox(
          data as unknown as Parameters<typeof bbox>[0]
        );
        return [
          {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [minLng, minLat] },
            properties: {}
          },
          {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [maxLng, maxLat] },
            properties: {}
          }
        ];
      });
      if (placesWithGeo.length === 0 && gjBboxCorners.length === 0) return;
      const map = mapRef.current;
      if (!map) return;
      const collection = {
        type: "FeatureCollection" as const,
        features: [
          ...placesWithGeo.map((p) => ({
            type: "Feature" as const,
            geometry: parseGeometry(p.geometry),
            properties: {}
          })),
          ...gjBboxCorners
        ]
      };
      const [minLng, minLat, maxLng, maxLat] = bbox(collection);
      const hasGjLayers = gjBboxCorners.length > 0;
      const totalFeatures = placesWithGeo.length + (hasGjLayers ? 1 : 0);
      if (totalFeatures === 1 && minLng === maxLng && minLat === maxLat) {
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
      flyTo: (lat, lng, opts) => {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({
          center: [lng, lat],
          zoom: opts?.zoom ?? 14,
          duration: 600,
          ...(opts?.padding ? { padding: opts.padding } : {})
        });
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
      },
      fitToPlaceAndLinks: (place: PlaceRecord, links: PlaceRecord[], padding: FitPadding) => {
        const map = mapRef.current;
        if (!map) return;
        const geometries: GeoJSONGeometry[] = [];
        const tryParse = (g?: string) => {
          if (!g) return;
          try {
            geometries.push(parseGeometry(g));
          } catch {
            /* invalid */
          }
        };
        tryParse(place.geometry);
        for (const link of links) tryParse(link.geometry);
        if (geometries.length === 0) return;
        if (geometries.length === 1) {
          const geo = geometries[0];
          if (isPoint(geo)) {
            map.flyTo({ center: geo.coordinates, zoom: 14, duration: 600, padding });
            return;
          }
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
          return;
        }
        const collection = {
          type: "FeatureCollection" as const,
          features: geometries.map((geometry) => ({
            type: "Feature" as const,
            geometry,
            properties: {}
          }))
        };
        const [minLng, minLat, maxLng, maxLat] = bbox(collection);
        if (minLng === maxLng && minLat === maxLat) {
          map.flyTo({ center: [minLng, minLat], zoom: 14, duration: 600, padding });
          return;
        }
        const cam = cameraForBounds(
          map,
          [
            [minLng, minLat],
            [maxLng, maxLat]
          ],
          padding
        );
        if (cam) map.flyTo({ ...cam, duration: 600, padding });
      },
      fitToGeoJson: (data: RawFeatureCollection, padding: FitPadding) => {
        const map = mapRef.current;
        if (!map || data.features.length === 0) return;
        try {
          // @ts-expect-error - bbox accepts FeatureCollection; our internal type is compatible
          const [minLng, minLat, maxLng, maxLat] = bbox(data);
          if (minLng === maxLng && minLat === maxLat) {
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
        } catch {
          /* invalid geometry */
        }
      },
      invalidateFolderPlace: (filePath: string) => {
        setFolderPlaces((prev) => prev.filter((p) => p.filePath !== filePath));
      }
    }),
    [fitToFolder]
  );

  const sendViewport = useDebouncedCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    if (!b) return;
    const center = map.getCenter();
    const zoom = map.getZoom();
    const north = b.getNorth();
    const south = b.getSouth();
    const east = b.getEast();
    const west = b.getWest();
    // Publish to the renderer-side context so geocoding search can bias toward
    // what's on screen (read on demand at search time — no re-render on pan).
    setViewportBBox({ north, south, east, west });
    window.api.map.sendViewport({
      north,
      south,
      east,
      west,
      centerLat: center.lat,
      centerLng: center.lng,
      zoom
    });
    localStorage.setItem(
      "mapos-viewport",
      JSON.stringify({ longitude: center.lng, latitude: center.lat, zoom })
    );
  }, 150);

  const debouncedMove = useCallback(() => {
    emitFeaturePosition();
    sendViewport();
  }, [emitFeaturePosition, sendViewport]);

  useEffect(() => {
    // File changed on disk — refresh folder places without moving the camera
    window.api.places.onUpdated(() => {
      if (selectedFolderRef.current) {
        void loadFolderPlaces(selectedFolderRef.current);
      }
    });
    return () => {
      window.api.places.removeListeners();
      sendViewport.cancel();
    };
  }, [loadFolderPlaces, sendViewport.cancel]);

  useEffect(() => {
    if (selectedFolder) {
      void loadFolderPlaces(selectedFolder);
    } else {
      setFolderPlaces([]);
    }
  }, [selectedFolder, loadFolderPlaces]);

  // Re-project when selection changes (emit reads refs; selectedPlace still needed to trigger)
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedPlace
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
      parentFolderPath: parentForCreate ?? null,
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
    if (!selectedPlace && parentForCreate) {
      setFolderPlaces((prev) => [...prev, fallbackPlace]);
    }
  }, [contextMenu, onCreatePlace, parentForCreate, selectedPlace]);

  // One GeoJSON source per overlay layer, so each layer's lines/polygons can be
  // dimmed independently with a plain numeric opacity (no data-driven expression).
  const overlayLayerSources = useMemo(() => {
    return overlayLayers
      .map((l) => {
        const features: Array<{
          type: "Feature";
          geometry:
            | { type: "LineString"; coordinates: [number, number][] }
            | { type: "Polygon"; coordinates: [number, number][][] };
          properties: Record<string, unknown>;
        }> = [];
        for (const ln of l.lines) {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: ln.coordinates },
            properties: {
              kind: "overlay",
              overlayId: ln.id,
              title: ln.title,
              preview_markdown: ln.preview_markdown
            }
          });
        }
        for (const pg of l.polygons) {
          features.push({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: pg.coordinates },
            properties: {
              kind: "overlay",
              overlayId: pg.id,
              title: pg.title,
              preview_markdown: pg.preview_markdown
            }
          });
        }
        return {
          layerId: l.id,
          sourceId: overlaySourceId(l.id),
          data:
            features.length > 0 ? { type: "FeatureCollection" as const, features } : null
        };
      })
      .filter((s): s is typeof s & { data: NonNullable<(typeof s)["data"]> } => s.data != null);
  }, [overlayLayers]);

  const toFeature = useCallback((p: PlaceRecord & { geometry: string }) => {
    return {
      type: "Feature" as const,
      geometry: parseGeometry(p.geometry),
      // Leave `color` undefined when unset so each layer can pick its own default
      // (lines need white; circles/polygons stay gray).
      properties: { filePath: p.filePath, color: p.color }
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

  // Wikilink-target places for the currently-open file (excluding the open file itself)
  const linkedGeoJSON = useMemo(() => {
    const places = (
      selectedPlace
        ? linkedPlaces.filter((p) => p.filePath !== selectedPlace.filePath)
        : linkedPlaces
    ).filter((p): p is PlaceRecord & { geometry: string } => Boolean(p.geometry));
    if (places.length === 0) return null;
    try {
      return { type: "FeatureCollection" as const, features: places.map(toFeature) };
    } catch {
      return null;
    }
  }, [linkedPlaces, selectedPlace, toFeature]);

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

  /** Pulse position: Points use geometry; lines/polygons only pulse where the user clicked. */
  const selectionPulseGeoJSON = useMemo((): SelectionPulseGeoJSON | null => {
    if (!selectedPlace?.geometry) return null;
    try {
      const geo = parseGeometry(selectedPlace.geometry);
      let lng: number;
      let lat: number;
      if (isPoint(geo)) {
        [lng, lat] = geo.coordinates;
      } else if (selectionPulseAnchor && selectionPulseAnchor.filePath === selectedPlace.filePath) {
        lng = selectionPulseAnchor.lng;
        lat = selectionPulseAnchor.lat;
      } else {
        // Non-point with no click anchor: rely on the dashed selected-line/fill styling
        // for highlighting. A bbox-center pulse looked like a stray marker.
        return null;
      }
      return {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [lng, lat] }
          }
        ]
      };
    } catch {
      return null;
    }
  }, [selectedPlace, selectionPulseAnchor]);

  const augmentedGeoJsonLayers = useMemo(
    () =>
      geoJsonLayers.map((layer) => {
        const sourceId = layer.filePath.replace(/[^a-zA-Z0-9]/g, "-");
        // Inject internal marker properties so the click handler can identify which
        // file and which feature index was clicked. These are stripped before the
        // feature properties are shown to the user.
        const features = layer.data.features.map((f, i) => ({
          ...f,
          properties: { ...f.properties, _gjFilePath: layer.filePath, _gjIndex: i }
        }));
        return {
          sourceId,
          filePath: layer.filePath,
          data: { type: "FeatureCollection" as const, features }
        };
      }),
    [geoJsonLayers]
  );

  const handleLayerClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const feats = e.features ?? [];
      const clickMeta: MapSelectPlaceMeta = {
        mapClickLngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat }
      };
      for (const feature of feats) {
        const fp = feature.properties?.filePath;
        if (typeof fp !== "string" || fp.length === 0) continue;
        // Clicking the already-active place is a no-op. Re-firing selection would
        // reset `featureScreenPos` and flicker/close the mini card — and since
        // `selectedPlace` keeps the same ref, the re-projection effect wouldn't
        // fire either, so the card stays hidden until the next map move.
        if (selectedPlace?.filePath === fp) return;
        const place =
          folderPlaces.find((p) => p.filePath === fp) ??
          linkedPlaces.find((p) => p.filePath === fp);
        if (place) {
          onSelectPlace?.(place, clickMeta);
          return;
        }
      }
      for (const feature of feats) {
        const gjFilePath = feature.properties?._gjFilePath;
        const gjIndex = feature.properties?._gjIndex;
        if (typeof gjFilePath === "string" && gjIndex !== undefined && feature.geometry) {
          const { _gjFilePath: _fp, _gjIndex: _idx, ...props } = feature.properties ?? {};
          const title = String(props.name ?? props.title ?? props.Name ?? "Feature");
          onSelectPlace?.(
            {
              filePath: `geojson-feature:${gjFilePath}#${String(gjIndex)}`,
              type: "Preview",
              title,
              geometry: JSON.stringify(feature.geometry),
              previewMarkdown: formatGeoJsonProperties(props)
            },
            clickMeta
          );
          return;
        }
      }
      for (const feature of feats) {
        if (feature.properties?.kind !== "overlay" || !feature.geometry) continue;
        const id = String(feature.properties.overlayId ?? feature.properties.id ?? "overlay");
        const title = (feature.properties.title as string | undefined) ?? "Map overlay";
        const previewMarkdown = (feature.properties.preview_markdown as string | undefined) ?? "";
        try {
          const geometry = feature.geometry as GeoJSONGeometry;
          onSelectPlace?.(placeFromOverlayFeature(geometry, id, title, previewMarkdown), clickMeta);
          return;
        } catch {
          /* invalid */
        }
      }
      onMapClickEmpty?.({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    },
    [folderPlaces, linkedPlaces, selectedPlace, onSelectPlace, onMapClickEmpty]
  );

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = [];
    if (folderGeoJSON) {
      ids.push("folder-circle", "folder-fill", "folder-line", "folder-line-casing");
    }
    if (linkedGeoJSON) {
      ids.push("linked-circle", "linked-fill", "linked-line", "linked-line-casing");
    }
    if (selectedGeoJSON) {
      ids.push("selected-circle", "selected-fill", "selected-line", "selected-line-casing");
    }
    for (const { sourceId } of overlayLayerSources) {
      ids.push(`${sourceId}-polygons`, `${sourceId}-lines-hit`, `${sourceId}-lines`);
    }
    for (const { sourceId } of augmentedGeoJsonLayers) {
      ids.push(`${sourceId}-circle`, `${sourceId}-fill`, `${sourceId}-line`);
    }
    return ids;
  }, [folderGeoJSON, linkedGeoJSON, selectedGeoJSON, overlayLayerSources, augmentedGeoJsonLayers]);

  /** Empty array prevents click handling in some react-map-gl builds; omit to query all layers. */
  const interactiveLayerIdsProp = interactiveLayerIds.length > 0 ? interactiveLayerIds : undefined;

  // Tile style URL is fetched async from main. Render an empty wrapper meanwhile
  // so the layout doesn't shift; MapLibre can't handle a null/empty mapStyle.
  if (!mapStyle) {
    return <div style={{ position: "relative", width: "100%", height: "100%" }} />;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MapGL
        ref={mapRef}
        initialViewState={(() => {
          try {
            const saved = localStorage.getItem("mapos-viewport");
            if (saved)
              return JSON.parse(saved) as { longitude: number; latitude: number; zoom: number };
          } catch {
            // ignore
          }
          return { longitude: 0, latitude: 20, zoom: 2 };
        })()}
        style={{ width: "100%", height: "100%" }}
        mapStyle={mapStyle}
        onLoad={() => sendViewport()}
        onMove={debouncedMove}
        onContextMenu={handleContextMenu}
        interactiveLayerIds={interactiveLayerIdsProp}
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
                "circle-radius": 5,
                "circle-color": ["coalesce", ["get", "color"], "#6b7280"],
                "circle-stroke-width": 2,
                "circle-stroke-color": "#ffffff"
              }}
            />
            <Layer
              id="folder-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{
                "fill-color": ["coalesce", ["get", "color"], "#6b7280"],
                "fill-opacity": 0.25
              }}
            />
            <Layer
              id="folder-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{
                "line-color": ["coalesce", ["get", "color"], "#6b7280"],
                "line-width": 2
              }}
            />
            <Layer
              id="folder-line-casing"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{ "line-color": "rgba(0,0,0,0.55)", "line-width": 5 }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
            <Layer
              id="folder-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{
                "line-color": ["coalesce", ["get", "color"], "#6b7280"],
                "line-width": 3
              }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
          </Source>
        )}
        {linkedGeoJSON && (
          <Source id="linked-geojson" type="geojson" data={linkedGeoJSON}>
            <Layer
              id="linked-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={POINT_FILTER}
              paint={{
                "circle-radius": 5,
                "circle-color": ["coalesce", ["get", "color"], "#6b7280"],
                "circle-stroke-width": 2,
                "circle-stroke-color": "#ffffff"
              }}
            />
            <Layer
              id="linked-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{
                "fill-color": ["coalesce", ["get", "color"], "#6b7280"],
                "fill-opacity": 0.25
              }}
            />
            <Layer
              id="linked-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{
                "line-color": ["coalesce", ["get", "color"], "#6b7280"],
                "line-width": 2
              }}
            />
            <Layer
              id="linked-line-casing"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{ "line-color": "rgba(0,0,0,0.55)", "line-width": 5 }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
            <Layer
              id="linked-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{
                "line-color": ["coalesce", ["get", "color"], "#6b7280"],
                "line-width": 3
              }}
              layout={{ "line-cap": "round", "line-join": "round" }}
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
                "circle-radius": 5,
                "circle-color": ["coalesce", ["get", "color"], foregroundColor],
                "circle-stroke-width": 2.5,
                "circle-stroke-color": "#ffffff"
              }}
            />
            <Layer
              id="selected-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{
                "fill-color": ["coalesce", ["get", "color"], foregroundColor],
                "fill-opacity": 0.35
              }}
            />
            <Layer
              id="selected-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{
                "line-color": ["coalesce", ["get", "color"], foregroundColor],
                "line-width": 2.5
              }}
            />
            <Layer
              id="selected-line-casing"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{ "line-color": "rgba(0,0,0,0.6)", "line-width": 5.5 }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
            <Layer
              id="selected-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{
                "line-color": ["coalesce", ["get", "color"], foregroundColor],
                "line-width": 3
              }}
              layout={{ "line-cap": "round", "line-join": "round" }}
            />
          </Source>
        )}
        {showOverlay &&
          overlayPoints.map((p) => {
            const dimmed = focusedLayerId != null && p.layerId !== focusedLayerId;
            return (
              <Marker key={p.id} longitude={p.lng} latitude={p.lat} anchor="center">
                <button
                  type="button"
                  title={p.title}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onSelectPlace?.(placeFromOverlayPoint(p));
                  }}
                  className="block p-0 m-0 border-0 bg-transparent cursor-pointer"
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    backgroundColor: "#8b5cf6",
                    border: "2px dashed white",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                    opacity: dimmed ? UNFOCUSED_OPACITY : 1,
                    transition: "opacity 120ms ease-out"
                  }}
                />
              </Marker>
            );
          })}
        {augmentedGeoJsonLayers.map(({ sourceId, data }) => (
          // @ts-expect-error - GeoJSON structure is valid; maplibre types are strict
          <Source key={sourceId} id={sourceId} type="geojson" data={data}>
            <Layer
              id={`${sourceId}-circle`}
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={POINT_FILTER}
              paint={{
                "circle-radius": 5,
                "circle-color": "#6b7280",
                "circle-stroke-width": 2,
                "circle-stroke-color": "#ffffff"
              }}
            />
            <Layer
              id={`${sourceId}-fill`}
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{ "fill-color": "#6b7280", "fill-opacity": 0.25 }}
            />
            <Layer
              id={`${sourceId}-fill-outline`}
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={{ "line-color": "#6b7280", "line-width": 2 }}
            />
            <Layer
              id={`${sourceId}-line`}
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={{ "line-color": "#6b7280", "line-width": 2 }}
            />
          </Source>
        ))}
        {showOverlay &&
          overlayLayerSources.map(({ layerId, sourceId, data }) => {
            const o = focusedLayerId != null && layerId !== focusedLayerId ? UNFOCUSED_OPACITY : 1;
            return (
              // @ts-expect-error - GeoJSON structure is valid; maplibre types are strict
              <Source key={sourceId} id={sourceId} type="geojson" data={data}>
                <Layer
                  id={`${sourceId}-polygons`}
                  type="fill"
                  // @ts-expect-error - MapLibre filter expression; types are strict
                  filter={POLYGON_FILTER}
                  paint={{ "fill-color": "#8b5cf6", "fill-opacity": 0.25 * o }}
                />
                <Layer
                  id={`${sourceId}-polygon-outline`}
                  type="line"
                  // @ts-expect-error - MapLibre filter expression
                  filter={POLYGON_FILTER}
                  paint={{
                    "line-color": "#8b5cf6",
                    "line-width": 2,
                    "line-opacity": o,
                    "line-dasharray": [2, 1]
                  }}
                />
                <Layer
                  id={`${sourceId}-lines-hit`}
                  type="line"
                  // @ts-expect-error - MapLibre filter expression
                  filter={LINESTRING_FILTER}
                  paint={{ "line-color": "#000000", "line-opacity": 0, "line-width": 14 }}
                />
                <Layer
                  id={`${sourceId}-lines`}
                  type="line"
                  // @ts-expect-error - MapLibre filter expression
                  filter={LINESTRING_FILTER}
                  paint={{
                    "line-color": "#8b5cf6",
                    "line-width": 2,
                    "line-opacity": o,
                    "line-dasharray": [2, 1]
                  }}
                />
              </Source>
            );
          })}
        {selectionPulseGeoJSON && <SelectionPulseLayers data={selectionPulseGeoJSON} />}
        <RegionCoverageIndicator />
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
          <DropdownMenuItem onClick={() => void handleCreatePlaceFile()}>
            <SquarePenIcon />
            New Note
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

export default MapView;
