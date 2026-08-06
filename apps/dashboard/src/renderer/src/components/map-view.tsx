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
  CLICKED_FILTER,
  CLICKED_PROPERTY,
  EMOJI_PIN_PIXEL_RATIO,
  EMOJI_PROPERTY,
  HAS_EMOJI_FILTER,
  NO_EMOJI_FILTER,
  OVERLAY_CHIP_IMAGE_ID,
  OVERLAY_CHIP_PIXEL_RATIO,
  ROUND_LINE_LAYOUT,
  ROUTE_ARROW_IMAGE_ID,
  ROUTE_ARROW_LAYOUT,
  ROUTE_ARROW_PIXEL_RATIO,
  ROUTE_DESTINATION_IMAGE_ID,
  ROUTE_DESTINATION_LAYOUT,
  ROUTE_DESTINATION_PIXEL_RATIO,
  ROUTE_STOP_SIZE,
  ROUTE_STOP_STROKE,
  SELECTED_EMOJI_PIN_SIZE,
  SELECTED_OUTLINE_PAINT,
  drawEmojiPin,
  drawOverlayChip,
  drawRouteArrow,
  drawRouteDestination,
  emojiIcon,
  emojiPinDataUrl,
  emojiPinLayout,
  featureCirclePaint,
  featureFillOutlinePaint,
  featureFillPaint,
  featureLinePaint,
  normalizeFeatureColor,
  overlayFillPaint,
  overlayLinePaint,
  parseEmojiPinImageId,
  routeArrowPaint,
  routeLinePaint,
  routeStopPaint,
  selectedCirclePaint,
  selectedEmojiPinHaloPaint,
  selectedFillOutlinePaint,
  selectedFillPaint,
  selectedLinePaint
} from "@renderer/lib/map-styles";
import {
  type LngLat,
  type RouteDragEdit,
  insertionIndexForSegment,
  snapToPolyline,
  stopVertexIndices
} from "@renderer/lib/route-drag";
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

/** How near the route line the pointer has to be for its drag handle to appear. The invisible
 *  hit line is already 14px wide, so this only softens the edge. */
const ROUTE_HANDLE_PADDING = 2;

/** Diameter of the invisible grab target over each route stop, and the matching radius within
 *  which the line stops offering a *new* stop — inside it, the gesture belongs to the stop
 *  that's already there. Keep the two in step: a gap between them is a dead ring where
 *  neither the stop nor the line answers the pointer. */
const ROUTE_STOP_GRAB_SIZE = 20;
const ROUTE_STOP_GRAB_RADIUS = ROUTE_STOP_GRAB_SIZE / 2;

/** Where the two kinds of route handle overlap, moving the stop that's already there beats
 *  adding another one beside it. */
const ROUTE_HANDLE_Z = { newStop: 1, existingStop: 2 };

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
    // Carried through so the card's header glyph and the selection marker match the pin that was
    // clicked — without this, clicking an emoji stop pops a plain disk over its own emoji.
    ...(p.icon ? { icon: p.icon } : {}),
    ...(p.color ? { color: p.color } : {}),
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

/** Feature property marking a route's final stop, which draws as the chequered destination
 *  icon instead of another stop dot. */
const DESTINATION_PROPERTY = "isDestination";
const DESTINATION_FILTER = ["==", ["get", DESTINATION_PROPERTY], true];
const NOT_DESTINATION_FILTER = ["!=", ["get", DESTINATION_PROPERTY], true];

/** Feature property marking a vault line that is a saved route, so it gets direction arrows
 *  while a hand-drawn line doesn't. */
const ROUTE_PROPERTY = "isRoute";
const ROUTE_LINE_FILTER = [
  "all",
  LINESTRING_FILTER,
  ["==", ["get", ROUTE_PROPERTY], true]
] as unknown as FilterSpecification;

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
export type SelectionPulseAnchor = {
  filePath: string;
  lng: number;
  lat: number;
  /**
   * Draw the anchor dot. False for a saved route: its stops are already drawn as circles along
   * its line, so one more dot there reads as another stop rather than "you clicked here". The
   * anchor still positions the place card either way.
   */
  showDot: boolean;
};

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

/**
 * What the animated anchor marker stands for:
 * - `place` — the selected place's own point, drawn as the place marker.
 * - `click` — the spot the user clicked on a line/polygon, drawn as a small neutral dot.
 */
type SelectionAnchor = {
  kind: "place" | "click";
  lng: number;
  lat: number;
  /** The place's own `color` frontmatter, when set (points only). */
  color?: string;
  /** The place's own `icon` emoji, when set — already through `emojiIcon` (points only). */
  icon?: string;
};

/**
 * The selected point's marker: a dot that pops in and holds a larger size. An HTML <Marker>
 * (like the overlay/user-location dots) so it animates via CSS and sidesteps the style-churn
 * dance the old canvas pulse needed. The caller keys it on the anchor coords so a fresh
 * selection remounts and replays the pop.
 */
function SelectionMarker({
  anchor,
  color,
  chip,
  stop
}: {
  anchor: SelectionAnchor;
  color: string;
  // When set, render the search-result "poker chip" look (dashed border) instead of the
  // solid selection dot, so an active search result keeps its overlay styling.
  chip?: { fill: string; borderColor: string };
  // A clicked route stop. Same exemption as `routeStopPaint`: a route is ephemeral but draws
  // solid, so the marker matches the dot it replaces instead of putting a big dashed chip on
  // a solid line. Wins over `chip` — a stop is an overlay point, so both would otherwise apply.
  stop?: { fill: string; borderColor: string };
}): React.JSX.Element {
  // Per-feature `color` (custom-coloured place) wins over the accent default.
  const fill = anchor.color ?? color;
  if (stop) {
    return (
      <Marker longitude={anchor.lng} latitude={anchor.lat} anchor="center">
        <div
          className="animate-selection-pop rounded-full shadow-md"
          style={{
            width: ROUTE_STOP_SIZE,
            height: ROUTE_STOP_SIZE,
            backgroundColor: stop.fill,
            border: `${ROUTE_STOP_STROKE}px solid ${stop.borderColor}`
          }}
        />
      </Marker>
    );
  }
  // A vault place with an emoji: literally the same raster the symbol layer draws, scaled up to
  // the selected size, so nothing shifts as selection moves between places. Drawn rather than
  // styled because CSS can only centre the glyph's line box — see `VaultFileIcon`. Ordered after
  // `chip`/`stop` — those are overlay/route points, which carry no icon.
  if (anchor.icon) {
    return (
      <Marker longitude={anchor.lng} latitude={anchor.lat} anchor="center">
        <img
          src={emojiPinDataUrl(anchor.icon, fill)}
          alt=""
          draggable={false}
          className="animate-selection-pop rounded-full shadow-md"
          style={{ width: SELECTED_EMOJI_PIN_SIZE, height: SELECTED_EMOJI_PIN_SIZE }}
        />
      </Marker>
    );
  }
  return (
    <Marker longitude={anchor.lng} latitude={anchor.lat} anchor="center">
      <div
        className="animate-selection-pop size-[18px] rounded-full border-2 border-white shadow-md"
        style={
          chip
            ? { backgroundColor: chip.fill, borderStyle: "dashed", borderColor: chip.borderColor }
            : { backgroundColor: fill }
        }
      />
    </Marker>
  );
}

/**
 * Where the user clicked a line or polygon. Deliberately *not* the place-marker look — it marks
 * a spot on a feature, not a place of its own — so it's a small dot in the theme foreground,
 * which reads on either basemap.
 */
function ClickAnchorMarker({
  anchor,
  color
}: {
  anchor: SelectionAnchor;
  color: string;
}): React.JSX.Element {
  return (
    <Marker longitude={anchor.lng} latitude={anchor.lat} anchor="center">
      <div
        className="animate-selection-pop size-2.5 rounded-full shadow-sm"
        style={{ backgroundColor: color }}
      />
    </Marker>
  );
}

/**
 * A grab point on a directions route: the spot on a leg the pointer is hovering (dragging it
 * drops a new stop there) or an existing stop being moved. A MapLibre draggable marker, so it
 * owns the pointer for the duration and the map doesn't pan out from under the drag.
 *
 * `children` carries the look — a visible dot for the point being dragged, an invisible target
 * over a stop that already draws its own chip.
 *
 * `point` MUST follow the drag. The marker is controlled: react-maplibre re-asserts
 * `setLngLat(point)` during render, so a fixed `point` fights MapLibre's own drag positioning
 * every time a drag frame re-renders — which tears the gesture down mid-drag and never fires
 * `dragend`. Feeding the dragged position straight back is the library's contract.
 */
function RouteDragHandle({
  point,
  zIndex,
  onDragStart,
  onDrag,
  onDrop,
  children
}: {
  point: LngLat;
  /** Stacking against the other handles. MapLibre appends each marker's element as it is
   *  *created*, so document order is creation order — a JSX reorder can't decide which handle
   *  takes a press where two overlap. Only an explicit z-index can. */
  zIndex: number;
  onDragStart: () => void;
  onDrag: (point: LngLat) => void;
  onDrop: (point: LngLat) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Marker
      longitude={point[0]}
      latitude={point[1]}
      anchor="center"
      draggable
      style={{ zIndex }}
      onDragStart={onDragStart}
      onDrag={(e) => onDrag([e.lngLat.lng, e.lngLat.lat])}
      onDragEnd={(e) => onDrop([e.lngLat.lng, e.lngLat.lat])}
    >
      {children}
    </Marker>
  );
}

/**
 * Registers (and keeps registered) the icons the overlay layers rasterize at runtime: the
 * poker chip on ephemeral points, the arrowhead repeated along a route line, and the
 * chequered destination stop. All are re-rasterized when the accent/theme colours change; the
 * `styleimagemissing` listener covers style reloads, which drop runtime-added images.
 */
function OverlayImages({ fill, border }: { fill: string; border: string }): null {
  const { current: mapRef } = useMap();
  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    const put = (id: string, image: ImageData, pixelRatio: number): void => {
      if (map.hasImage(id)) map.updateImage(id, image);
      else map.addImage(id, image, { pixelRatio });
    };
    const add = (): void => {
      put(OVERLAY_CHIP_IMAGE_ID, drawOverlayChip(fill, border), OVERLAY_CHIP_PIXEL_RATIO);
      // The arrow takes the chip's rim colour, not the disk's: it draws *on* the route line,
      // which is itself the overlay hue.
      put(ROUTE_ARROW_IMAGE_ID, drawRouteArrow(border), ROUTE_ARROW_PIXEL_RATIO);
      // Chequer + rim in the route hue (`fill`) against the contrast colour (`border`), so the
      // destination reads as the same feature as the stops leading up to it.
      put(
        ROUTE_DESTINATION_IMAGE_ID,
        drawRouteDestination(fill, border),
        ROUTE_DESTINATION_PIXEL_RATIO
      );
    };
    add();
    const onMissing = (e: { id: string }): void => {
      if (
        e.id === OVERLAY_CHIP_IMAGE_ID ||
        e.id === ROUTE_ARROW_IMAGE_ID ||
        e.id === ROUTE_DESTINATION_IMAGE_ID
      ) {
        add();
      }
    };
    map.on("styleimagemissing", onMissing);
    return () => {
      map.off("styleimagemissing", onMissing);
    };
  }, [mapRef, fill, border]);
  return null;
}

/**
 * Rasterizes emoji place pins on demand. Nothing pre-registers them: the symbol layers build each
 * `icon-image` id from the feature's emoji and its resolved colour (see `emojiPinLayout`), so
 * MapLibre asks for an id the first time a tile needs it. `styleimagemissing` fires *synchronously*
 * from the image lookup and MapLibre re-reads the image straight after, so adding it here lands in
 * that same request — no second tile pass, no async race, and nothing has to track which emoji are
 * in view.
 *
 * The same handler covers style reloads (theme / map-colour changes drop runtime-added images) and
 * accent changes (a new default colour is a new id), so the registry self-heals and stays bounded
 * to what has actually been on screen.
 *
 * Separate from `OverlayImages` on purpose: it takes no props, so its effect runs once per map and
 * never re-runs on an accent/theme change. Multiple `styleimagemissing` listeners coexist fine, and
 * each ignores the ids it doesn't own.
 */
function EmojiPinImages(): null {
  const { current: mapRef } = useMap();
  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    const onMissing = ({ id }: { id: string }): void => {
      const pin = parseEmojiPinImageId(id);
      if (!pin || map.hasImage(id)) return;
      // A glyph that rasterizes to nothing still yields a valid blank ImageData, so a bad id
      // can't put this in a fire-loop.
      map.addImage(id, drawEmojiPin(pin.emoji, pin.color), { pixelRatio: EMOJI_PIN_PIXEL_RATIO });
    };
    map.on("styleimagemissing", onMissing);
    return () => {
      map.off("styleimagemissing", onMissing);
    };
  }, [mapRef]);
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
    /**
     * The directions route is being dragged — a new stop onto a leg, or an existing stop to a
     * new place. Fired on every drag frame so the owner can re-route a preview; null when the
     * drag is over. Omit (with `onRouteDragEnd`) to leave the route un-draggable.
     */
    onRouteDrag?: (edit: RouteDragEdit | null) => void;
    /** The drag was released: apply the edit for real. */
    onRouteDragEnd?: (edit: RouteDragEdit) => void;
    /** Live re-routed shape for the drag in progress, drawn in place of the committed route.
     *  Held past the drop until the real route lands, so the line never snaps back. */
    routeDragPreview?: [number, number][] | null;
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
    onAddStopAtPoint,
    onRouteDrag,
    onRouteDragEnd,
    routeDragPreview = null
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
  // What reads against the overlay hue: the poker-chip rim on ephemeral points (symbol-layer
  // icon + HTML selection chip) and the centre of a route stop's dot. White on the accent;
  // monochrome dark mode flips to near-black, since the hue is then near-white itself.
  const overlayContrastColor = accentColor ? "#ffffff" : isDark ? "#111111" : "#ffffff";

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
    const off = window.api.places.onUpdated(() => {
      if (selectedFolderRef.current) {
        void loadFolderPlaces(selectedFolderRef.current);
      }
    });
    return () => {
      off();
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
        l.points.forEach((pt, i) => {
          // Same sanitize-and-omit rule as `toFeature`: `has` is `key in properties`, so a
          // present-but-undefined key would pass HAS_EMOJI_FILTER and leave the point drawn as an
          // image id with no glyph in it — invisible rather than fallen back.
          const icon = emojiIcon(pt.icon);
          features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [pt.lng, pt.lat] },
            properties: {
              kind: "overlay",
              overlayId: pt.id,
              title: pt.title,
              preview_markdown: pt.preview_markdown,
              // A stop that stands for a saved place carries that place's look, so it draws as the
              // pin the rest of the app shows it as (see the `-stop-emoji` layer below).
              ...(icon ? { [EMOJI_PROPERTY]: icon } : {}),
              color: normalizeFeatureColor(pt.color),
              // Only meaningful on a directions route, where points are ordered stops. Harmless
              // elsewhere: no other layer filters on it.
              [DESTINATION_PROPERTY]: i > 0 && i === l.points.length - 1
            }
          });
        });
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

  /**
   * The directions route as something draggable: its shape, its routed stops, and the id of the
   * invisible wide "hit" line to test the pointer against. Null unless a caller wants drag edits
   * — without `onInsertRouteStop` the route is just a drawing.
   */
  const draggableRoute = useMemo(() => {
    if (!onRouteDrag || !onRouteDragEnd || !showOverlay) return null;
    const layer = overlayLayers.find((l) => l.id.startsWith(DIRECTIONS_OVERLAY_PREFIX));
    const line = layer?.lines[0];
    if (!layer || !line || line.coordinates.length < 2 || layer.points.length < 2) return null;
    const coordinates = line.coordinates as LngLat[];
    const stops = layer.points.map((p) => ({ point: [p.lng, p.lat] as LngLat, id: p.id }));
    return {
      hitLayerId: `${overlaySourceId(layer.id)}-lines-hit`,
      coordinates,
      stops,
      // Where each stop sits along the shape — the lookup that turns a grabbed segment into
      // the leg it belongs to. Computed once per route, not per pointer move.
      stopIndices: stopVertexIndices(
        coordinates,
        stops.map((s) => s.point)
      )
    };
  }, [overlayLayers, showOverlay, onRouteDrag, onRouteDragEnd]);

  /**
   * What the pointer has hold of on the route: a spot on a leg (hovering the line, which offers
   * a new stop) or one of the existing stops (only while actually dragging it). `point` is where
   * it started; `routeDragTo` is where it is now.
   */
  const [routeGrab, setRouteGrab] = useState<
    ({ point: LngLat } & Pick<RouteDragEdit, "kind" | "index">) | null
  >(null);
  /** Where the grab has been dragged to; non-null *is* the "dragging" state. */
  const [routeDragTo, setRouteDragTo] = useState<LngLat | null>(null);
  // Read by the pointer-move handler, which must not re-subscribe (or go stale) per drag frame.
  const routeDraggingRef = useRef(false);
  routeDraggingRef.current = routeDragTo !== null;

  // A recomputed route makes the old grab's leg index meaningless.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route is the trigger, not setter identity
  useEffect(() => {
    activeGrabRef.current = null;
    setRouteGrab(null);
    setRouteDragTo(null);
  }, [draggableRoute]);

  /** Offer a new stop while the pointer is over the route line, and withdraw it otherwise. */
  const handleRouteHover = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!draggableRoute || drawingRef.current || routeDraggingRef.current) return;
      const map = mapRef.current?.getMap();
      // The layer is gone for a frame after a style reload; querying an unknown id throws.
      if (!map || !map.getLayer(draggableRoute.hitLayerId)) return;
      const { x, y } = e.point;
      const hits = map.queryRenderedFeatures(
        [
          [x - ROUTE_HANDLE_PADDING, y - ROUTE_HANDLE_PADDING],
          [x + ROUTE_HANDLE_PADDING, y + ROUTE_HANDLE_PADDING]
        ],
        { layers: [draggableRoute.hitLayerId] }
      );
      if (hits.length === 0) {
        // Returning the same value bails out of the render — this fires on every pointer
        // move over the map, the vast majority of them nowhere near the route.
        setRouteGrab((prev) => (prev === null ? prev : null));
        return;
      }
      // On top of a stop, the gesture belongs to that stop: its own grab target sits here, and
      // a new-stop handle over it would take the press and add a duplicate alongside it.
      const overStop = draggableRoute.stops.some((stop) => {
        const at = map.project(stop.point);
        return Math.hypot(at.x - x, at.y - y) <= ROUTE_STOP_GRAB_RADIUS;
      });
      if (overStop) {
        setRouteGrab((prev) => (prev === null ? prev : null));
        return;
      }
      const snapped = snapToPolyline(draggableRoute.coordinates, [e.lngLat.lng, e.lngLat.lat]);
      if (!snapped) return;
      const index = insertionIndexForSegment(draggableRoute.stopIndices, snapped.segmentIndex);
      setRouteGrab((prev) =>
        prev &&
        prev.kind === "insert" &&
        prev.index === index &&
        prev.point[0] === snapped.point[0] &&
        prev.point[1] === snapped.point[1]
          ? prev
          : { kind: "insert", index, point: snapped.point }
      );
    },
    [draggableRoute]
  );

  const handleRouteHoverLeave = useCallback(() => {
    if (routeDraggingRef.current) return;
    setRouteGrab((prev) => (prev === null ? prev : null));
  }, []);

  /** The drag as an edit to the stop list, at the position the pointer is at now. */
  const routeDragEdit = useCallback(
    (grab: NonNullable<typeof routeGrab>, to: LngLat): RouteDragEdit => ({
      kind: grab.kind,
      index: grab.index,
      point: { lng: to[0], lat: to[1] }
    }),
    []
  );

  /**
   * The grab the pointer actually owns, so a second handle grabbed while the last drop is still
   * settling can't commit an edit: its leg indices were measured against a route the stop list
   * has already moved past. A ref, not state — MapLibre's `dragstart` and first `drag` can land
   * in the same tick, before a re-render would publish it.
   */
  const activeGrabRef = useRef<{ kind: string; index: number } | null>(null);
  const ownsGrab = useCallback((grab: { kind: string; index: number }): boolean => {
    const active = activeGrabRef.current;
    return active !== null && active.kind === grab.kind && active.index === grab.index;
  }, []);

  const beginRouteDrag = useCallback(
    (grab: NonNullable<typeof routeGrab>) => {
      if (activeGrabRef.current) return;
      activeGrabRef.current = { kind: grab.kind, index: grab.index };
      setRouteGrab(grab);
      setRouteDragTo(grab.point);
      onRouteDrag?.(routeDragEdit(grab, grab.point));
    },
    [onRouteDrag, routeDragEdit]
  );

  const moveRouteDrag = useCallback(
    (grab: NonNullable<typeof routeGrab>, to: LngLat) => {
      if (!ownsGrab(grab)) return;
      setRouteDragTo(to);
      onRouteDrag?.(routeDragEdit(grab, to));
    },
    [onRouteDrag, routeDragEdit, ownsGrab]
  );

  const endRouteDrag = useCallback(
    (grab: NonNullable<typeof routeGrab>, to: LngLat) => {
      if (!ownsGrab(grab)) return;
      activeGrabRef.current = null;
      onRouteDragEnd?.(routeDragEdit(grab, to));
      if (routeDragPreview) {
        // Hold the handle at the drop point until the committed route replaces the preview:
        // letting go here would flash a moved stop back to where it came from for a frame.
        setRouteDragTo(to);
        return;
      }
      setRouteDragTo(null);
      setRouteGrab(null);
    },
    [onRouteDragEnd, routeDragEdit, routeDragPreview, ownsGrab]
  );

  // The owner dropping its preview ends the drag — either the committed route caught up, or the
  // drop changed nothing. Paired with the branch above, which holds on rather than resetting.
  useEffect(() => {
    if (routeDragPreview === null) {
      activeGrabRef.current = null;
      setRouteGrab(null);
      setRouteDragTo(null);
    }
  }, [routeDragPreview]);

  /**
   * The live re-routed shape, drawn in place of the committed route line.
   *
   * Nothing stands in for it before the first re-route lands — the committed route simply stays
   * up. A straight band to the neighbouring stops filled that gap at first, but it read as the
   * route briefly snapping back to a straight line from the origin.
   */
  const routeDragPreviewGeoJSON = useMemo(() => {
    if (!routeDragPreview || routeDragPreview.length < 2) return null;
    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: routeDragPreview },
          properties: {}
        }
      ]
    };
  }, [routeDragPreview]);

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
    // Sanitized, and omitted entirely rather than set to undefined: MapLibre's `has` is
    // `key in properties`, so a present-but-undefined key would pass HAS_EMOJI_FILTER and hide
    // the point behind an image id with no glyph in it. (`color` is safe from this — `get`
    // returns null for undefined, which its `coalesce` treats as absent.)
    const icon = emojiIcon(p.icon);
    return {
      type: "Feature" as const,
      geometry: parseGeometry(p.geometry),
      // Leave `color` undefined when unset so each layer can pick its own default
      // (lines need white; circles/polygons stay gray).
      properties: {
        filePath: p.filePath,
        // Normalized so `#FFF` and `#ffffff` don't register two identical pin images.
        color: normalizeFeatureColor(p.color),
        ...(icon ? { [EMOJI_PROPERTY]: icon } : {}),
        // A saved route earns direction arrows; a hand-drawn line doesn't. Records built from
        // SQLite rows never carry `route`, so a line clicked on the map draws bare until the
        // indexed record arrives — the same staleness every other route affordance lives with.
        [ROUTE_PROPERTY]: Boolean(p.route)
      }
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
    const isRouteLine = ["==", ["get", ROUTE_PROPERTY], true];
    const notSelected = ["!", ["in", ["get", "filePath"], ["literal", excluded]]];
    const none = excluded.length === 0;
    const point = none ? POINT_FILTER : ["all", POINT_FILTER, notSelected];
    return {
      point,
      // Points split by whether they carry an emoji: `circlePoint` draws as a circle,
      // `emojiPoint` as the rasterized pin. Exact complements, so every point is drawn
      // once and none is dropped.
      circlePoint: ["all", point, NO_EMOJI_FILTER],
      emojiPoint: ["all", point, HAS_EMOJI_FILTER],
      polygon: none ? POLYGON_FILTER : ["all", POLYGON_FILTER, notSelected],
      line: none ? LINESTRING_FILTER : ["all", LINESTRING_FILTER, notSelected],
      routeLine: none
        ? ["all", LINESTRING_FILTER, isRouteLine]
        : ["all", LINESTRING_FILTER, notSelected, isRouteLine]
    };
  }, [selectedPlace?.filePath, openPlace?.filePath]);

  /** The selected source's points minus the selected place's own, which the animated
   *  SelectionMarker draws. A peeked (open) place keeps its static mark here. Needed by the
   *  circle, the emoji pin, and the pin's halo, so it's hoisted rather than inlined. */
  const selectedPointFilter = useMemo(
    () => ["all", POINT_FILTER, ["!=", ["get", "filePath"], selectedPlace?.filePath ?? ""]],
    [selectedPlace?.filePath]
  );

  // Selected place as its own source for distinct styling. While a peek is active,
  // the still-open file renders here too — same style, but only the selected place
  // gets the animated grow marker (selectionAnchor below).
  //
  // The feature the user clicked carries CLICKED_PROPERTY, which is what earns a line its white
  // casing: a file that is merely open renders here too, and shouldn't look clicked.
  const selectedGeoJSON = useMemo(() => {
    const places = [selectedPlace, openPlace]
      .filter((p): p is PlaceRecord & { geometry: string } => Boolean(p?.geometry))
      .filter((p) => p.filePath !== editingFilePath)
      .filter((p, i, arr) => arr.findIndex((q) => q.filePath === p.filePath) === i);
    if (places.length === 0) return null;
    const clickedPath = selectionPulseAnchor?.filePath;
    try {
      return {
        type: "FeatureCollection" as const,
        features: places.map((p) => {
          const feature = toFeature(p);
          if (p.filePath !== clickedPath) return feature;
          return {
            ...feature,
            properties: { ...feature.properties, [CLICKED_PROPERTY]: true }
          };
        })
      };
    } catch {
      return null;
    }
  }, [selectedPlace, openPlace, editingFilePath, selectionPulseAnchor?.filePath, toFeature]);

  /** The selected route's stops. Suppressed with the rest of the file's rendering while a
   *  draw session is about to replace its geometry — otherwise the line disappears for the
   *  session but its stops stay behind, reading as a second, stranded feature. */
  const routeStopsGeoJSON = useMemo(() => {
    if (routeStops.length === 0) return null;
    if (selectedPlace?.filePath === editingFilePath) return null;
    return {
      type: "FeatureCollection" as const,
      features: routeStops.map((s, i) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
        properties: { [DESTINATION_PROPERTY]: i > 0 && i === routeStops.length - 1 }
      }))
    };
  }, [routeStops, selectedPlace?.filePath, editingFilePath]);

  /** Anchor position: Points use geometry; lines/polygons anchor where the user clicked. */
  const selectionAnchor = useMemo((): SelectionAnchor | null => {
    if (!selectedPlace?.geometry) return null;
    if (selectedPlace.filePath === editingFilePath) return null;
    try {
      const geo = parseGeometry(selectedPlace.geometry);
      if (isPoint(geo)) {
        const [lng, lat] = geo.coordinates;
        // Carry the feature colour and emoji so the marker matches the pin it stands in for.
        return {
          kind: "place",
          lng,
          lat,
          color: normalizeFeatureColor(selectedPlace.color),
          icon: emojiIcon(selectedPlace.icon)
        };
      }
      if (selectionPulseAnchor && selectionPulseAnchor.filePath === selectedPlace.filePath) {
        if (!selectionPulseAnchor.showDot) return null;
        return { kind: "click", lng: selectionPulseAnchor.lng, lat: selectionPulseAnchor.lat };
      }
      // Non-point with no click anchor: rely on the selected line/fill styling for
      // highlighting. A bbox-center pulse looked like a stray marker.
      return null;
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
    // Each `-emoji` symbol layer goes in under the exact same guard as its `-circle` sibling: a
    // point is on one or the other, and queryRenderedFeatures returns nothing at all if any id
    // here is missing from the style. `selected-emoji-halo` is left out — it's decoration, and
    // the symbol above it answers the click.
    if (folderGeoJSON) {
      ids.push("folder-circle", "folder-emoji", "folder-fill", "folder-line");
    }
    if (linkedGeoJSON) {
      ids.push("linked-circle", "linked-emoji", "linked-fill", "linked-line");
    }
    if (showOverlay && presentedGeoJSON) {
      ids.push("presented-circle", "presented-emoji", "presented-fill", "presented-line");
    }
    if (selectedGeoJSON) {
      ids.push("selected-circle", "selected-emoji", "selected-fill", "selected-line");
    }
    for (const { layerId, sourceId } of overlayLayerSources) {
      ids.push(`${sourceId}-polygons`, `${sourceId}-points`);
      // A directions route is the panel's own drawing, not a feature to select — clicking it
      // would open a "Map overlay" card for a trip that has no file. Leaving it out lets the
      // click fall through to the map, so it can still fill an armed stop or clear a selection.
      if (layerId.startsWith(DIRECTIONS_OVERLAY_PREFIX)) {
        // The stops that draw as a pin instead of a dot, so they answer a click the same way.
        // Only for a route source: `-stop-emoji` isn't rendered for any other overlay, and one id
        // missing from the style makes queryRenderedFeatures return nothing for the whole query.
        ids.push(`${sourceId}-stop-emoji`);
      } else {
        ids.push(`${sourceId}-lines-hit`, `${sourceId}-lines`);
      }
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
        onMouseMove={handleRouteHover}
        onMouseOut={handleRouteHoverLeave}
      >
        <OverlayImages fill={overlayColor} border={overlayContrastColor} />
        <EmojiPinImages />
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
            {/* A saved route reads as a journey wherever it's drawn, not just in the
                directions panel. */}
            <Layer
              id="folder-route-arrows"
              type="symbol"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.routeLine}
              layout={ROUTE_ARROW_LAYOUT}
              paint={routeArrowPaint(1)}
            />
            <Layer
              id="folder-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.circlePoint}
              paint={featureCirclePaint(featureColor)}
            />
            {/* Points with an `icon` emoji draw as the rasterized pin instead. Rendered
                unconditionally beside its circle sibling: queryRenderedFeatures returns nothing at
                all if any id in its layer list is missing from the style, so the two ids must never
                diverge. */}
            <Layer
              id="folder-emoji"
              type="symbol"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.emojiPoint}
              layout={emojiPinLayout(featureColor)}
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
            {/* A saved route reads as a journey wherever it's drawn, not just in the
                directions panel. */}
            <Layer
              id="linked-route-arrows"
              type="symbol"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.routeLine}
              layout={ROUTE_ARROW_LAYOUT}
              paint={routeArrowPaint(1)}
            />
            <Layer
              id="linked-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.circlePoint}
              paint={featureCirclePaint(featureColor)}
            />
            <Layer
              id="linked-emoji"
              type="symbol"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.emojiPoint}
              layout={emojiPinLayout(featureColor)}
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
            {/* A saved route reads as a journey wherever it's drawn, not just in the
                directions panel. */}
            <Layer
              id="presented-route-arrows"
              type="symbol"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.routeLine}
              layout={ROUTE_ARROW_LAYOUT}
              paint={routeArrowPaint(1)}
            />
            <Layer
              id="presented-circle"
              type="circle"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.circlePoint}
              paint={featureCirclePaint(featureColor)}
            />
            <Layer
              id="presented-emoji"
              type="symbol"
              // @ts-expect-error - MapLibre filter expression
              filter={unselectedFilters.emojiPoint}
              layout={emojiPinLayout(featureColor)}
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
            {/* White outline beneath the accent boundary — the highlight for a polygon the user
                clicked, on the same rule as lines: opening a file doesn't restyle its shape.
                Miter joins (no round layout) to match the accent outline's corners. */}
            <Layer
              id="selected-fill-highlight"
              type="line"
              filter={["all", POLYGON_FILTER, CLICKED_FILTER] as unknown as FilterSpecification}
              paint={SELECTED_OUTLINE_PAINT}
            />
            <Layer
              id="selected-fill-outline"
              type="line"
              // @ts-expect-error - MapLibre filter expression
              filter={POLYGON_FILTER}
              paint={selectedFillOutlinePaint(featureColor)}
            />
            {/* White outline beneath the accent line — the highlight for a line the user
                clicked. A line that is only *open* gets none: opening a file shouldn't
                restyle its shape. */}
            <Layer
              id="selected-line-highlight"
              type="line"
              filter={["all", LINESTRING_FILTER, CLICKED_FILTER] as unknown as FilterSpecification}
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
            <Layer
              id="selected-route-arrows"
              type="symbol"
              filter={ROUTE_LINE_FILTER}
              layout={ROUTE_ARROW_LAYOUT}
              paint={routeArrowPaint(1)}
            />
            {/* The selected place's own point is drawn by the animated SelectionMarker;
                exclude it here so they don't stack. A peeked (open) place keeps this
                static selected circle. */}
            <Layer
              id="selected-circle"
              type="circle"
              filter={
                ["all", selectedPointFilter, NO_EMOJI_FILTER] as unknown as FilterSpecification
              }
              paint={selectedCirclePaint(featureColor)}
            />
            {/* The selected pin's white highlight. A symbol icon can't take a circle stroke, so
                the "glow" is a white disk drawn under it. Must precede the symbol layer — JSX
                order is layer order. */}
            <Layer
              id="selected-emoji-halo"
              type="circle"
              filter={
                ["all", selectedPointFilter, HAS_EMOJI_FILTER] as unknown as FilterSpecification
              }
              paint={selectedEmojiPinHaloPaint()}
            />
            <Layer
              id="selected-emoji"
              type="symbol"
              filter={
                ["all", selectedPointFilter, HAS_EMOJI_FILTER] as unknown as FilterSpecification
              }
              layout={emojiPinLayout(featureColor)}
            />
          </Source>
        )}
        {/* After the selected source so the stops sit on top of their own route line. */}
        {routeStopsGeoJSON && (
          <Source id="route-stops-geojson" type="geojson" data={routeStopsGeoJSON}>
            <Layer
              id="route-stops"
              type="circle"
              filter={NOT_DESTINATION_FILTER as unknown as FilterSpecification}
              paint={routeStopPaint(featureColor)}
            />
            <Layer
              id="route-stops-destination"
              type="symbol"
              filter={DESTINATION_FILTER as unknown as FilterSpecification}
              layout={ROUTE_DESTINATION_LAYOUT}
            />
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
            // While a live re-route stands in for this route, its own line would draw the
            // pre-drag shape underneath — two routes at once. The preview outlives the drop,
            // so this holds until the committed route catches up.
            const lineHidden = isRoute && routeDragPreviewGeoJSON !== null;
            // The stop being dragged is drawn by the handle instead, so its dot would
            // otherwise sit behind as a ghost at the old position.
            const hiddenStopId =
              isRoute && routeDragTo && routeGrab?.kind === "move"
                ? draggableRoute?.stops[routeGrab.index]?.id
                : undefined;
            const stopFilter = (hiddenStopId
              ? ["all", POINT_FILTER, ["!=", ["get", "overlayId"], hiddenStopId]]
              : POINT_FILTER) as unknown as FilterSpecification;
            // The destination is lifted out of the dot layer into its own chequered symbol, so
            // the two never draw on top of each other.
            const dotFilter = (isRoute
              ? ["all", stopFilter, NOT_DESTINATION_FILTER, NO_EMOJI_FILTER]
              : stopFilter) as unknown as FilterSpecification;
            // Exact complement of `dotFilter`, so every non-destination stop draws exactly once.
            const stopPinFilter = [
              "all",
              stopFilter,
              NOT_DESTINATION_FILTER,
              HAS_EMOJI_FILTER
            ] as unknown as FilterSpecification;
            const destinationFilter = [
              "all",
              stopFilter,
              DESTINATION_FILTER
            ] as unknown as FilterSpecification;
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
                      ? routeLinePaint(overlayColor, lineHidden ? 0 : lineOpacity)
                      : overlayLinePaint(overlayColor, lineOpacity)
                  }
                  layout={isRoute ? ROUND_LINE_LAYOUT : {}}
                />
                {/* Direction arrows, so a route reads as travelled origin → destination rather
                    than as a shape someone drew. Above the line, below the stops. */}
                {isRoute && (
                  <Layer
                    id={`${sourceId}-arrows`}
                    type="symbol"
                    // @ts-expect-error - MapLibre filter expression
                    filter={LINESTRING_FILTER}
                    layout={ROUTE_ARROW_LAYOUT}
                    paint={routeArrowPaint(lineHidden ? 0 : lineOpacity)}
                  />
                )}
                {/* A route's points are its stops, so they draw as solid dots to match the
                    solid line (see routeStopPaint). Every other overlay's points go out as a
                    symbol layer with the rasterized poker-chip icon (not HTML markers) so a
                    large result set stays cheap — one WebGL layer draws thousands. The icon is
                    registered by OverlayChipImage above.

                    A source never flips between the two: `isRoute` is derived from its id. */}
                {/* Each Layer stays a *direct* child of Source: react-map-gl injects `source`
                    by cloning its immediate children, so wrapping a pair in a fragment leaves
                    them sourceless. */}
                {isRoute && (
                  <Layer
                    id={`${sourceId}-points`}
                    type="circle"
                    filter={dotFilter}
                    paint={routeStopPaint(overlayColor, {
                      fill: overlayContrastColor,
                      opacity: lineOpacity
                    })}
                  />
                )}
                {/* A stop that is a saved place with an emoji draws as that place's pin instead of
                    a dot — the same raster the vault layers use, so the trip is made of things the
                    user recognises. The pin's disk falls back to the route's own hue rather than
                    the feature colour, since it belongs to this route. */}
                {isRoute && (
                  <Layer
                    id={`${sourceId}-stop-emoji`}
                    type="symbol"
                    filter={stopPinFilter}
                    layout={emojiPinLayout(overlayColor)}
                    paint={{ "icon-opacity": lineOpacity }}
                  />
                )}
                {/* The finish line, drawn above the stop dots so a stop that lands under it
                    can't peek out. */}
                {isRoute && (
                  <Layer
                    id={`${sourceId}-destination`}
                    type="symbol"
                    filter={destinationFilter}
                    layout={ROUTE_DESTINATION_LAYOUT}
                    paint={{ "icon-opacity": lineOpacity }}
                  />
                )}
                {!isRoute && (
                  <Layer
                    id={`${sourceId}-points`}
                    type="symbol"
                    filter={stopFilter}
                    layout={{
                      "icon-image": OVERLAY_CHIP_IMAGE_ID,
                      "icon-allow-overlap": true,
                      "icon-ignore-placement": true
                    }}
                    paint={{ "icon-opacity": lineOpacity }}
                  />
                )}
              </Source>
            );
          })}
        {routeDragPreviewGeoJSON && (
          // The live re-route: drawn exactly like the route it stands in for, since it *is* a
          // routed shape. The committed line is hidden while this is up (see `-lines` above).
          <Source id="route-drag-preview" type="geojson" data={routeDragPreviewGeoJSON}>
            <Layer
              id="route-drag-preview-line"
              type="line"
              paint={routeLinePaint(overlayColor, 1)}
              layout={ROUND_LINE_LAYOUT}
            />
            {/* Arrows here too, or they blink out of the route for the length of the drag. */}
            <Layer
              id="route-drag-preview-arrows"
              type="symbol"
              layout={ROUTE_ARROW_LAYOUT}
              paint={routeArrowPaint(1)}
            />
          </Source>
        )}
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
        {/* The new-stop handle: only for a spot on a leg. An existing stop being moved is dragged
            by its own marker below, not by this one — two markers for one gesture would mean one
            of them has a position that doesn't follow the drag. */}
        {routeGrab?.kind === "insert" && (
          <RouteDragHandle
            point={routeDragTo ?? routeGrab.point}
            zIndex={ROUTE_HANDLE_Z.newStop}
            onDragStart={() => beginRouteDrag(routeGrab)}
            onDrag={(to) => moveRouteDrag(routeGrab, to)}
            onDrop={(to) => endRouteDrag(routeGrab, to)}
          >
            <div
              title="Drag to change route"
              className="size-3 cursor-grab rounded-full shadow-sm active:cursor-grabbing"
              style={{ backgroundColor: foregroundColor }}
            />
          </RouteDragHandle>
        )}
        {/* Grab targets over the route's own stops. Invisible at rest — the WebGL chip beneath is
            the visual — and the dot while being dragged, with the chip hidden so it doesn't ghost
            at the old position. Three things matter here:
            - `point` follows the drag for the stop being moved (see RouteDragHandle).
            - Stacked above the new-stop handle, so a press within a stop's radius moves that
              stop instead of adding one beside it, even while the line handle is showing.
            - Kept mounted for the whole drag, since unmounting the marker that owns the pointer
              would strand the gesture with no dragend. */}
        {draggableRoute?.stops.map((stop, i) => {
          const dragging = routeGrab?.kind === "move" && routeGrab.index === i ? routeDragTo : null;
          const grab = { kind: "move" as const, index: i, point: stop.point };
          return (
            <RouteDragHandle
              key={stop.id}
              point={dragging ?? stop.point}
              zIndex={ROUTE_HANDLE_Z.existingStop}
              onDragStart={() => beginRouteDrag(grab)}
              onDrag={(to) => moveRouteDrag(grab, to)}
              onDrop={(to) => endRouteDrag(grab, to)}
            >
              {dragging ? (
                <div
                  title="Drag to move this stop"
                  className="size-3 cursor-grabbing rounded-full shadow-sm"
                  style={{ backgroundColor: foregroundColor }}
                />
              ) : (
                <div
                  title="Drag to move this stop"
                  className="cursor-grab rounded-full"
                  style={{ width: ROUTE_STOP_GRAB_SIZE, height: ROUTE_STOP_GRAB_SIZE }}
                />
              )}
            </RouteDragHandle>
          );
        })}
        {/* Keyed on the anchor coords so a fresh selection remounts and replays the pop. */}
        {selectionAnchor?.kind === "place" && (
          <SelectionMarker
            key={`${selectionAnchor.lng},${selectionAnchor.lat}`}
            anchor={selectionAnchor}
            color={featureColor}
            chip={
              selectedPlace?.filePath.startsWith(MAP_OVERLAY_PREFIX)
                ? { fill: overlayColor, borderColor: overlayContrastColor }
                : undefined
            }
            stop={
              selectedPlace?.filePath.includes(DIRECTIONS_OVERLAY_PREFIX)
                ? { fill: overlayContrastColor, borderColor: overlayColor }
                : undefined
            }
          />
        )}
        {selectionAnchor?.kind === "click" && (
          <ClickAnchorMarker
            key={`${selectionAnchor.lng},${selectionAnchor.lat}`}
            anchor={selectionAnchor}
            color={foregroundColor}
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
            New note
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
