import { useDebouncedCallback } from "@renderer/hooks/use-debounced-callback";
import { bbox } from "@turf/bbox";
import type { DataDrivenPropertyValueSpecification, FilterSpecification } from "maplibre-gl";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
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

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { useMapViewport } from "@renderer/contexts/map-viewport";
import { useDarkMode } from "@renderer/hooks/use-dark-mode";
import { useVaultRoot } from "@renderer/hooks/use-vault-root";
import { accentHex, featureDefaultColor, useAccent } from "@renderer/lib/accent";
import type { DrawSession } from "@renderer/lib/draw";
import { useMapColor } from "@renderer/lib/map-color";
import {
  OVERLAY_CHIP_IMAGE_ID,
  OVERLAY_CHIP_PIXEL_RATIO,
  ROUND_LINE_LAYOUT,
  SELECTED_OUTLINE_PAINT,
  drawOverlayChip,
  featureCirclePaint,
  featureFillOutlinePaint,
  featureFillPaint,
  featureLinePaint,
  overlayFillPaint,
  overlayLinePaint,
  routeLinePaint,
  routeStopPaint,
  selectedCirclePaint,
  selectedFillOutlinePaint,
  selectedFillPaint,
  selectedLinePaint
} from "@renderer/lib/map-styles";
import { detailPropertiesFromGeocodeResult, normalizeCategoryToken } from "@shared/geocode-detail";
import type { RouteStop } from "@shared/route";
import type { Geometry } from "geojson";
import { FlagIcon, MapPinPlusIcon, NavigationIcon, SquarePenIcon } from "lucide-react";
import type { MapOverlayLayer, OverlayPoint, PlaceRecord } from "../../../shared/types";
import { DIRECTIONS_OVERLAY_PREFIX } from "../../../shared/types";
import { orderDetailProperties } from "../../../shared/types";
import { DrawLayer } from "./map/draw-layer";
import { RegionCoverageIndicator } from "./map/region-coverage-indicator";
import { type UserLocation, UserLocationLayer } from "./map/user-location-layer";

export type { PlaceRecord };

/**
 * Resolves the active tile style URL via the main-process dispatcher. Returns
 * null on first render and during dark-mode transitions until the IPC settles
 * (sub-millisecond in practice). Callers gate the MapGL render on a non-null
 * value to avoid handing MapLibre an empty string.
 */
function useDarkMapStyle(): string | null {
  const isDark = useDarkMode();
  const mapColor = useMapColor();
  const [styleUrl, setStyleUrl] = useState<string | null>(null);
  // Bumped when packs are added/removed. Re-resolves the style URL and — since the
  // offline style URL (mapos-region://_all/style.json) is stable while its contents
  // change — cache-busts it so react-map-gl/MapLibre actually reload the style.
  const [revision, setRevision] = useState(0);

  useEffect(() => window.api.regions.onChanged(() => setRevision((r) => r + 1)), []);

  useEffect(() => {
    let cancelled = false;
    window.api.services
      .tilesStyleUrl({ isDark, monochrome: mapColor === "monochrome" })
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
  }, [isDark, mapColor, revision]);

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
/** Stable identity so the default doesn't retrigger the stops memo every render. */
const EMPTY_ROUTE_STOPS: RouteStop[] = [];

/** Features other than the focused one (the hovered chat row) dim to this. */
const UNFOCUSED_OPACITY = 0.3;

/**
 * Per-feature opacity for overlay layer sources: the focused feature keeps `base`, every
 * other feature dims. Returns a plain number when nothing is focused so MapLibre can skip
 * the data-driven evaluation entirely.
 */
function overlayFeatureOpacity(
  focusedFeatureId: string | null,
  base: number
): DataDrivenPropertyValueSpecification<number> {
  if (focusedFeatureId == null) return base;
  return ["case", ["==", ["get", "overlayId"], focusedFeatureId], base, base * UNFOCUSED_OPACITY];
}

/** Stable, css-safe source id for an overlay layer (layer ids are tool-call ids). */
function overlaySourceId(layerId: string): string {
  return `overlay-${layerId.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

const MAP_OVERLAY_PREFIX = "map-overlay:";
const MAP_POI_PREFIX = "map-poi:";

/**
 * Basemap POI symbol layers: "pois" in the online styles, "world_pois" /
 * "<region>_pois" in the generated offline style (region slugs are [a-z0-9_-]).
 */
const POI_LAYER_RE = /^(?:[a-z0-9_-]+_)?pois$/i;

/** Symbol hit-boxes are small; pad the click point a few px for comfort. */
const POI_CLICK_PADDING = 4;

/** Coordinate slack when matching a tile POI to a geocoder result (~200m; tile
 * geometry is quantized and OSM ways anchor at a computed centroid). */
const POI_MATCH_MAX_DELTA_DEG = 0.002;

type OsmRef = { type: "node" | "way" | "relation"; id: number };

/**
 * Protomaps basemaps encode the source OSM element in the MVT feature id:
 * `(elementType << 44) | osmId` with 1 = node, 2 = way, 3 = relation.
 */
function decodeOsmFeatureId(featureId: unknown): OsmRef | null {
  if (typeof featureId !== "number" || !Number.isFinite(featureId) || featureId <= 0) return null;
  const TYPE_SHIFT = 2 ** 44;
  const type = (["node", "way", "relation"] as const)[Math.floor(featureId / TYPE_SHIFT) - 1];
  if (!type) return null;
  return { type, id: featureId % TYPE_SHIFT };
}

/**
 * Build the preview place for a clicked basemap POI. The tile feature carries
 * `name`/`kind` plus the source OSM element encoded in its feature id, so
 * reverse-geocode at the POI's location and match the exact same OSM element —
 * then derive the card properties (category, address, osm_id, wikidata_id) with
 * the shared helper so both paths show byte-identical details. Name+proximity
 * is the fallback signal when the geocoder has no OSM ids to compare; the
 * tile's `kind` as `category` is the last resort (no pack coverage, offline,
 * slow network).
 */
async function placeFromPoiFeature(
  name: string,
  kind: string | undefined,
  lng: number,
  lat: number,
  osm: OsmRef | null
): Promise<PlaceRecord> {
  // The tile is itself an authoritative source for category and osm_id, so the
  // fallback card still shares the search card's vocabulary.
  const baseProperties = orderDetailProperties({
    ...(kind ? { category: normalizeCategoryToken(kind) } : {}),
    ...(osm ? { osm_id: `${osm.type}/${osm.id}` } : {})
  });
  const base: PlaceRecord = {
    filePath: `${MAP_POI_PREFIX}${lng},${lat}:${name}`,
    title: name,
    type: "Search",
    geometry: JSON.stringify({ type: "Point", coordinates: [lng, lat] }),
    /** Present (may be empty) so PlaceCard opens in preview mode without reading a file. */
    previewMarkdown: "",
    ...(Object.keys(baseProperties).length > 0 ? { properties: baseProperties } : {})
  };
  try {
    const results = await Promise.race([
      window.api.services.geocodingReverse({
        point: { lat, lng },
        limit: 20,
        // Neighbourhood-ish tile POIs (kind administrative/political) are
        // geocode "place" features, not "poi".
        kinds: ["poi", "place"]
      }),
      // Don't leave the click dead behind a slow cloud request — fall back.
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200))
    ]);
    const norm = (s: string) => s.trim().toLowerCase();
    const match =
      (osm && results?.find((r) => r.osmType === osm.type && r.osmId === osm.id)) ||
      results?.find(
        (r) =>
          norm(r.primaryLabel) === norm(name) &&
          Math.abs(r.lat - lat) < POI_MATCH_MAX_DELTA_DEG &&
          Math.abs(r.lng - lng) < POI_MATCH_MAX_DELTA_DEG
      );
    if (match) {
      const properties = detailPropertiesFromGeocodeResult(match);
      return {
        ...base,
        // The geocoder's coordinates are the authoritative OSM location.
        geometry: JSON.stringify({ type: "Point", coordinates: [match.lng, match.lat] }),
        ...(Object.keys(properties).length > 0 ? { properties } : {})
      };
    }
  } catch {
    /* no geocode provider available */
  }
  return base;
}

function placeFromOverlayPoint(p: OverlayPoint): PlaceRecord {
  return {
    filePath: `${MAP_OVERLAY_PREFIX}${p.id}`,
    title: p.title || "Overlay feature",
    type: "Preview",
    geometry: JSON.stringify({ type: "Point", coordinates: [p.lng, p.lat] }),
    previewMarkdown: p.preview_markdown ?? "",
    ...(p.properties && Object.keys(p.properties).length > 0 ? { properties: p.properties } : {})
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

/**
 * Look up an overlay feature's full geometry by id across all overlay layers.
 * Used to recover geometry that MapLibre clipped to a tile boundary on click.
 */
function findOverlayGeometry(layers: MapOverlayLayer[], id: string): GeoJSONGeometry | null {
  for (const layer of layers) {
    const polygon = layer.polygons.find((pg) => pg.id === id);
    if (polygon) return { type: "Polygon", coordinates: polygon.coordinates };
    const line = layer.lines.find((ln) => ln.id === id);
    if (line) return { type: "LineString", coordinates: line.coordinates };
  }
  return null;
}

/** Look up an overlay point by id across all layers — the point carries its own
 *  properties (category/address/…), so its card is richer than the geometry-only path. */
function findOverlayPoint(layers: MapOverlayLayer[], id: string): OverlayPoint | null {
  for (const layer of layers) {
    const point = layer.points.find((p) => p.id === id);
    if (point) return point;
  }
  return null;
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
  flyTo: (lat: number, lng: number, opts?: { zoom?: number; padding?: FitPadding }) => void;
  fitToFolder: (folderPath: string, padding: FitPadding) => void;
  fitToPlace: (place: PlaceRecord, padding: FitPadding) => void;
  /** Center on a place's geometry while keeping the current zoom (pan, don't zoom in). */
  panToPlace: (place: PlaceRecord, padding: FitPadding) => void;
  fitToPlaceAndLinks: (place: PlaceRecord, links: PlaceRecord[], padding: FitPadding) => void;
  fitToGeoJson: (data: RawFeatureCollection, padding: FitPadding) => void;
  invalidateFolderPlace: (filePath: string) => void;
  /** Current camera zoom, or undefined before the map is ready. */
  getZoom: () => number | undefined;
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

type SelectionAnchorGeoJSON = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
};

/**
 * The selection anchor marker: a dot that pops in and holds a larger size, marking
 * the selected point — or, for a selected line/polygon, the spot the user clicked.
 * An HTML <Marker> (like the overlay/user-location dots) so it animates via CSS and
 * sidesteps the style-churn dance the old canvas pulse needed. The caller keys it on
 * the anchor coords so a fresh selection remounts and replays the pop.
 */
function SelectionMarker({
  data,
  color,
  chip
}: {
  data: SelectionAnchorGeoJSON;
  color: string;
  // When set, render the search-result "poker chip" look (dashed border) instead of the
  // solid selection dot, so an active search result keeps its overlay styling.
  chip?: { fill: string; borderColor: string };
}): React.JSX.Element {
  return (
    <>
      {data.features.map((f) => {
        const [lng, lat] = f.geometry.coordinates;
        // Per-feature `color` (custom-coloured place) wins over the accent default.
        const fill = (f.properties.color as string | undefined) ?? color;
        return (
          <Marker key={`${lng},${lat}`} longitude={lng} latitude={lat} anchor="center">
            <div
              className="animate-selection-pop size-[18px] rounded-full border-2 border-white shadow-md"
              style={
                chip
                  ? {
                      backgroundColor: chip.fill,
                      borderStyle: "dashed",
                      borderColor: chip.borderColor
                    }
                  : { backgroundColor: fill }
              }
            />
          </Marker>
        );
      })}
    </>
  );
}

/**
 * Registers (and keeps registered) the poker-chip icon the overlay point layers reference.
 * Re-rasterized when the accent/theme colours change; the `styleimagemissing` listener
 * covers style reloads, which drop runtime-added images.
 */
function OverlayChipImage({ fill, border }: { fill: string; border: string }): null {
  const { current: mapRef } = useMap();
  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    const add = (): void => {
      const image = drawOverlayChip(fill, border);
      if (map.hasImage(OVERLAY_CHIP_IMAGE_ID)) map.updateImage(OVERLAY_CHIP_IMAGE_ID, image);
      else map.addImage(OVERLAY_CHIP_IMAGE_ID, image, { pixelRatio: OVERLAY_CHIP_PIXEL_RATIO });
    };
    add();
    const onMissing = (e: { id: string }): void => {
      if (e.id === OVERLAY_CHIP_IMAGE_ID) add();
    };
    map.on("styleimagemissing", onMissing);
    return () => {
      map.off("styleimagemissing", onMissing);
    };
  }, [mapRef, fill, border]);
  return null;
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
    /** Overlay feature id to emphasize (the hovered chat row); others dim. Null = all full opacity. */
    focusedFeatureId?: string | null;
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
    /** Vault places presented by chat feature lists; drawn while the chat overlay is shown,
     * since they may lie outside the selected folder. */
    presentedPlaces?: PlaceRecord[];
    /** The still-open file while a map peek is active: rendered in the selected style, but without the pulse. */
    openPlace?: PlaceRecord | null;
    /** Stops of the selected/open place's saved route, drawn along its line. Resolved by the
     *  parent through the places index — a PlaceRecord from a map click is built from a
     *  SQLite row and never carries its route. */
    routeStops?: RouteStop[];
    /** The user's current position (from the top-bar locate control); drawn as a dot + accuracy ring. */
    userLocation?: UserLocation | null;
    /** Coordinates of the directions step currently hovered/selected, drawn as an emphasized
     *  segment on top of the route. Null = nothing highlighted. */
    directionsHighlight?: [number, number][] | null;
    /** Active map-drawing session. While set, the map draws instead of selecting. */
    drawSession?: DrawSession | null;
    /** A draw-mode shape was completed. */
    onDrawFinish?: (geometry: Geometry) => void;
    /** Select-mode geometry changed; App holds it until the user saves. */
    onDrawEditChange?: (geometry: Geometry) => void;
    /** Context-menu routing actions on a bare coordinate. Each opens (or extends) a
     *  directions tab; App owns the label and the tab, so these pass raw coordinates
     *  the same way `onMapClickEmpty` does. An omitted callback hides its menu item —
     *  that's how "Add stop" stays hidden with no directions tab open. */
    onDirectionsFromPoint?: (point: { lat: number; lng: number }) => void;
    onDirectionsToPoint?: (point: { lat: number; lng: number }) => void;
    onAddStopAtPoint?: (point: { lat: number; lng: number }) => void;
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
    focusedFeatureId = null,
    showOverlay = false,
    geoJsonLayers = [],
    selectionPulseAnchor = null,
    linkedPlaces = [],
    presentedPlaces = [],
    openPlace = null,
    routeStops = EMPTY_ROUTE_STOPS,
    userLocation = null,
    directionsHighlight = null,
    drawSession = null,
    onDrawFinish,
    onDrawEditChange,
    onDirectionsFromPoint,
    onDirectionsToPoint,
    onAddStopAtPoint
  },
  ref
) {
  const mapRef = useRef<MapRef>(null);
  const { setViewportBBox } = useMapViewport();
  const mapStyle = useDarkMapStyle();
  // Camera position is vault state — scope the persisted viewport per vault.
  const vaultRoot = useVaultRoot();
  const viewportKey = vaultRoot ? `mapos-viewport:${vaultRoot}` : null;
  const isDark = useDarkMode();
  const foregroundColor = isDark ? "#fafafa" : "#252525";
  const accent = useAccent();
  // Default colour for features with no explicit `color`: the accent hue (grey when monochrome).
  const featureColor = featureDefaultColor(accent);
  // Accent hue for selection + chat overlays; falls back to the theme foreground when monochrome.
  const accentColor = accentHex(accent);
  const overlayColor = accentColor ?? foregroundColor;
  // Poker-chip rim for ephemeral points (symbol-layer icon + HTML selection chip): white
  // dashes on the accent disk; monochrome dark mode flips to near-black for contrast.
  const chipBorderColor = accentColor ? "#ffffff" : isDark ? "#111111" : "#ffffff";

  const selectedFolderRef = useRef<string | null>(null);
  selectedFolderRef.current = selectedFolder ?? null;

  // Terra Draw consumes the pointer events it cares about, but MapLibre still
  // dispatches click/contextmenu to our handlers. Read through a ref so the
  // guard costs nothing in the (memoized) handlers' dependency lists.
  const drawingRef = useRef(false);
  drawingRef.current = drawSession !== null;

  /** The file whose geometry the session is about to replace. Its normal rendering is
   *  suppressed for the duration: in a "select" session Terra Draw owns an editable copy
   *  and the user would otherwise drag one shape while a twin sat under it, and in a draw
   *  session the shape being drawn *is* the replacement, so leaving the old one up reads
   *  as adding a second geometry to a place that can only hold one. Cancelling clears the
   *  session, which brings the original straight back. */
  const editingFilePath = drawSession?.filePath ?? null;

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    lat: number;
    lng: number;
  } | null>(null);

  const [folderPlaces, setFolderPlaces] = useState<PlaceRecord[]>([]);

  const onSelectedFeaturePositionRef = useRef(onSelectedFeaturePosition);
  onSelectedFeaturePositionRef.current = onSelectedFeaturePosition;
  const selectedPlaceRef = useRef(selectedPlace);
  selectedPlaceRef.current = selectedPlace;

  /** Card anchor in map coordinates: the click position when one exists (lines/polygons),
   * matching the selection pulse, otherwise the geometry's bbox center. Computed once per
   * selection change — `onMove` fires per frame during pan, so the parse/bbox must not
   * run there. */
  const selectedCenter = useMemo<[number, number] | null>(() => {
    if (!selectedPlace?.geometry) return null;
    if (selectionPulseAnchor && selectionPulseAnchor.filePath === selectedPlace.filePath) {
      return [selectionPulseAnchor.lng, selectionPulseAnchor.lat];
    }
    try {
      return getGeometryCenter(parseGeometry(selectedPlace.geometry));
    } catch {
      return null;
    }
  }, [selectedPlace, selectionPulseAnchor]);
  const selectedCenterRef = useRef(selectedCenter);
  selectedCenterRef.current = selectedCenter;

  const emitFeaturePosition = useCallback(() => {
    const map = mapRef.current;
    const center = selectedCenterRef.current;
    const cb = onSelectedFeaturePositionRef.current;
    if (!map || !center || !cb) return;
    const pt = map.project(center);
    cb(pt.x, pt.y);
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
      getZoom: () => mapRef.current?.getZoom(),
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
      panToPlace: (place: PlaceRecord, padding: FitPadding) => {
        const map = mapRef.current;
        if (!map || !place.geometry) return;
        let center: [number, number];
        try {
          center = getGeometryCenter(parseGeometry(place.geometry));
        } catch {
          return; /* invalid geometry */
        }
        // Skip the pan if the target already sits inside the visible area — i.e. within
        // the viewport minus the sidebar/pane padding. project() reflects the point's
        // real on-screen pixel, so this honours the current camera exactly.
        const { x, y } = map.project(center);
        const { clientWidth: w, clientHeight: h } = map.getContainer();
        const inView =
          x >= padding.left &&
          x <= w - padding.right &&
          y >= padding.top &&
          y <= h - padding.bottom;
        if (inView) return;
        // Otherwise pan (keeping zoom); the padding offsets the center clear of the sidebars.
        map.flyTo({ center, zoom: map.getZoom(), duration: 600, padding });
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
    if (viewportKey) {
      localStorage.setItem(
        viewportKey,
        JSON.stringify({ longitude: center.lng, latitude: center.lat, zoom })
      );
    }
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

  // Re-project when the selection's anchor point changes (emit reads the ref; this still triggers)
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedCenter
  useEffect(() => {
    emitFeaturePosition();
  }, [selectedCenter, emitFeaturePosition]);

  const handleContextMenu = useCallback((e: MapLayerMouseEvent) => {
    e.preventDefault();
    if (drawingRef.current) return;
    setContextMenu({
      x: e.point.x,
      y: e.point.y,
      lat: e.lngLat.lat,
      lng: e.lngLat.lng
    });
  }, []);

  /** Close the menu and hand the right-clicked coordinate to a routing action. */
  const runAtContextPoint = useCallback(
    (fn: (point: { lat: number; lng: number }) => void) => {
      if (!contextMenu) return;
      const { lat, lng } = contextMenu;
      setContextMenu(null);
      fn({ lat, lng });
    },
    [contextMenu]
  );

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
            | { type: "Point"; coordinates: [number, number] }
            | { type: "LineString"; coordinates: [number, number][] }
            | { type: "Polygon"; coordinates: [number, number][][] };
          properties: Record<string, unknown>;
        }> = [];
        for (const pt of l.points) {
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [pt.lng, pt.lat] },
            properties: {
              kind: "overlay",
              overlayId: pt.id,
              title: pt.title,
              preview_markdown: pt.preview_markdown
            }
          });
        }
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
          data: features.length > 0 ? { type: "FeatureCollection" as const, features } : null
        };
      })
      .filter((s): s is typeof s & { data: NonNullable<(typeof s)["data"]> } => s.data != null);
  }, [overlayLayers]);

  // The hovered/selected directions step as a single LineString, drawn emphasized on top of
  // the route. Null when nothing is highlighted (so the source/layers unmount).
  const directionsHighlightGeoJSON = useMemo(() => {
    if (!directionsHighlight || directionsHighlight.length === 0) return null;
    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: directionsHighlight },
          properties: {}
        }
      ]
    };
  }, [directionsHighlight]);

  const toFeature = useCallback((p: PlaceRecord & { geometry: string }) => {
    return {
      type: "Feature" as const,
      geometry: parseGeometry(p.geometry),
      // Leave `color` undefined when unset so each layer can pick its own default
      // (lines need white; circles/polygons stay gray).
      properties: { filePath: p.filePath, color: p.color }
    };
  }, []);

  // All folder places as one source. The selected/open place stays in the data and is
  // hidden per-layer via `unselectedFilters` — rebuilding the collection on selection
  // change would re-parse every geometry and re-upload the whole source to MapLibre.
  const folderGeoJSON = useMemo(() => {
    const places = folderPlaces.filter((p): p is PlaceRecord & { geometry: string } =>
      Boolean(p.geometry)
    );
    if (places.length === 0) return null;
    try {
      return { type: "FeatureCollection" as const, features: places.map(toFeature) };
    } catch {
      return null;
    }
  }, [folderPlaces, toFeature]);

  // Wikilink-target places for the currently-open file
  const linkedGeoJSON = useMemo(() => {
    const places = linkedPlaces.filter((p): p is PlaceRecord & { geometry: string } =>
      Boolean(p.geometry)
    );
    if (places.length === 0) return null;
    try {
      return { type: "FeatureCollection" as const, features: places.map(toFeature) };
    } catch {
      return null;
    }
  }, [linkedPlaces, toFeature]);

  // Chat-presented vault places, excluding any place another source already draws
  // (folder, wikilinks) to avoid double markers.
  const presentedGeoJSON = useMemo(() => {
    const drawn = new Set([...folderPlaces, ...linkedPlaces].map((p) => p.filePath));
    const places = presentedPlaces
      .filter((p) => !drawn.has(p.filePath))
      .filter((p): p is PlaceRecord & { geometry: string } => Boolean(p.geometry));
    if (places.length === 0) return null;
    try {
      return { type: "FeatureCollection" as const, features: places.map(toFeature) };
    } catch {
      return null;
    }
  }, [presentedPlaces, folderPlaces, linkedPlaces, toFeature]);

  // Hide the selected/open place in the shared sources so it renders only in the
  // selected source's style. Selection changes then cost a setFilter per layer
  // instead of a setData per source.
  const unselectedFilters = useMemo(() => {
    const excluded = [selectedPlace?.filePath, openPlace?.filePath].filter((p): p is string =>
      Boolean(p)
    );
    if (excluded.length === 0) {
      return { point: POINT_FILTER, polygon: POLYGON_FILTER, line: LINESTRING_FILTER };
    }
    const notSelected = ["!", ["in", ["get", "filePath"], ["literal", excluded]]];
    return {
      point: ["all", POINT_FILTER, notSelected],
      polygon: ["all", POLYGON_FILTER, notSelected],
      line: ["all", LINESTRING_FILTER, notSelected]
    };
  }, [selectedPlace?.filePath, openPlace?.filePath]);

  // Selected place as its own source for distinct styling. While a peek is active,
  // the still-open file renders here too — same style, but only the selected place
  // gets the animated grow marker (selectionAnchorGeoJSON below).
  const selectedGeoJSON = useMemo(() => {
    const places = [selectedPlace, openPlace]
      .filter((p): p is PlaceRecord & { geometry: string } => Boolean(p?.geometry))
      .filter((p) => p.filePath !== editingFilePath)
      .filter((p, i, arr) => arr.findIndex((q) => q.filePath === p.filePath) === i);
    if (places.length === 0) return null;
    try {
      return { type: "FeatureCollection" as const, features: places.map(toFeature) };
    } catch {
      return null;
    }
  }, [selectedPlace, openPlace, editingFilePath, toFeature]);

  /** The selected route's stops. Suppressed with the rest of the file's rendering while a
   *  draw session is about to replace its geometry — otherwise the line disappears for the
   *  session but its stops stay behind, reading as a second, stranded feature. */
  const routeStopsGeoJSON = useMemo(() => {
    if (routeStops.length === 0) return null;
    if (selectedPlace?.filePath === editingFilePath) return null;
    return {
      type: "FeatureCollection" as const,
      features: routeStops.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
        properties: {}
      }))
    };
  }, [routeStops, selectedPlace?.filePath, editingFilePath]);

  /** Anchor position: Points use geometry; lines/polygons anchor where the user clicked. */
  const selectionAnchorGeoJSON = useMemo((): SelectionAnchorGeoJSON | null => {
    if (!selectedPlace?.geometry) return null;
    if (selectedPlace.filePath === editingFilePath) return null;
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
        // Non-point with no click anchor: rely on the accent-glow selected-line/fill styling
        // for highlighting. A bbox-center pulse looked like a stray marker.
        return null;
      }
      return {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            // Carry the feature colour so the marker circle matches a custom-coloured feature.
            properties: selectedPlace.color ? { color: selectedPlace.color } : {},
            geometry: { type: "Point", coordinates: [lng, lat] }
          }
        ]
      };
    } catch {
      return null;
    }
  }, [selectedPlace, selectionPulseAnchor, editingFilePath]);

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

  // Bumped on every map click so an in-flight POI reverse-geocode from a
  // previous click can't override a newer selection when it resolves late.
  const mapClickSeqRef = useRef(0);

  const handleLayerClick = useCallback(
    (e: MapLayerMouseEvent) => {
      // While drawing, a map click is a vertex — never a selection.
      if (drawingRef.current) return;
      mapClickSeqRef.current += 1;
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
          linkedPlaces.find((p) => p.filePath === fp) ??
          presentedPlaces.find((p) => p.filePath === fp) ??
          (openPlace?.filePath === fp ? openPlace : undefined);
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
          // A point carries its own properties (category/address/…) — build its card from
          // the source point so those survive; MapLibre feature.properties are stringified.
          const point = findOverlayPoint(overlayLayers, id);
          if (point) {
            onSelectPlace?.(placeFromOverlayPoint(point), clickMeta);
            return;
          }
          // MapLibre clips `feature.geometry` to the vector tile the click landed
          // in, so a polygon spanning multiple tiles comes back as just the clicked
          // tile's slice. Recover the full, unclipped geometry from the source data
          // by id; only fall back to the clipped geometry if no match is found.
          const geometry =
            findOverlayGeometry(overlayLayers, id) ?? (feature.geometry as GeoJSONGeometry);
          onSelectPlace?.(placeFromOverlayFeature(geometry, id, title, previewMarkdown), clickMeta);
          return;
        } catch {
          /* invalid */
        }
      }
      // Basemap POI symbols. Their layer ids vary per style (and per downloaded
      // region pack), so they can't be listed in interactiveLayerIds — query the
      // rendered features around the click instead. Vault/overlay features above
      // always win; POIs only fill what would otherwise be an empty click.
      const map = mapRef.current?.getMap();
      if (map) {
        const { x, y } = e.point;
        const hits = map.queryRenderedFeatures([
          [x - POI_CLICK_PADDING, y - POI_CLICK_PADDING],
          [x + POI_CLICK_PADDING, y + POI_CLICK_PADDING]
        ]);
        for (const f of hits) {
          if (!POI_LAYER_RE.test(f.layer.id) || f.geometry.type !== "Point") continue;
          const props = f.properties ?? {};
          const name = [props["name:en"], props.name].find(
            (v): v is string => typeof v === "string" && v.length > 0
          );
          if (!name) continue; // unnamed POI: icon only, nothing to show on a card
          const [lng, lat] = f.geometry.coordinates as [number, number];
          const kind = typeof props.kind === "string" && props.kind ? props.kind : undefined;
          const osm = decodeOsmFeatureId(f.id);
          const token = mapClickSeqRef.current;
          void placeFromPoiFeature(name, kind, lng, lat, osm).then((place) => {
            if (mapClickSeqRef.current !== token) return; // superseded by a newer click
            // Same no-op guard as vault places: re-selecting flickers the mini card.
            if (selectedPlaceRef.current?.filePath === place.filePath) return;
            onSelectPlace?.(place, clickMeta);
          });
          return;
        }
      }
      onMapClickEmpty?.({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    },
    [
      folderPlaces,
      linkedPlaces,
      presentedPlaces,
      selectedPlace,
      openPlace,
      overlayLayers,
      onSelectPlace,
      onMapClickEmpty
    ]
  );

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = [];
    if (folderGeoJSON) {
      ids.push("folder-circle", "folder-fill", "folder-line");
    }
    if (linkedGeoJSON) {
      ids.push("linked-circle", "linked-fill", "linked-line");
    }
    if (showOverlay && presentedGeoJSON) {
      ids.push("presented-circle", "presented-fill", "presented-line");
    }
    if (selectedGeoJSON) {
      ids.push("selected-circle", "selected-fill", "selected-line");
    }
    for (const { sourceId } of overlayLayerSources) {
      ids.push(
        `${sourceId}-polygons`,
        `${sourceId}-lines-hit`,
        `${sourceId}-lines`,
        `${sourceId}-points`
      );
    }
    for (const { sourceId } of augmentedGeoJsonLayers) {
      ids.push(`${sourceId}-circle`, `${sourceId}-fill`, `${sourceId}-line`);
    }
    return ids;
  }, [
    folderGeoJSON,
    linkedGeoJSON,
    presentedGeoJSON,
    showOverlay,
    selectedGeoJSON,
    overlayLayerSources,
    augmentedGeoJsonLayers
  ]);

  /** Empty array prevents click handling in some react-map-gl builds; omit to query all layers. */
  const interactiveLayerIdsProp = interactiveLayerIds.length > 0 ? interactiveLayerIds : undefined;

  // Tile style URL and vault root are fetched async from main. Render an empty
  // wrapper meanwhile so the layout doesn't shift; MapLibre can't handle a
  // null/empty mapStyle, and the initial viewport needs the vault-scoped key.
  if (!mapStyle || !viewportKey) {
    return <div style={{ position: "relative", width: "100%", height: "100%" }} />;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MapGL
        ref={mapRef}
        initialViewState={(() => {
          try {
            // Fall back to the pre-scoping key once so the camera survives the
            // upgrade, then drop it — unscoped state leaks across vaults.
            const saved =
              localStorage.getItem(viewportKey) ?? localStorage.getItem("mapos-viewport");
            localStorage.removeItem("mapos-viewport");
            if (saved)
              return JSON.parse(saved) as { longitude: number; latitude: number; zoom: number };
          } catch {
            // ignore
          }
          return { longitude: 0, latitude: 20, zoom: 2 };
        })()}
        id="main"
        style={{ width: "100%", height: "100%" }}
        mapStyle={mapStyle}
        // Keep the map top-down: rotation stays (the compass reflects it) but tilt is off.
        maxPitch={0}
        touchPitch={false}
        // Default attribution is re-rendered as a ghost control in MapControls, to
        // match the rest of the cluster instead of MapLibre's dark chip.
        attributionControl={false}
        onLoad={() => sendViewport()}
        onMove={debouncedMove}
        onContextMenu={handleContextMenu}
        interactiveLayerIds={interactiveLayerIdsProp}
        onClick={handleLayerClick}
      >
        <OverlayChipImage fill={overlayColor} border={chipBorderColor} />
        {folderGeoJSON && (
          <Source id="folder-geojson" type="geojson" data={folderGeoJSON}>
            <Layer
              id="folder-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.polygon}
              paint={featureFillPaint(featureColor)}
            />
            <Layer
              id="folder-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.polygon}
              paint={featureFillOutlinePaint(featureColor)}
            />
            <Layer
              id="folder-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.line}
              paint={featureLinePaint(featureColor)}
              layout={ROUND_LINE_LAYOUT}
            />
            <Layer
              id="folder-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.point}
              paint={featureCirclePaint(featureColor)}
            />
          </Source>
        )}
        {linkedGeoJSON && (
          <Source id="linked-geojson" type="geojson" data={linkedGeoJSON}>
            <Layer
              id="linked-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.polygon}
              paint={featureFillPaint(featureColor)}
            />
            <Layer
              id="linked-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.polygon}
              paint={featureFillOutlinePaint(featureColor)}
            />
            <Layer
              id="linked-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.line}
              paint={featureLinePaint(featureColor)}
              layout={ROUND_LINE_LAYOUT}
            />
            <Layer
              id="linked-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.point}
              paint={featureCirclePaint(featureColor)}
            />
          </Source>
        )}
        {showOverlay && presentedGeoJSON && (
          <Source id="presented-geojson" type="geojson" data={presentedGeoJSON}>
            <Layer
              id="presented-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.polygon}
              paint={featureFillPaint(featureColor)}
            />
            <Layer
              id="presented-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.polygon}
              paint={featureFillOutlinePaint(featureColor)}
            />
            <Layer
              id="presented-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.line}
              paint={featureLinePaint(featureColor)}
              layout={ROUND_LINE_LAYOUT}
            />
            <Layer
              id="presented-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.point}
              paint={featureCirclePaint(featureColor)}
            />
          </Source>
        )}
        {selectedGeoJSON && (
          <Source id="selected-geojson" type="geojson" data={selectedGeoJSON}>
            <Layer
              id="selected-fill"
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={selectedFillPaint(featureColor)}
            />
            {/* White outline beneath the accent boundary — the polygon selection highlight. Miter
                joins (no round layout) to match the accent outline's corners. */}
            <Layer
              id="selected-fill-highlight"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={SELECTED_OUTLINE_PAINT}
            />
            <Layer
              id="selected-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={selectedFillOutlinePaint(featureColor)}
            />
            {/* White outline beneath the accent line — the line selection highlight. */}
            <Layer
              id="selected-line-highlight"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={SELECTED_OUTLINE_PAINT}
              layout={ROUND_LINE_LAYOUT}
            />
            <Layer
              id="selected-line"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={selectedLinePaint(featureColor)}
              layout={ROUND_LINE_LAYOUT}
            />
            {/* The selected place's own point is drawn by the animated SelectionMarker;
                exclude it here so they don't stack. A peeked (open) place keeps this
                static selected circle. */}
            <Layer
              id="selected-circle"
              type="circle"
              filter={
                [
                  "all",
                  POINT_FILTER,
                  ["!=", ["get", "filePath"], selectedPlace?.filePath ?? ""]
                ] as unknown as FilterSpecification
              }
              paint={selectedCirclePaint(featureColor)}
            />
          </Source>
        )}
        {/* After the selected source so the stops sit on top of their own route line. */}
        {routeStopsGeoJSON && (
          <Source id="route-stops-geojson" type="geojson" data={routeStopsGeoJSON}>
            <Layer id="route-stops" type="circle" paint={routeStopPaint(featureColor)} />
          </Source>
        )}
        {augmentedGeoJsonLayers.map(({ sourceId, data }) => (
          // @ts-expect-error - GeoJSON structure is valid; maplibre types are strict
          <Source key={sourceId} id={sourceId} type="geojson" data={data}>
            <Layer
              id={`${sourceId}-fill`}
              type="fill"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={featureFillPaint(featureColor)}
            />
            <Layer
              id={`${sourceId}-fill-outline`}
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={featureFillOutlinePaint(featureColor)}
            />
            <Layer
              id={`${sourceId}-line`}
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={LINESTRING_FILTER}
              paint={featureLinePaint(featureColor)}
              layout={ROUND_LINE_LAYOUT}
            />
            <Layer
              id={`${sourceId}-circle`}
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={POINT_FILTER}
              paint={featureCirclePaint(featureColor)}
            />
          </Source>
        ))}
        {showOverlay &&
          overlayLayerSources.map(({ layerId, sourceId, data }) => {
            const fillOpacity = overlayFeatureOpacity(focusedFeatureId, 0.25);
            const lineOpacity = overlayFeatureOpacity(focusedFeatureId, 1);
            const isRoute = layerId.startsWith(DIRECTIONS_OVERLAY_PREFIX);
            return (
              <Source key={sourceId} id={sourceId} type="geojson" data={data}>
                <Layer
                  id={`${sourceId}-polygons`}
                  type="fill"
                  // @ts-expect-error - MapLibre filter expression; types are strict
                  filter={POLYGON_FILTER}
                  paint={overlayFillPaint(overlayColor, fillOpacity)}
                />
                <Layer
                  id={`${sourceId}-polygon-outline`}
                  type="line"
                  // @ts-expect-error - MapLibre filter expression
                  filter={POLYGON_FILTER}
                  paint={overlayLinePaint(overlayColor, lineOpacity)}
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
                  paint={
                    isRoute
                      ? routeLinePaint(overlayColor, lineOpacity)
                      : overlayLinePaint(overlayColor, lineOpacity)
                  }
                  layout={isRoute ? ROUND_LINE_LAYOUT : {}}
                />
                {/* Overlay points as a symbol layer with the rasterized poker-chip icon (not
                    HTML markers) so a large result set stays cheap — one WebGL layer draws
                    thousands. The icon is registered by OverlayChipImage above. */}
                <Layer
                  id={`${sourceId}-points`}
                  type="symbol"
                  // @ts-expect-error - MapLibre filter expression
                  filter={POINT_FILTER}
                  layout={{
                    "icon-image": OVERLAY_CHIP_IMAGE_ID,
                    "icon-allow-overlap": true,
                    "icon-ignore-placement": true
                  }}
                  paint={{ "icon-opacity": lineOpacity }}
                />
              </Source>
            );
          })}
        {directionsHighlightGeoJSON && (
          <Source id="directions-highlight" type="geojson" data={directionsHighlightGeoJSON}>
            {/* White casing under the accent line so the emphasized step pops off the
                same-colored route beneath it. */}
            <Layer
              id="directions-highlight-casing"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": isDark ? "#111111" : "#ffffff",
                "line-width": 9,
                "line-opacity": 0.9
              }}
            />
            <Layer
              id="directions-highlight-line"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{ "line-color": accentColor ?? foregroundColor, "line-width": 5 }}
            />
          </Source>
        )}
        {selectionAnchorGeoJSON && (
          <SelectionMarker
            data={selectionAnchorGeoJSON}
            color={featureColor}
            chip={
              selectedPlace?.filePath.startsWith(MAP_OVERLAY_PREFIX)
                ? { fill: overlayColor, borderColor: chipBorderColor }
                : undefined
            }
          />
        )}
        <RegionCoverageIndicator />
        {userLocation && <UserLocationLayer location={userLocation} />}
        {drawSession && (
          // Keyed on the session so switching shape or target file rebuilds Terra
          // Draw from scratch rather than mutating a half-finished drawing.
          <DrawLayer
            key={`${drawSession.filePath}:${drawSession.mode}`}
            session={drawSession}
            color={featureColor}
            onFinish={(geometry) => onDrawFinish?.(geometry)}
            onEditChange={(geometry) => onDrawEditChange?.(geometry)}
          />
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
          {onDirectionsFromPoint && (
            <DropdownMenuItem onClick={() => runAtContextPoint(onDirectionsFromPoint)}>
              <NavigationIcon />
              Directions from here
            </DropdownMenuItem>
          )}
          {onDirectionsToPoint && (
            <DropdownMenuItem onClick={() => runAtContextPoint(onDirectionsToPoint)}>
              <FlagIcon />
              Directions to here
            </DropdownMenuItem>
          )}
          {onAddStopAtPoint && (
            <DropdownMenuItem onClick={() => runAtContextPoint(onAddStopAtPoint)}>
              <MapPinPlusIcon />
              Add stop
            </DropdownMenuItem>
          )}
          {(onDirectionsFromPoint || onDirectionsToPoint || onAddStopAtPoint) && (
            <DropdownMenuSeparator />
          )}
          <DropdownMenuItem onClick={() => void handleCreatePlaceFile()}>
            <SquarePenIcon />
            New Note
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

// Memoized: App re-renders per frame while a mini card tracks the map (featureScreenPos),
// and on every chat-stream membership change; the map only needs to render when its own
// props change.
export default memo(MapView);
