import { Button } from "@mapos/ui/components/button";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { type SidebarKeyboardShortcutConfig, SidebarProvider } from "@mapos/ui/components/sidebar";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { detailPropertiesFromGeocodeResult } from "@shared/geocode-detail";
import { type RouteFrontmatter, type RouteStop, defaultRouteTitle } from "@shared/route";
import type { MapOverlayLayer, OverlayPoint } from "@shared/types";
import { DIRECTIONS_OVERLAY_PREFIX, orderDetailProperties } from "@shared/types";
import { bbox } from "@turf/bbox";
import type { Geometry } from "geojson";
import { ChevronLeftIcon, ChevronRightIcon, PanelLeftIcon } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DirectionsPanel } from "./components/directions-panel";
import { type FeatureListRow, FeaturesListPanel } from "./components/features-list-panel";
import { GeocodeSearchPopover } from "./components/geocode-search-popover";
import MapView, {
  type MapSelectPlaceMeta,
  type MapViewHandle,
  type PlaceRecord,
  type SelectionPulseAnchor
} from "./components/map-view";
import { DrawToolbar } from "./components/map/draw-toolbar";
import { MapControls } from "./components/map/map-controls";
import type { UserLocation } from "./components/map/user-location-layer";
import { NavTabs } from "./components/nav-tabs";
import { PlaceCard } from "./components/place-card";
import { ProjectSidebar } from "./components/project-sidebar";
import { ResizeHandle } from "./components/resize-handle";
import { useFullscreen } from "./hooks/use-fullscreen";
import { useMapOverlaySync } from "./hooks/use-map-overlay-sync";
import {
  type DirectionsWaypoint,
  type NavEntry,
  type TravelMode,
  folderLabel,
  useNavTabs
} from "./hooks/use-nav-tabs";
import { usePathSync } from "./hooks/use-path-sync";
import { usePlacesIndex } from "./hooks/use-places-index";
import { usePlacesWatcher } from "./hooks/use-places-watcher";
import { useResizableWidth } from "./hooks/use-resizable-width";
import { modSymbol, useShortcuts } from "./hooks/use-shortcuts";
import { useVaultRoot } from "./hooks/use-vault-root";
import type { DrawSession, DrawShape } from "./lib/draw";
import type { GeocodeSearchResult } from "./lib/geocode-search";
import {
  type GeometryKind,
  geometryJsonToCreateArgs,
  geometryJsonToWkt,
  geometryKindOf
} from "./lib/geometry-wkt";
import {
  filenameBaseFromPlaceTitle,
  isVaultFilePath,
  renameCreatedPlaceToSlug
} from "./lib/place-utils";
import { waypointAtPoint, waypointFromPlace } from "./lib/place-waypoint";
import { type RouteDragEdit, applyRouteDragEdit } from "./lib/route-drag";
import {
  extractWikilinkTitles,
  flattenMdFiles,
  resolveWikilinkPath,
  resolveWikilinkTarget,
  wikilinkForFile
} from "./lib/wikilinks";

const BASE_UNITS = 16;

const PROJECT_SIDEBAR_DEFAULT_WIDTH = 16 * BASE_UNITS;
// Wide enough that the sidebar-anchored controls (toggle + search + back/forward,
// plus the traffic-light inset) never overflow into the tab strip.
const PROJECT_SIDEBAR_MIN_WIDTH = 14 * BASE_UNITS;
const PROJECT_SIDEBAR_MAX_WIDTH = 30 * BASE_UNITS;
const MAIN_PANE_DEFAULT_WIDTH = 24 * BASE_UNITS;
// The floor the resize handle stops at. Wide enough that a property's label and its value still
// share a line, and that the place card's location row can show a full coordinate pair untruncated.
const MAIN_PANE_MIN_WIDTH = 17 * BASE_UNITS + 100;
const MAIN_PANE_MAX_WIDTH = 40 * BASE_UNITS;
const TOP_BAR_HEIGHT = 2.5 * BASE_UNITS;
const FIT_BUFFER = 2.5 * BASE_UNITS;

const SIDEBAR_KB_PROJECT: SidebarKeyboardShortcutConfig = { shift: false };

/** Lines, polygons, etc. — pulse should anchor at map click; Points use geometry coordinates. */
function geometryUsesMapClickPulseAnchor(geometryJson: string | undefined): boolean {
  if (!geometryJson) return false;
  try {
    const g = JSON.parse(geometryJson) as { type?: string };
    return Boolean(g.type && g.type !== "Point");
  } catch {
    return false;
  }
}

/** Whether two stop lists route to the same thing — position-by-position, coordinates only. */
function sameStopCoordinates(
  a: (DirectionsWaypoint | null)[],
  b: (DirectionsWaypoint | null)[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((stop, i) => {
    const other = b[i];
    if (stop == null || other == null) return stop == null && other == null;
    return stop.lat === other.lat && stop.lng === other.lng;
  });
}

function placeFromGeocodeSearchResult(r: GeocodeSearchResult): PlaceRecord {
  const geometry = JSON.stringify({
    type: "Point",
    coordinates: [r.lng, r.lat]
  });
  // Same shared derivation the chat path uses, so the card is identical either way.
  const properties = detailPropertiesFromGeocodeResult(r);
  return {
    filePath: `geocode-search:${r.id}`,
    title: r.primaryLabel,
    type: "Search",
    geometry,
    /** Present (may be empty) so PlaceCard stays in preview mode without reading a file. */
    previewMarkdown: "",
    ...(Object.keys(properties).length > 0 ? { properties } : {})
  };
}

/** Build a preview PlaceRecord from an overlay point — the shape both the mini card and
 *  the save-to-vault path consume (geometry + previewMarkdown + properties). */
function previewPlaceFromOverlayPoint(point: OverlayPoint): PlaceRecord {
  return {
    filePath: `map-overlay:${point.id}`,
    title: point.title || "Map overlay",
    type: "Preview",
    geometry: JSON.stringify({ type: "Point", coordinates: [point.lng, point.lat] }),
    previewMarkdown: point.preview_markdown ?? "",
    ...(point.properties && Object.keys(point.properties).length > 0
      ? { properties: point.properties }
      : {})
  };
}

/** Minimal Point FeatureCollection for framing a list's markers via fitToGeoJson. */
function pointsFeatureCollection(points: Array<{ lat: number; lng: number }>) {
  return {
    type: "FeatureCollection" as const,
    features: points.map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point", coordinates: [p.lng, p.lat] } as Record<string, unknown>,
      properties: null
    }))
  };
}

/** Wrap raw GeoJSON geometries as a FeatureCollection for framing via fitToGeoJson. */
function geometryFeatureCollection(geometries: Array<Record<string, unknown>>) {
  return {
    type: "FeatureCollection" as const,
    features: geometries.map((geometry) => ({
      type: "Feature" as const,
      geometry,
      properties: null
    }))
  };
}

/** All of a layer's geometry (points, lines, polygons) as a FeatureCollection, for framing
 *  the whole overlay — geometry-agnostic, so a route or area frames like a point set. */
function overlayFeatureCollection(layer: MapOverlayLayer) {
  return geometryFeatureCollection([
    ...layer.points.map((p) => ({ type: "Point", coordinates: [p.lng, p.lat] })),
    ...layer.lines.map((l) => ({ type: "LineString", coordinates: l.coordinates })),
    ...layer.polygons.map((pg) => ({ type: "Polygon", coordinates: pg.coordinates }))
  ]);
}

/** Directory containing a vault file path (browser-safe; avoids Node `path` in the renderer bundle). */
function parentFolderOfVaultFile(filePath: string): string {
  const n = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (n === -1) return ".";
  if (n === 0) return filePath.slice(0, 1);
  return filePath.slice(0, n);
}

/** Open file is a real vault .md (not a photon search, map overlay, or GeoJSON layer). */
function isVaultPlaceFile(place: PlaceRecord | null | undefined): place is PlaceRecord {
  if (!place) return false;
  if (place.previewMarkdown !== undefined) return false;
  if (place.type === "GeoJsonLayer") return false;
  return isVaultFilePath(place.filePath);
}

/** Read the file body, parse [[wikilinks]], resolve each title to a PlaceRecord with geometry. */
async function resolveWikilinks(filePath: string): Promise<PlaceRecord[]> {
  const [readResult, nodes] = await Promise.all([
    window.api.fs.readFile(filePath),
    window.api.fs.listDir()
  ]);
  if ("error" in readResult) return [];
  const titles = extractWikilinkTitles(readResult.body);
  if (titles.length === 0) return [];
  const cache = flattenMdFiles(nodes);
  const paths = titles
    .map((t) => resolveWikilinkTarget(cache, t)?.filePath)
    .filter((p): p is string => Boolean(p) && p !== filePath);
  const records = await Promise.all(paths.map((p) => window.api.places.getByPath(p)));
  return records.filter((r): r is PlaceRecord => r !== null && Boolean(r.geometry));
}

function App(): React.JSX.Element {
  const [selectedPlace, setSelectedPlace] = useState<PlaceRecord | null>(null);
  const [placeMode, setPlaceMode] = useState<"mini" | "full">("mini");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(true);
  const [featureScreenPos, setFeatureScreenPos] = useState<{ x: number; y: number } | null>(null);
  /** Map selection while full PlaceCard is open (floating mini card + highlight). */
  const [mapPeekPlace, setMapPeekPlace] = useState<PlaceRecord | null>(null);
  /** Last real vault file path (kept when switching to a Photon search preview). */
  const [lastVaultFilePath, setLastVaultFilePath] = useState<string | null>(null);
  // Route overlay for the active directions tab, lifted from DirectionsPanel so it draws
  // on the map (mirrors how a list tab's layer rides in visibleOverlayLayers).
  const [directionsRouteLayer, setDirectionsRouteLayer] = useState<MapOverlayLayer | null>(null);
  /** Coordinates of the directions step the user is hovering/selected; drawn emphasized on the
   *  route. Lifted from DirectionsPanel so MapView (which owns the route source) can highlight it. */
  const [directionsHighlight, setDirectionsHighlight] = useState<[number, number][] | null>(null);
  /** Overlay feature to emphasize on the map; null = all full opacity. */
  const [focusedFeatureId, setFocusedFeatureId] = useState<string | null>(null);
  const [selectionPulseAnchor, setSelectionPulseAnchor] = useState<SelectionPulseAnchor | null>(
    null
  );
  const [activeGeoJsonLayers, setActiveGeoJsonLayers] = useState<
    Array<{
      filePath: string;
      data: Record<string, unknown>;
      bbox: [number, number, number, number];
    }>
  >([]);
  /** Places linked from [[wikilinks]] in the currently-open file; rendered gray. */
  const [linkedPlaces, setLinkedPlaces] = useState<PlaceRecord[]>([]);
  const mapRef = useRef<MapViewHandle>(null);
  // Current position from the top-bar locate control; fed to MapView's location layer.
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const selectedPlaceRef = useRef(selectedPlace);
  selectedPlaceRef.current = selectedPlace;

  // Pane widths are per-vault workspace state (like tabs and viewport).
  const vaultRoot = useVaultRoot();
  const vaultRootRef = useRef(vaultRoot);
  vaultRootRef.current = vaultRoot;
  const { width: projectSidebarWidth, startDrag: startProjectSidebarResize } = useResizableWidth({
    storageKey: vaultRoot ? `mapos.projectSidebarWidth:${vaultRoot}` : null,
    legacyStorageKey: "mapos.projectSidebarWidth",
    defaultWidth: PROJECT_SIDEBAR_DEFAULT_WIDTH,
    minWidth: PROJECT_SIDEBAR_MIN_WIDTH,
    maxWidth: PROJECT_SIDEBAR_MAX_WIDTH
  });
  const { width: mainPaneWidth, startDrag: startMainPaneResize } = useResizableWidth({
    storageKey: vaultRoot ? `mapos.mainPaneWidth:${vaultRoot}` : null,
    legacyStorageKey: "mapos.mainPaneWidth",
    defaultWidth: MAIN_PANE_DEFAULT_WIDTH,
    minWidth: MAIN_PANE_MIN_WIDTH,
    maxWidth: MAIN_PANE_MAX_WIDTH
  });

  const getMapPadding = useCallback(
    (mainPaneOpen: boolean) => ({
      left:
        (projectSidebarOpen ? projectSidebarWidth : 0) +
        (mainPaneOpen ? mainPaneWidth : 0) +
        FIT_BUFFER,
      right: FIT_BUFFER,
      top: TOP_BAR_HEIGHT + FIT_BUFFER,
      bottom: FIT_BUFFER
    }),
    [projectSidebarOpen, projectSidebarWidth, mainPaneWidth]
  );

  useEffect(() => {
    const p = selectedPlace?.filePath;
    if (!p) {
      setLastVaultFilePath(null);
      return;
    }
    if (!p.startsWith("geocode-search:") && !p.startsWith("map-overlay:")) {
      setLastVaultFilePath(p);
    }
  }, [selectedPlace]);

  /** Open file: snapshot padding, resolve wikilinks, set markers, and fit-to-bounds.
   * Keyed on filePath only — toggling sidebars or switching mode after open shouldn't re-fit. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: padding is intentionally snapshotted at open time
  useEffect(() => {
    const filePath = selectedPlace?.filePath;
    if (!filePath || !isVaultPlaceFile(selectedPlace)) {
      setLinkedPlaces([]);
      return;
    }
    const padding = getMapPadding(placeMode === "full");
    let cancelled = false;
    void (async () => {
      const linked = await resolveWikilinks(filePath);
      if (cancelled) return;
      setLinkedPlaces(linked);
      // Read the latest place from the existing ref so a metadata update mid-resolve
      // (e.g. geometry commit on the same file) feeds the freshest geometry to the fit.
      const currentPlace = selectedPlaceRef.current;
      if (linked.length > 0 && currentPlace?.filePath === filePath) {
        mapRef.current?.fitToPlaceAndLinks(currentPlace, linked, padding);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPlace?.filePath]);

  /** Live update: refresh markers (no fit) when the open file's body changes on disk.
   * Only the filePath shape is consulted — re-binds when the open file changes, not on metadata. */
  useEffect(() => {
    const filePath = selectedPlace?.filePath;
    if (!isVaultFilePath(filePath)) return;
    let cancelled = false;
    const off = window.api.fs.onFileContentChanged(({ filePath: changedPath }) => {
      if (changedPath !== filePath) return;
      void resolveWikilinks(filePath).then((linked) => {
        if (cancelled) return;
        setLinkedPlaces(linked);
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [selectedPlace?.filePath]);

  // MapView.emitFeaturePosition returns early when there is no geometry, otherwise the
  // floating PlaceCard would keep the last screen position after a clear.
  useEffect(() => {
    const placeForMap = mapPeekPlace ?? selectedPlace;
    if (!placeForMap?.geometry) {
      setFeatureScreenPos(null);
    }
  }, [selectedPlace, mapPeekPlace]);

  const placeForMapHighlight = useMemo(
    () => mapPeekPlace ?? selectedPlace,
    [mapPeekPlace, selectedPlace]
  );

  const parentFolderForNewFiles = useMemo(
    () => selectedFolder ?? (lastVaultFilePath ? parentFolderOfVaultFile(lastVaultFilePath) : null),
    [selectedFolder, lastVaultFilePath]
  );

  const clearPlace = useCallback(() => {
    setSelectedPlace(null);
    setPlaceMode("mini");
    setFeatureScreenPos(null);
    setMapPeekPlace(null);
    setSelectionPulseAnchor(null);
  }, []);

  // Open a nav entry without pushing to history (used by back/forward/tab switch)
  const openEntry = useCallback(
    (entry: NavEntry) => {
      if (entry.kind === "place") {
        setSelectedPlace(entry.place);
        setPlaceMode("full");
        setSelectedFolder(null);
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        mapRef.current?.fitToPlace(entry.place, getMapPadding(true));
      } else if (entry.kind === "list") {
        setSelectedPlace(null);
        setSelectedFolder(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        if (entry.layer.points.length > 0) {
          mapRef.current?.fitToGeoJson(
            pointsFeatureCollection(entry.layer.points),
            getMapPadding(true)
          );
        }
      } else if (entry.kind === "directions") {
        setSelectedPlace(null);
        setSelectedFolder(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        // Frame the known stops; the panel refits to the full route once it computes.
        const ends = entry.stops.filter((w): w is DirectionsWaypoint => w !== null);
        if (ends.length > 0) {
          mapRef.current?.fitToGeoJson(pointsFeatureCollection(ends), getMapPadding(true));
        }
      } else {
        setSelectedFolder(entry.folderPath);
        setSelectedPlace(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        mapRef.current?.fitToFolder(entry.folderPath, getMapPadding(false));
      }
    },
    [getMapPadding]
  );

  const onNavEmpty = useCallback(() => {
    clearPlace();
    setSelectedFolder(null);
  }, [clearPlace]);

  const {
    nav,
    dispatchNav,
    navTabsData,
    activeTabIndex,
    canBack,
    canForward,
    handleNavTabActivate,
    handleNavTabClose,
    handleNavTabReorder,
    handleNavBack,
    handleNavForward
  } = useNavTabs({ openEntry, onEmpty: onNavEmpty });

  const isFullscreen = useFullscreen();

  const { byPath: placesByPath, loaded: placesIndexLoaded } = usePlacesIndex();
  // Read inside callbacks that must not churn identity when the index updates — the Map
  // is replaced on every file change, and these callbacks are passed deep into the tree.
  const placesByPathRef = useRef(placesByPath);
  placesByPathRef.current = placesByPath;

  /** A new overlay layer arrived (agent present_features, or a user search). It always
   *  becomes a list ("working set") tab whose layer rides in the nav entry — drawn only
   *  while that tab is active, so closing the tab clears its features. Nothing floats
   *  unowned on the map. */
  const handleOverlayLayer = useCallback(
    (layer: MapOverlayLayer) => {
      dispatchNav({
        type: "navigate",
        entry: { kind: "list", layerId: layer.id, label: layer.layerName || "Results", layer },
        newTab: true,
        activate: true
      });
      setSelectedPlace(null);
      setSelectedFolder(null);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      const frame = overlayFeatureCollection(layer);
      if (frame.features.length > 0) {
        mapRef.current?.fitToGeoJson(frame, getMapPadding(true));
      }
    },
    [dispatchNav, getMapPadding]
  );

  useMapOverlaySync({ addLayer: handleOverlayLayer });

  /** Current active tab entry — drives which pane (place / list / folder) is shown. */
  const activeNavEntry = useMemo(() => {
    const tab = nav.tabs[nav.activeTab];
    return tab ? tab.history[tab.cursor] : undefined;
  }, [nav]);

  /** The overlay layer backing the active list tab (null unless a list tab is active). */
  const activeListLayer = activeNavEntry?.kind === "list" ? activeNavEntry.layer : null;

  /** The active directions tab entry (null unless one is active) — drives the panel. */
  const activeDirectionsEntry = activeNavEntry?.kind === "directions" ? activeNavEntry : null;
  // Read by the map-pick handlers, which must not churn identity when stops change.
  const activeDirectionsEntryRef = useRef(activeDirectionsEntry);
  activeDirectionsEntryRef.current = activeDirectionsEntry;

  /** The computed route overlay, only while a directions tab is active. */
  const activeDirectionsRoute = activeDirectionsEntry ? directionsRouteLayer : null;

  /** Whether the main-pane slot is currently occupied by any pane — the full place
   *  card, a list tab, or a directions tab all share the same on-screen footprint.
   *  Callers that center on the live view pass this to `getMapPadding` so the target
   *  clears the pane instead of landing behind it. */
  const mainPaneOpen =
    (placeMode === "full" && selectedPlace !== null) ||
    activeListLayer !== null ||
    activeDirectionsEntry !== null;

  /** Overlay layers drawn now: the active list tab's layer, or the active directions tab's
   *  route. Both live in per-tab state, so a closed or backgrounded tab draws nothing — no
   *  layer floats unowned. */
  const visibleOverlayLayers = useMemo(() => {
    const extra = activeListLayer ?? activeDirectionsRoute;
    return extra ? [extra] : [];
  }, [activeListLayer, activeDirectionsRoute]);

  /** Set for the one route change a drag edit causes, so the camera stays where the user just
   *  dropped the stop instead of refitting the whole trip under their cursor. Consumed on the
   *  next report either way, so a failed re-route can't leave it armed for the change after. */
  const skipRouteFitRef = useRef(false);

  /** Directions panel reports its computed route (or null); frame it on the map. */
  const handleDirectionsRouteChange = useCallback(
    (layer: MapOverlayLayer | null) => {
      setDirectionsRouteLayer(layer);
      // A new (or cleared) route invalidates any step highlight from the previous one.
      setDirectionsHighlight(null);
      // The committed route has caught up with (or failed to reach) whatever the drag previewed.
      setRouteDragPreview(null);
      const skipFit = skipRouteFitRef.current;
      skipRouteFitRef.current = false;
      const line = skipFit ? null : layer?.lines[0];
      if (line && line.coordinates.length > 0) {
        mapRef.current?.fitToGeoJson(
          {
            type: "FeatureCollection" as const,
            features: [
              {
                type: "Feature" as const,
                geometry: { type: "LineString", coordinates: line.coordinates } as Record<
                  string,
                  unknown
                >,
                properties: null
              }
            ]
          },
          getMapPadding(true)
        );
      }
    },
    [getMapPadding]
  );

  /** A directions step was hovered or clicked: emphasize its segment on the map. Hover only
   *  highlights (`zoom` false); a click also zooms the camera to frame the segment. Null clears. */
  const handleDirectionsHighlight = useCallback(
    (coordinates: [number, number][] | null, zoom: boolean) => {
      setDirectionsHighlight(coordinates);
      if (zoom && coordinates && coordinates.length > 0) {
        mapRef.current?.fitToGeoJson(
          {
            type: "FeatureCollection" as const,
            features: [
              {
                type: "Feature" as const,
                geometry: { type: "LineString", coordinates } as Record<string, unknown>,
                properties: null
              }
            ]
          },
          getMapPadding(true)
        );
      }
    },
    [getMapPadding]
  );

  /** Open a Directions tab for the given ordered stops (stops[0] = origin, last =
   *  destination). When the first stop is null, default it to the user's current location
   *  (left blank if unavailable) — the app's Get-directions behavior. */
  const openDirectionsTab = useCallback(
    (
      stops: (DirectionsWaypoint | null)[],
      mode: TravelMode,
      opts?: { targetFilePath?: string; label?: string }
    ) => {
      const id = crypto.randomUUID();
      const open = (resolvedStops: (DirectionsWaypoint | null)[]): void => {
        dispatchNav({
          type: "navigate",
          entry: {
            kind: "directions",
            id,
            label: opts?.label ?? "Directions",
            stops: resolvedStops,
            mode,
            targetFilePath: opts?.targetFilePath
          },
          newTab: true,
          activate: true
        });
        setSelectedPlace(null);
        setSelectedFolder(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        // Frame the stops right away so the camera moves even before the route computes (and
        // stays put if it can't). handleDirectionsRouteChange re-fits to the line once routed.
        const framePoints = resolvedStops.filter((s): s is DirectionsWaypoint => s != null);
        if (framePoints.length > 0) {
          mapRef.current?.fitToGeoJson(
            {
              type: "FeatureCollection" as const,
              features: framePoints.map((s) => ({
                type: "Feature" as const,
                geometry: { type: "Point", coordinates: [s.lng, s.lat] } as Record<string, unknown>,
                properties: null
              }))
            },
            getMapPadding(true)
          );
        }
      };
      open(stops);
      // Fill a blank origin with the current location, but never block the tab on it:
      // getCurrentPosition can take its full 10s timeout, and a menu item that does
      // nothing for ten seconds reads as broken. The stops update in place when it lands.
      //
      // `fill-directions-origin` rather than `update-directions`: everything captured here is a
      // snapshot from before the wait, so writing back a whole stop list would revert any stop
      // the user added, retargeted, or re-moded in the meantime. The reducer touches stop 0 and
      // only while it is still blank, so a slow fix can never undo their work.
      if (stops[0]) return;
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          dispatchNav({
            type: "fill-directions-origin",
            id,
            waypoint: {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              label: "Your location"
            }
          }),
        () => {},
        { enableHighAccuracy: true, timeout: 10000 }
      );
    },
    [dispatchNav, getMapPadding]
  );

  /** Get-directions button on a place card: destination = the place, origin = current location.
   *  Index-resolved for the same reason as the armed-stop fill: the card's place may have come
   *  from a map click, whose record carries no `route` for waypointFromPlace to reject. */
  const handleGetDirections = useCallback(
    (place: PlaceRecord) => {
      const destination = waypointFromPlace(placesByPathRef.current.get(place.filePath) ?? place);
      if (destination) openDirectionsTab([null, destination], "auto");
    },
    [openDirectionsTab]
  );

  /** The directions stop a map click should fill: `{ tab id, stop index }`, or null when the
   *  map selects normally. Lifted from DirectionsPanel, which arms a stop when its blank
   *  input is focused. */
  const [armedStop, setArmedStop] = useState<{ id: string; index: number } | null>(null);
  const armedStopRef = useRef(armedStop);
  armedStopRef.current = armedStop;

  /**
   * Route a map pick into the armed directions stop. Returns true when it consumed the
   * click, so the caller skips its normal selection behaviour — the same shape as the
   * draw session's guard in MapView.
   */
  const fillArmedStop = useCallback(
    (waypoint: DirectionsWaypoint): boolean => {
      const armed = armedStopRef.current;
      const entry = activeDirectionsEntryRef.current;
      if (!armed || !entry || entry.id !== armed.id) return false;
      if (armed.index >= entry.stops.length) return false;
      dispatchNav({
        type: "update-directions",
        id: entry.id,
        stops: entry.stops.map((s, i) => (i === armed.index ? waypoint : s)),
        mode: entry.mode
      });
      setArmedStop(null);
      return true;
    },
    [dispatchNav]
  );

  /** Map right-click → routing. These open an *unbound* directions tab (no `targetFilePath`),
   *  so the trip is ephemeral until the user chooses "Save as a new route" in the panel —
   *  right-clicking the map should never write a file behind their back. */
  const handleDirectionsFromPoint = useCallback(
    (point: { lat: number; lng: number }) => {
      openDirectionsTab([waypointAtPoint(point), null], "auto");
    },
    [openDirectionsTab]
  );

  const handleDirectionsToPoint = useCallback(
    (point: { lat: number; lng: number }) => {
      openDirectionsTab([null, waypointAtPoint(point)], "auto");
    },
    [openDirectionsTab]
  );

  /** Right-click → "Add stop" on the open directions tab. */
  const handleAddStopAtPoint = useCallback(
    (point: { lat: number; lng: number }) => {
      const entry = activeDirectionsEntryRef.current;
      if (!entry) return;
      const stop = waypointAtPoint(point);
      const blank = entry.stops.indexOf(null);
      // A blank row is a stop the user is already trying to fill, so it wins. With every row
      // filled, a pick is a waypoint *along* the trip and belongs before the destination —
      // appending would silently re-route them somewhere they never asked to end up.
      const stops =
        blank >= 0
          ? entry.stops.map((s, i) => (i === blank ? stop : s))
          : [...entry.stops.slice(0, -1), stop, entry.stops[entry.stops.length - 1]];
      dispatchNav({ type: "update-directions", id: entry.id, stops, mode: entry.mode });
      setArmedStop(null);
    },
    [dispatchNav]
  );

  /**
   * Live re-routing while the route line is being dragged. The drag is *not* committed until it
   * ends — routing a candidate here keeps the panel (its itinerary, its loading state, the nav
   * entry) untouched while the shape follows the cursor.
   *
   * Paced by the routing itself rather than a timer: one request in flight, the newest position
   * queued behind it. A slow provider costs staleness, never a backlog.
   */
  const [routeDragPreview, setRouteDragPreview] = useState<[number, number][] | null>(null);
  const previewSeqRef = useRef(0);
  const previewInFlightRef = useRef(false);
  const previewQueuedRef = useRef<RouteDragEdit | null>(null);

  const runRoutePreview = useCallback(async (edit: RouteDragEdit): Promise<void> => {
    const entry = activeDirectionsEntryRef.current;
    if (!entry) return;
    const stops = applyRouteDragEdit(entry.stops, edit, waypointAtPoint).filter(
      (s): s is DirectionsWaypoint => s != null
    );
    if (stops.length < 2) return;
    const seq = ++previewSeqRef.current;
    previewInFlightRef.current = true;
    try {
      const route = await window.api.services.routingDirections({
        locations: stops.map((s) => ({ lat: s.lat, lng: s.lng })),
        costing: entry.mode
      });
      // Only the newest request may paint: an earlier one resolving late would rubber-band
      // the line backwards to a position the cursor has already left.
      if (seq === previewSeqRef.current) {
        setRouteDragPreview(route.geometry.coordinates as [number, number][]);
      }
    } catch {
      // Keep the last good shape. A momentary failure (a point off the road network, a
      // coverage gap mid-drag) shouldn't blank the route the user is steering.
    } finally {
      previewInFlightRef.current = false;
      const queued = previewQueuedRef.current;
      previewQueuedRef.current = null;
      if (queued) void runRoutePreview(queued);
    }
  }, []);

  const handleRouteDrag = useCallback(
    (edit: RouteDragEdit | null) => {
      if (!edit) {
        previewSeqRef.current++; // orphan anything in flight
        previewQueuedRef.current = null;
        setRouteDragPreview(null);
        return;
      }
      if (previewInFlightRef.current) {
        previewQueuedRef.current = edit;
        return;
      }
      void runRoutePreview(edit);
    },
    [runRoutePreview]
  );

  /**
   * Name a dragged stop from where it landed, so the panel's input reads like a stop the user
   * picked rather than a pair of coordinates.
   *
   * Deliberately after the fact: the drop commits its coordinates immediately (the route
   * recomputes without waiting on a geocoder), and this patches the label in when it arrives.
   * Only the newest drag is named — two patches racing would each rebuild the stop list from a
   * pre-patch snapshot, and the loser would erase the winner.
   */
  const stopLabelSeqRef = useRef(0);
  const nameDraggedStop = useCallback(
    async (entryId: string, point: { lat: number; lng: number }): Promise<void> => {
      const seq = ++stopLabelSeqRef.current;
      const results = await Promise.race([
        window.api.services.geocodingReverse({ point, limit: 1 }),
        // A slow cloud geocoder just leaves the coordinates in place.
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))
      ]).catch(() => null);
      const label = results?.[0]?.primaryLabel.trim();
      if (!label || seq !== stopLabelSeqRef.current) return;
      const entry = activeDirectionsEntryRef.current;
      if (!entry || entry.id !== entryId) return;
      // Rename only the stop still sitting on that point — the user may have moved it again.
      const stops = entry.stops.map((stop) =>
        stop && stop.lat === point.lat && stop.lng === point.lng ? { ...stop, label } : stop
      );
      // `map` keeps the identity of every stop it didn't rewrite, so this is "nothing matched".
      if (stops.every((stop, i) => stop === entry.stops[i])) return;
      // No `skipRouteFitRef` here: a label carries no coordinates, so the panel won't re-route
      // and no route would arrive to consume the flag — it would swallow the next real fit.
      dispatchNav({ type: "update-directions", id: entry.id, stops, mode: entry.mode });
    },
    [dispatchNav]
  );

  /** The drag was released: apply it to the tab's stops for real. The preview stays up until
   *  the panel reports the committed route, so the line never snaps back to the old shape. */
  const handleRouteDragEnd = useCallback(
    (edit: RouteDragEdit) => {
      const entry = activeDirectionsEntryRef.current;
      if (!entry) {
        handleRouteDrag(null);
        return;
      }
      const stops = applyRouteDragEdit(entry.stops, edit, waypointAtPoint);
      // Dropping a stop back where it started changes nothing, so no route would be reported
      // and the preview would never be cleared. Bail out and clear it here instead.
      if (sameStopCoordinates(stops, entry.stops)) {
        handleRouteDrag(null);
        return;
      }
      skipRouteFitRef.current = true;
      dispatchNav({ type: "update-directions", id: entry.id, stops, mode: entry.mode });
      void nameDraggedStop(entry.id, edit.point);
    },
    [dispatchNav, handleRouteDrag, nameDraggedStop]
  );

  /** "Draw a route" / "Edit route" on a place card: open a directions tab that saves back
   *  into this file, pre-filled from its saved route when it has one.
   *
   *  `fresh` starts over instead — it's what "Draw a route" means on a file that already has
   *  one, matching how "Draw a line" on an existing line starts a new line rather than editing
   *  it. Nothing is destroyed until the user saves the new route over the old one. */
  const handlePlanRoute = useCallback(
    (filePath: string, opts?: { fresh?: boolean }) => {
      // One editor per file. Two tabs bound to the same path is trivially reachable
      // (open the file, Edit route, back, Edit route) and the second would silently
      // overwrite whatever the first saved. A `fresh` request focuses that editor rather than
      // blanking it — discarding stops the user may still be working on would be worse than
      // handing them the tab they already have.
      const existing = nav.tabs.findIndex((tab) => {
        const entry = tab.history[tab.cursor];
        return entry.kind === "directions" && entry.targetFilePath === filePath;
      });
      if (existing >= 0) {
        handleNavTabActivate(existing);
        return;
      }
      const place = placesByPath.get(filePath);
      const saved = opts?.fresh ? null : (place?.route ?? null);
      // A blank plan starts empty rather than seeded with this file's own point — that
      // would ask the user to route to their destination from their destination, and the
      // point is about to be replaced by the route's line anyway.
      const stops: (DirectionsWaypoint | null)[] = saved
        ? saved.stops.map((s) => ({
            lat: s.lat,
            lng: s.lng,
            label: s.label,
            // A link that no longer resolves (renamed or deleted target) just drops back to
            // a plain coordinate stop — the trip still routes exactly as saved.
            filePath:
              s.file && vaultRoot
                ? (resolveWikilinkPath(s.file, vaultRoot, placesByPath.keys()) ?? undefined)
                : undefined
          }))
        : [null, null];
      openDirectionsTab(stops, saved?.mode ?? "auto", {
        targetFilePath: filePath,
        label: place?.title ?? (filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.md$/i, "")
      });
    },
    [nav.tabs, placesByPath, vaultRoot, handleNavTabActivate, openDirectionsTab]
  );

  /** True from a save until the write lands — the unbound branch is three IPC round-trips,
   *  so an unguarded double-click would create two near-identically named files. */
  const savingRouteRef = useRef(false);

  /** Persist a directions tab's route. Bound tabs write into their file; unbound ones
   *  create a place and then bind to it, so saving again updates instead of duplicating. */
  const handleSaveRoute = useCallback(
    async (
      entry: Extract<NavEntry, { kind: "directions" }>,
      payload: {
        stops: DirectionsWaypoint[];
        mode: TravelMode;
        coordinates: [number, number][];
        /** Destination folder the user picked for a new route; ignored by a bound save. */
        folderPath: string | null;
      }
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (savingRouteRef.current) return { ok: false, error: "Already saving" };
      const geometryJson = JSON.stringify({
        type: "LineString",
        coordinates: payload.coordinates
      });
      const wkt = geometryJsonToWkt(geometryJson);
      if (!wkt) return { ok: false, error: "This route can’t be saved as a shape" };
      const vaultPaths = placesByPathRef.current.keys();
      const route: RouteFrontmatter = {
        mode: payload.mode,
        stops: payload.stops.map((s) => ({
          label: s.label,
          lat: s.lat,
          lng: s.lng,
          // Identity only — the coordinates above are what the route is routed from.
          ...(s.filePath && vaultRootRef.current
            ? { file: wikilinkForFile(s.filePath, vaultRootRef.current, vaultPaths) }
            : {})
        }))
      };
      // The binding is trusted as-is; the write is what actually proves the file is there.
      // A getByPath pre-check would also report null for a `type: collection` note, which
      // exists perfectly well.
      const target = entry.targetFilePath ?? null;

      savingRouteRef.current = true;
      try {
        let filePath: string;
        if (target) {
          // One call, not two: a second write would re-read the file and can race the
          // first's awaitWriteFinish debounce.
          const write = await window.api.fs.writeFrontmatterProperties(target, {
            geometry: wkt,
            route
          });
          if (!write.success) {
            return { ok: false, error: write.error ?? "Couldn’t save to that file" };
          }
          filePath = target;
        } else {
          const create = await window.api.fs.createNoteFile({
            parentFolderPath: payload.folderPath,
            geometryWkt: wkt,
            includePlaceFrontmatterDefaults: false
          });
          if (!create.success)
            return { ok: false, error: create.error ?? "Couldn’t create a file" };
          const renamed = await renameCreatedPlaceToSlug(
            create.filePath,
            filenameBaseFromPlaceTitle(defaultRouteTitle(route.stops))
          );
          if (!renamed.ok) return { ok: false, error: renamed.error ?? "Couldn’t name the file" };
          const write = await window.api.fs.writeFrontmatterProperties(renamed.filePath, { route });
          if (!write.success) return { ok: false, error: write.error ?? "Couldn’t save the stops" };
          filePath = renamed.filePath;
        }

        // Same staleness dance as commitVaultGeometry: the watcher debounces, so merge in
        // what we know we just wrote rather than trusting getByPath alone.
        const fromIndex = (await window.api.places.getByPath(filePath)) ?? null;
        const saved: PlaceRecord = {
          ...(fromIndex ?? {
            filePath,
            title: (filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.md$/i, ""),
            type: "place"
          }),
          geometry: geometryJson,
          route
        };
        if (!target) {
          dispatchNav({
            type: "bind-directions",
            id: entry.id,
            targetFilePath: filePath,
            label: saved.title
          });
        }
        dispatchNav({ type: "update-entry", filePath, place: saved });
        mapRef.current?.invalidateFolderPlace(filePath);
        // Navigate in place rather than closing the tab: the directions entry stays behind
        // in history, so Back returns to the editor with the stops intact.
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        setSelectedFolder(null);
        setFeatureScreenPos(null);
        setSelectedPlace(saved);
        setPlaceMode("full");
        dispatchNav({ type: "navigate", entry: { kind: "place", place: saved }, newTab: false });
        mapRef.current?.fitToPlace(saved, getMapPadding(true));
        return { ok: true };
      } finally {
        savingRouteRef.current = false;
      }
    },
    [dispatchNav, getMapPadding]
  );

  /** Click a list row: for a point, open the mini place card over its marker (same as
   *  clicking the marker). For a line or polygon there's no card — just frame it. */
  const handleOpenListRow = useCallback(
    (row: FeatureListRow) => {
      if (row.geometryKind === "line" || row.geometryKind === "polygon") {
        const geometry =
          row.geometryKind === "line"
            ? activeListLayer?.lines.find((l) => l.id === row.id)
            : activeListLayer?.polygons.find((pg) => pg.id === row.id);
        if (!geometry) return;
        const feature =
          row.geometryKind === "line"
            ? { type: "LineString", coordinates: geometry.coordinates }
            : { type: "Polygon", coordinates: geometry.coordinates };
        mapRef.current?.fitToGeoJson(geometryFeatureCollection([feature]), getMapPadding(true));
        return;
      }
      let place: PlaceRecord | null = null;
      if (row.isVault) {
        place = placesByPath.get(row.id.slice("vault:".length)) ?? null;
      } else {
        const point = activeListLayer?.points.find((p) => p.id === row.id);
        if (point) place = previewPlaceFromOverlayPoint(point);
      }
      if (!place) return;
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      if (typeof row.lat === "number" && typeof row.lng === "number") {
        // Pan and center at the current zoom — don't zoom in on the feature, and don't
        // move at all if it's already visible clear of the sidebars (see panToPlace).
        // The list panel shares the main-pane slot, so pad for it (`true`) — otherwise
        // points hidden behind the panel read as "in view" and never get panned.
        mapRef.current?.panToPlace(place, getMapPadding(true));
      }
    },
    [activeListLayer, placesByPath, getMapPadding]
  );

  /** Remove one feature from the active list layer (does not touch the vault). Rebuilds
   *  the layer without that id and updates the nav entry so the map + list stay in sync. */
  const handleDismissListFeature = useCallback(
    (rowId: string) => {
      if (!activeListLayer) return;
      const next: MapOverlayLayer = {
        ...activeListLayer,
        points: activeListLayer.points.filter((p) => p.id !== rowId),
        lines: activeListLayer.lines.filter((l) => l.id !== rowId),
        polygons: activeListLayer.polygons.filter((pg) => pg.id !== rowId),
        ...(activeListLayer.vaultPaths
          ? { vaultPaths: activeListLayer.vaultPaths.filter((p) => `vault:${p}` !== rowId) }
          : {})
      };
      if (focusedFeatureId === rowId) setFocusedFeatureId(null);
      dispatchNav({ type: "update-list", layerId: activeListLayer.id, layer: next });
    },
    [activeListLayer, focusedFeatureId, dispatchNav]
  );

  /** Vault places referenced by overlay layers (`vaultPaths`), resolved against the
   * live index. They may lie outside the selected folder, so the map draws them
   * alongside the overlay layers they arrived with. */
  /**
   * The selected place's saved route stops, split by whether their `[[wikilink]]` resolves.
   * A linked stop draws as its real place marker — name, colour, clickable card — and only
   * the rest fall back to anonymous dots.
   *
   * Resolved through the index because `selectedPlace` may have come from a map click, and
   * those records are built from SQLite rows that never carry a route.
   */
  const { routeStopPlaces, routeStopDots } = useMemo(() => {
    const stops = selectedPlace
      ? (placesByPath.get(selectedPlace.filePath)?.route?.stops ?? [])
      : [];
    const places: PlaceRecord[] = [];
    const dots: RouteStop[] = [];
    for (const stop of stops) {
      const path =
        stop.file && vaultRoot
          ? resolveWikilinkPath(stop.file, vaultRoot, placesByPath.keys())
          : null;
      const place = path ? placesByPath.get(path) : undefined;
      // Skip the route file itself so it can't be drawn as one of its own stops.
      if (place?.geometry && place.filePath !== selectedPlace?.filePath) places.push(place);
      else dots.push(stop);
    }
    return { routeStopPlaces: places, routeStopDots: dots };
  }, [selectedPlace, placesByPath, vaultRoot]);

  /** Body wikilinks plus any route stops that resolved to a place, deduped. */
  const linkedPlacesForMap = useMemo(() => {
    if (routeStopPlaces.length === 0) return linkedPlaces;
    const seen = new Set(linkedPlaces.map((p) => p.filePath));
    return [...linkedPlaces, ...routeStopPlaces.filter((p) => !seen.has(p.filePath))];
  }, [linkedPlaces, routeStopPlaces]);

  const presentedPlaces = useMemo(() => {
    const seen = new Set<string>();
    const places: PlaceRecord[] = [];
    for (const layer of visibleOverlayLayers) {
      for (const path of layer.vaultPaths ?? []) {
        if (seen.has(path)) continue;
        seen.add(path);
        const place = placesByPath.get(path);
        if (place) places.push(place);
      }
    }
    return places;
  }, [visibleOverlayLayers, placesByPath]);

  /** `pan_to` map command: route through the map handle so the camera respects
   * sidebar/main-pane padding instead of centering behind them. */
  useEffect(() => {
    window.api.map.onPanTo(({ lat, lng, zoom }) => {
      mapRef.current?.flyTo(lat, lng, { zoom, padding: getMapPadding(mainPaneOpen) });
    });
    return () => window.api.map.removeListeners();
  }, [getMapPadding, mainPaneOpen]);

  /** Push the current tab/selection state to main so the agent's get_active_file /
   * get_open_tabs tools can see what the user is looking at. Mirrors the viewport push. */
  useEffect(() => {
    const toInfo = (tab: (typeof nav.tabs)[number]) => {
      const cur = tab.history[tab.cursor];
      if (cur.kind === "place")
        return { path: cur.place.filePath, kind: "place" as const, title: cur.place.title };
      if (cur.kind === "folder")
        return { path: cur.folderPath, kind: "folder" as const, title: cur.label };
      // List tabs are ephemeral working sets the agent itself produced — not reported.
      return null;
    };
    const infos = nav.tabs.map(toInfo);
    const tabs = infos.filter((t): t is NonNullable<typeof t> => t !== null);
    const active = nav.activeTab >= 0 ? (infos[nav.activeTab] ?? null) : null;
    window.api.nav.sendNavState({
      active,
      activeIndex: active ? tabs.indexOf(active) : -1,
      tabs
    });
  }, [nav]);

  /** "My location" control: store the fix for the marker layer and center on it
   * through the same padding-aware handle so it isn't hidden behind open panes. */
  const handleUserLocationChange = useCallback(
    (location: UserLocation, targetZoom: number) => {
      setUserLocation(location);
      mapRef.current?.flyTo(location.lat, location.lng, {
        zoom: targetZoom,
        padding: getMapPadding(mainPaneOpen)
      });
    },
    [getMapPadding, mainPaneOpen]
  );

  /** Keep file-based GeoJSON on the map in sync with selection (clears when navigating away). */
  const geoJsonLayerPlacePath =
    selectedPlace?.type === "GeoJsonLayer" ? selectedPlace.filePath : null;

  useEffect(() => {
    if (geoJsonLayerPlacePath) {
      let cancelled = false;
      setActiveGeoJsonLayers([]);
      void (async () => {
        const data = await window.api.fs.readGeoJson(geoJsonLayerPlacePath);
        if (cancelled || !data) return;
        const layerBbox = bbox(data as unknown as Parameters<typeof bbox>[0]) as [
          number,
          number,
          number,
          number
        ];
        setActiveGeoJsonLayers([{ filePath: geoJsonLayerPlacePath, data, bbox: layerBbox }]);
      })();
      return () => {
        cancelled = true;
      };
    }

    if (selectedFolder) {
      let cancelled = false;
      setActiveGeoJsonLayers([]);
      void window.api.fs.geoJsonFilesInFolder(selectedFolder).then(async (paths) => {
        if (cancelled) return;
        const results = await Promise.all(paths.map((p) => window.api.fs.readGeoJson(p)));
        if (cancelled) return;
        const layers = results.flatMap((data, i) =>
          data
            ? [
                {
                  filePath: paths[i],
                  data,
                  bbox: bbox(data as unknown as Parameters<typeof bbox>[0]) as [
                    number,
                    number,
                    number,
                    number
                  ]
                }
              ]
            : []
        );
        setActiveGeoJsonLayers(layers);
      });
      return () => {
        cancelled = true;
      };
    }

    setActiveGeoJsonLayers([]);
    return undefined;
  }, [geoJsonLayerPlacePath, selectedFolder]);

  /** Live-refresh a .geojson on disk if it's currently rendered on the map (e.g. an
   * external editor or agent overwrote the file). Surgical: only re-reads the file
   * that changed, patches just that entry in the layer list. */
  useEffect(() => {
    const off = window.api.fs.onFileContentChanged(async ({ filePath }) => {
      if (!filePath.toLowerCase().endsWith(".geojson")) return;
      if (!activeGeoJsonLayers.some((l) => l.filePath === filePath)) return;
      const data = await window.api.fs.readGeoJson(filePath);
      if (!data) return;
      const layerBbox = bbox(data as unknown as Parameters<typeof bbox>[0]) as [
        number,
        number,
        number,
        number
      ];
      setActiveGeoJsonLayers((prev) =>
        prev.map((layer) =>
          layer.filePath === filePath ? { filePath, data, bbox: layerBbox } : layer
        )
      );
    });
    return off;
  }, [activeGeoJsonLayers]);

  useShortcuts([
    {
      def: { key: "w", meta: true, enabled: activeTabIndex >= 0 },
      handler: () => handleCloseTab(activeTabIndex)
    },
    {
      def: { code: "BracketLeft", meta: true, enabled: canBack },
      handler: handleNavBack
    },
    {
      def: { code: "BracketRight", meta: true, enabled: canForward },
      handler: handleNavForward
    },
    {
      def: { code: "BracketLeft", meta: true, shift: true, enabled: navTabsData.length > 1 },
      handler: () =>
        handleNavTabActivate((activeTabIndex - 1 + navTabsData.length) % navTabsData.length)
    },
    {
      def: { code: "BracketRight", meta: true, shift: true, enabled: navTabsData.length > 1 },
      handler: () => handleNavTabActivate((activeTabIndex + 1) % navTabsData.length)
    }
  ]);

  const handleCloseTab = useCallback(
    (index: number) => {
      handleNavTabClose(index);
    },
    [handleNavTabClose]
  );

  const handlePlaceCardClose = useCallback(() => {
    setMapPeekPlace(null);
    // Full place cards should close exactly like the active top-bar tab.
    if (placeMode !== "full" || activeTabIndex < 0) {
      clearPlace();
      return;
    }
    handleCloseTab(activeTabIndex);
  }, [placeMode, activeTabIndex, clearPlace, handleCloseTab]);

  // Map feature click — mini card, or peek mini while full panel stays open
  const handleSelectPlaceFromMap = useCallback(
    (place: PlaceRecord, meta?: MapSelectPlaceMeta) => {
      // A blank directions stop is waiting for a pick: clicking a feature fills it with
      // that place rather than opening its card. Falls through for a place with no
      // derivable point (a geometry-less note, or a saved route), which can't be an
      // endpoint. Resolved through the index first because a map click builds its record
      // from a SQLite row, and those never carry the `route` the guard tests.
      const indexed = placesByPathRef.current.get(place.filePath) ?? place;
      const asWaypoint = waypointFromPlace(indexed);
      if (asWaypoint && fillArmedStop(asWaypoint)) return;

      const useClickPulse =
        Boolean(meta?.mapClickLngLat) && geometryUsesMapClickPulseAnchor(place.geometry);
      if (useClickPulse && meta?.mapClickLngLat) {
        // A route already draws its own stops along its line — a saved one from the index, a
        // live one as the directions overlay — so the anchor there still positions the card,
        // but a dot on top of it would read as one more stop.
        const drawsOwnStops =
          Boolean(indexed.route) || place.filePath.includes(DIRECTIONS_OVERLAY_PREFIX);
        setSelectionPulseAnchor({
          filePath: place.filePath,
          lng: meta.mapClickLngLat.lng,
          lat: meta.mapClickLngLat.lat,
          showDot: !drawsOwnStops
        });
      } else {
        setSelectionPulseAnchor(null);
      }

      if (placeMode === "full") {
        // Clicking the open file's own marker returns the highlight to it
        // instead of floating a duplicate mini card over its full panel.
        if (selectedPlaceRef.current?.filePath === place.filePath) {
          setMapPeekPlace(null);
          setFeatureScreenPos(null);
          return;
        }
        setMapPeekPlace(place);
        setFeatureScreenPos(null);
        return;
      }
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
    },
    [placeMode, fillArmedStop]
  );

  // Sidebar file click — navigate within active tab (or background tab on cmd/ctrl+click)
  const handleSelectPlaceFromSidebar = useCallback(
    (place: PlaceRecord, newTab = false) => {
      // Cmd/ctrl-click → open in background tab (browser convention): add to nav,
      // but don't disturb the currently visible view, selection, or map fit.
      if (newTab) {
        dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: true });
        return;
      }
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      const alreadyOpen = placeMode === "full" && selectedPlace?.filePath === place.filePath;
      setSelectedPlace(place);
      setPlaceMode("full");
      setSelectedFolder(null);
      setFeatureScreenPos(null);
      dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: false });
      if (!alreadyOpen) {
        mapRef.current?.fitToPlace(place, getMapPadding(true));
      }
    },
    [placeMode, selectedPlace, getMapPadding, dispatchNav]
  );

  /** `open_file` agent command: resolve the path to a place record and open it in a tab,
   * exactly as a sidebar click would. Ignores non-place paths (folders/unknown). */
  useEffect(() => {
    window.api.nav.onOpenFile(async ({ path }) => {
      const place = await window.api.places.getByPath(path);
      if (place) handleSelectPlaceFromSidebar(place);
    });
    // `present_directions`: open a Directions tab for the stops the agent resolved.
    window.api.nav.onOpenDirections(({ stops, mode }) => {
      openDirectionsTab(stops, mode);
    });
    return () => window.api.nav.removeListeners();
  }, [handleSelectPlaceFromSidebar, openDirectionsTab]);

  /** `get_current_location` agent request: run the same geolocation fix as the "My
   * location" control and reply with the coords. When `reveal` is set, also drop the
   * marker and fly to it (identical to clicking the button); otherwise stay silent so
   * the agent can read the location without hijacking the user's view. */
  useEffect(() => {
    window.api.geo.onLocateRequest(({ id, reveal }) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          if (reveal) {
            const zoom = mapRef.current?.getZoom() ?? 0;
            handleUserLocationChange(
              { lng: longitude, lat: latitude, accuracy },
              Math.max(zoom, 14)
            );
          }
          window.api.geo.sendLocateReply({ id, ok: true, lat: latitude, lng: longitude, accuracy });
        },
        (err) => {
          const error =
            err.code === err.PERMISSION_DENIED
              ? "Location access denied"
              : err.code === err.TIMEOUT
                ? "Location timed out"
                : "Location unavailable";
          window.api.geo.sendLocateReply({ id, ok: false, error });
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
    return () => window.api.geo.removeListeners();
  }, [handleUserLocationChange]);

  /** Wikilink click in a place card body: mini card over the target feature
   * (a floating peek when a full panel is open), matching map-click semantics.
   * Cmd/ctrl+click keeps the browser convention: open as a full background tab. */
  const handleOpenWikilink = useCallback(
    (place: PlaceRecord, newTab = false) => {
      if (newTab) {
        handleSelectPlaceFromSidebar(place, true);
        return;
      }
      setSelectionPulseAnchor(null);
      setFeatureScreenPos(null);
      if (placeMode === "full") {
        // Link to the open file itself: just bring its feature into view.
        if (selectedPlace?.filePath !== place.filePath) setMapPeekPlace(place);
        mapRef.current?.panToPlace(place, getMapPadding(true));
        return;
      }
      setMapPeekPlace(null);
      setSelectedPlace(place);
      setPlaceMode("mini");
      mapRef.current?.panToPlace(place, getMapPadding(false));
    },
    [placeMode, selectedPlace, getMapPadding, handleSelectPlaceFromSidebar]
  );

  // Sidebar folder click — navigate within active tab (or background tab on cmd/ctrl+click)
  const handleSelectFolder = useCallback(
    (folderPath: string, newTab = false) => {
      const entry: NavEntry = {
        kind: "folder",
        folderPath,
        label: folderLabel(folderPath)
      };
      if (newTab) {
        dispatchNav({ type: "navigate", entry, newTab: true });
        return;
      }
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      setSelectedFolder(folderPath);
      setSelectedPlace(null);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      dispatchNav({ type: "navigate", entry, newTab: false });
      mapRef.current?.fitToFolder(folderPath, getMapPadding(false));
    },
    [getMapPadding, dispatchNav]
  );

  const handleSelectGeoJson = useCallback(
    async (filePath: string) => {
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      const data = await window.api.fs.readGeoJson(filePath);
      if (!data) return;

      const title = String(
        (data as Record<string, unknown>).name ??
          filePath
            .split("/")
            .pop()
            ?.replace(/\.geojson$/i, "") ??
          filePath
      );
      const place: PlaceRecord = { filePath, type: "GeoJsonLayer", title };
      setSelectedPlace(place);
      setPlaceMode("full");
      setSelectedFolder(null);
      setFeatureScreenPos(null);
      dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: false });

      // @ts-expect-error - data shape matches RawFeatureCollection
      mapRef.current?.fitToGeoJson(data, getMapPadding(true));
    },
    [getMapPadding, dispatchNav]
  );

  // New place file created from map context menu
  const handleCreatePlace = useCallback(
    (rawPlace: PlaceRecord) => {
      const place: PlaceRecord = { ...rawPlace, justCreated: true };
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      if (selectedFolder) {
        setSelectedPlace(place);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
      } else {
        setSelectedPlace(place);
        setPlaceMode("full");
        setFeatureScreenPos(null);
        dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: false });
        mapRef.current?.fitToPlace(place, getMapPadding(true));
      }
    },
    [selectedFolder, getMapPadding, dispatchNav]
  );

  /** "+" in the tab strip: create a blank note in the chosen folder (null → vault root) and
   *  open it in a new tab, title selected for rename (justCreated), same as the sidebar's new note. */
  const handleNewNoteInFolder = useCallback(
    async (folderPath: string | null) => {
      const parent = folderPath ?? vaultRoot;
      if (!parent) return;
      const result = await window.api.fs.createNoteFile({ parentFolderPath: parent });
      if (!result.success) return;
      const filePath = result.filePath;
      const title = (filePath.split(/[/\\]/).pop() ?? "Untitled.md").replace(/\.md$/i, "");
      const resolved = (await window.api.places.getByPath(filePath)) ?? {
        title,
        type: "note",
        filePath
      };
      const place: PlaceRecord = { ...resolved, justCreated: true };
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      setSelectedPlace(place);
      setPlaceMode("full");
      setSelectedFolder(null);
      setFeatureScreenPos(null);
      dispatchNav({
        type: "navigate",
        entry: { kind: "place", place },
        newTab: true,
        activate: true
      });
    },
    [vaultRoot, dispatchNav]
  );

  const handleGeocodeSearchResult = useCallback(
    (r: GeocodeSearchResult) => {
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      const place = placeFromGeocodeSearchResult(r);
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      mapRef.current?.fitToPlace(place, getMapPadding(false));
    },
    [getMapPadding]
  );

  /** "Open all results as a list": build an overlay layer from the search results and
   *  open it as a working-set tab (the same surface the agent's present_features uses). */
  const handleOpenSearchResults = useCallback(
    (results: GeocodeSearchResult[], query: string, files: PlaceRecord[]) => {
      const points = results.map((r) => {
        const properties = detailPropertiesFromGeocodeResult(r);
        return {
          id: `search-${r.id}`,
          lat: r.lat,
          lng: r.lng,
          title: r.primaryLabel,
          ...(Object.keys(properties).length > 0 ? { properties } : {})
        };
      });
      // Vault files that matched the search ride along as vault rows (file icon, no
      // add action) — the panel resolves them against the index by path.
      const vaultPaths = files.map((f) => f.filePath);
      if (points.length === 0 && vaultPaths.length === 0) return;
      handleOverlayLayer({
        id: `search:${crypto.randomUUID()}`,
        layerName: query.trim() || "Search results",
        points,
        lines: [],
        polygons: [],
        ...(vaultPaths.length > 0 ? { vaultPaths } : {})
      });
    },
    [handleOverlayLayer]
  );

  // Flattened view of the indexed vault for the search popover's "Files" group.
  const indexedFiles = useMemo(() => Array.from(placesByPath.values()), [placesByPath]);

  /** Path → geometry kind, so the sidebar tree can show which files are on the map. Derived
   *  once per index change rather than per render, since ProjectSidebar is memoized. */
  const geometryKinds = useMemo(() => {
    const kinds = new Map<string, GeometryKind>();
    for (const place of placesByPath.values()) {
      const kind = geometryKindOf(place.geometry);
      if (kind) kinds.set(place.filePath, kind);
    }
    return kinds;
  }, [placesByPath]);

  /** Path → the file's own `icon`/`color`, for the sidebar tree's row icons. Sparse on purpose:
   *  most files set neither, so only the ones that do get an entry. */
  const fileAppearance = useMemo(() => {
    const marks = new Map<string, { icon?: string; color?: string }>();
    for (const place of placesByPath.values()) {
      if (place.icon || place.color) {
        marks.set(place.filePath, { icon: place.icon, color: place.color });
      }
    }
    return marks;
  }, [placesByPath]);

  /** Tab glyphs, resolved against the live index rather than the history entry the tab was opened
   *  with. A nav entry is a snapshot: an `icon`/`color` set by a hand-edit, the agent, or any
   *  surface other than the card's own optimistic write would leave an open tab showing the glyph
   *  the file had when it was opened. Falls back to the entry for a file not (yet) indexed. */
  const navTabs = useMemo(
    () =>
      navTabsData.map((tab) => {
        if (tab.kind !== "place") return tab;
        const indexed = placesByPath.get(tab.filePath);
        if (!indexed) return tab;
        return {
          ...tab,
          icon: indexed.icon,
          color: indexed.color,
          geometryKind: geometryKindOf(indexed.geometry)
        };
      }),
    [navTabsData, placesByPath]
  );

  const handleSearchSelectFile = useCallback(
    (file: PlaceRecord) => {
      if (file.type === "GeoJsonLayer") {
        void handleSelectGeoJson(file.filePath);
        return;
      }
      handleSelectPlaceFromSidebar(file);
    },
    [handleSelectGeoJson, handleSelectPlaceFromSidebar]
  );

  /** Persist any supported geometry to a place file's `geometry` frontmatter.
   *  `fit` recenters the map on the result — wanted when the geometry came from a
   *  search result, not when the user just drew it and is already looking at it. */
  const commitVaultGeometry = useCallback(
    async (filePath: string, geometryJson: string, opts?: { fit?: boolean }): Promise<boolean> => {
      const wkt = geometryJsonToWkt(geometryJson);
      if (!wkt) {
        console.error("[commit geometry] unsupported geometry", geometryJson.slice(0, 120));
        return false;
      }
      const write = await window.api.fs.writeFrontmatterProperties(
        filePath,
        // Reshaping the geometry orphans a saved route: its stops would still describe the
        // old trip. Sent unconditionally — deleting a key the file doesn't have is a no-op,
        // and gating on the renderer's index copy leaves the route behind whenever that copy
        // hasn't caught up with the file yet.
        { geometry: wkt, route: null }
      );
      if (!write.success) {
        console.error("[commit geometry]", write.error);
        return false;
      }
      // `places.getByPath` reads the in-memory index updated by the file watcher, which uses
      // awaitWriteFinish — so it is often still stale immediately after a write. Merge the
      // geometry we know we just persisted instead of trusting getByPath alone.
      const fromIndex = (await window.api.places.getByPath(filePath)) ?? null;
      const updated: PlaceRecord = {
        ...(fromIndex ?? {
          filePath,
          title: (filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.md$/i, ""),
          type: "place"
        }),
        geometry: geometryJson
      };
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      setSelectedPlace(updated);
      dispatchNav({ type: "update-entry", filePath: updated.filePath, place: updated });
      if (opts?.fit !== false) {
        mapRef.current?.fitToPlace(updated, getMapPadding(placeMode === "full"));
      } else {
        // No camera move, but the folder layer still holds the pre-write geometry.
        mapRef.current?.invalidateFolderPlace(filePath);
      }
      return true;
    },
    [getMapPadding, placeMode, dispatchNav]
  );

  /** Reflect an `icon`/`color` write the card already persisted. Same reason as
   *  `commitVaultGeometry`'s merge: the watcher's awaitWriteFinish means `places:updated` is ~300ms
   *  out, and `selectedPlace` is a snapshot nothing re-derives — so the map keeps the old pin until
   *  the folder layer is invalidated. `null` in the patch means the key was deleted. */
  const handleAppearanceChange = useCallback(
    (filePath: string, patch: { icon?: string | null; color?: string | null }) => {
      // A key absent from the patch is untouched; `null` means it was deleted.
      const merged: Partial<PlaceRecord> = {};
      if ("icon" in patch) merged.icon = patch.icon ?? undefined;
      if ("color" in patch) merged.color = patch.color ?? undefined;
      setSelectedPlace((prev) => (prev?.filePath === filePath ? { ...prev, ...merged } : prev));
      dispatchNav({ type: "patch-entry", filePath, patch: merged });
      mapRef.current?.invalidateFolderPlace(filePath);
    },
    [dispatchNav]
  );

  const commitVaultPointLocation = useCallback(
    (filePath: string, lat: number, lng: number): Promise<boolean> =>
      commitVaultGeometry(filePath, JSON.stringify({ type: "Point", coordinates: [lng, lat] })),
    [commitVaultGeometry]
  );

  const clearVaultPointLocation = useCallback(
    async (filePath: string): Promise<boolean> => {
      // `route` goes with the geometry: its stops describe a trip the file no longer
      // holds a shape for, and leaving the key behind keeps the stops on the map and the
      // menu item reading "Edit route". Unconditional for the reason in commitVaultGeometry.
      const write = await window.api.fs.writeFrontmatterProperties(filePath, {
        geometry: null,
        route: null
      });
      if (!write.success) {
        console.error("[clear location]", write.error);
        return false;
      }
      const fromIndex = (await window.api.places.getByPath(filePath)) ?? null;
      const base: PlaceRecord =
        fromIndex ??
        ({
          filePath,
          title: (filePath.split(/[/\\]/).pop() ?? filePath).replace(/\.md$/i, ""),
          type: "note"
        } satisfies PlaceRecord);
      const cleared = { ...base, geometry: undefined, route: undefined };
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      setSelectedPlace(cleared);
      dispatchNav({ type: "update-entry", filePath, place: cleared });
      mapRef.current?.invalidateFolderPlace(filePath);
      return true;
    },
    [dispatchNav]
  );

  // Map drawing. The session names the file it will write to; `editedGeometry` is
  // the unsaved result of a "select" session, which (unlike drawing) has no moment
  // the user's intent is complete, so it is held here until they press Save.
  const [drawSession, setDrawSession] = useState<DrawSession | null>(null);
  const [editedGeometry, setEditedGeometry] = useState<string | null>(null);
  /** True from a finished shape until its write lands. See `commitSessionGeometry`. */
  const committingRef = useRef(false);

  const startDrawing = useCallback((filePath: string, shape: DrawShape) => {
    setEditedGeometry(null);
    setDrawSession({ filePath, mode: shape });
  }, []);

  const startEditingGeometry = useCallback((filePath: string, geometry: string) => {
    setEditedGeometry(null);
    setDrawSession({ filePath, mode: "select", initialGeometry: geometry });
  }, []);

  const cancelDrawing = useCallback(() => {
    // The commit owns the teardown; Escape or a navigation landing mid-write must
    // not clear the session out from under it and re-expose the old geometry.
    if (committingRef.current) return;
    setDrawSession(null);
    setEditedGeometry(null);
  }, []);

  /**
   * Persist a finished session's geometry, then end the session — in that order.
   *
   * Ending it first would drop the suppression that hides the file's previous
   * geometry (see MapView's `editingFilePath`) while the write is still two IPC
   * round-trips from returning, so the old shape snaps back for ~80ms before the
   * new one replaces it. Holding the session open until the write lands keeps
   * Terra Draw's copy of the new shape on screen across the handover instead.
   *
   * `committingRef` covers the same window against a second `finish` — the map is
   * still live and in draw mode until the session actually clears.
   */
  const commitSessionGeometry = useCallback(
    async (target: string, geometryJson: string) => {
      if (committingRef.current) return;
      committingRef.current = true;
      try {
        // fit: false — the shape was just drawn in view; moving the camera under the
        // user at the moment they finish reads as the app losing their work.
        await commitVaultGeometry(target, geometryJson, { fit: false });
      } finally {
        committingRef.current = false;
        setDrawSession(null);
        setEditedGeometry(null);
      }
    },
    [commitVaultGeometry]
  );

  const handleDrawFinish = useCallback(
    (geometry: Geometry) => {
      const target = drawSession?.filePath;
      if (!target) return;
      void commitSessionGeometry(target, JSON.stringify(geometry));
    },
    [drawSession, commitSessionGeometry]
  );

  const saveEditedGeometry = useCallback(() => {
    const target = drawSession?.filePath;
    if (!target || !editedGeometry) return;
    void commitSessionGeometry(target, editedGeometry);
  }, [drawSession, editedGeometry, commitSessionGeometry]);

  // Escape is the universal way out. Capture phase so it wins over the place card's
  // own Escape handler (which would close the card and strand the session).
  useEffect(() => {
    if (!drawSession) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      cancelDrawing();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drawSession, cancelDrawing]);

  // Navigating away from the file being drawn on abandons the session — otherwise
  // the next shape would land in a file the user is no longer looking at.
  useEffect(() => {
    if (drawSession && selectedPlace?.filePath !== drawSession.filePath) cancelDrawing();
  }, [drawSession, selectedPlace, cancelDrawing]);

  /** Write a preview place (search result / overlay feature) to the vault as a new file,
   *  returning the resulting PlaceRecord. Pure file-creation: no selection or nav side
   *  effects, so it is safe to call in a loop for bulk saves. */
  const createPlaceFileFromPreview = useCallback(
    async (place: PlaceRecord, folderPath: string | null): Promise<PlaceRecord | null> => {
      if (place.previewMarkdown === undefined || !place.geometry) return null;
      // Preserve the feature's geometry type: points save as lat/lng, lines and
      // polygons as WKT — otherwise a selected polygon would be flattened to a point.
      const geometryArgs = geometryJsonToCreateArgs(place.geometry);
      if (!geometryArgs) return null;
      const create = await window.api.fs.createNoteFile({
        parentFolderPath: folderPath,
        ...geometryArgs,
        includePlaceFrontmatterDefaults: false
      });
      if (!create.success) {
        console.error("[save place]", create.error);
        return null;
      }
      const baseName = filenameBaseFromPlaceTitle(place.title);
      const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
      if (!renamed.ok) {
        console.error("[save place]", renamed.error);
        return null;
      }
      // Persist the previewed details as frontmatter (canonical order, empties dropped)
      // so the saved file matches the preview card exactly.
      const properties = orderDetailProperties(place.properties);
      // Keep the previewed Wikimedia photo: kick the download off now so it
      // overlaps the file writes below. Best-effort — offline or imageless QIDs skip.
      const qid = properties.wikidata_id;
      const coverImport =
        typeof qid === "string" && /^Q\d+$/.test(qid) ? window.api.wiki.importImage(qid) : null;
      if (Object.keys(properties).length > 0) {
        const wp = await window.api.fs.writeFrontmatterProperties(renamed.filePath, properties);
        if (!wp.success) console.error("[save place] write properties", wp.error);
      }
      if (place.previewMarkdown.trim()) {
        const w = await window.api.fs.writePlaceBody(renamed.filePath, place.previewMarkdown);
        if (!w.success) console.error("[save place] write body", w.error);
      }
      if (coverImport) {
        const writeCover = async (img: Awaited<typeof coverImport>) => {
          if (!img.success) return;
          const wc = await window.api.fs.writeFrontmatterProperties(renamed.filePath, {
            cover: img.relPath,
            // Reserved key: hidden from the properties grid, surfaced as the
            // lightbox "Source" attribution link.
            cover_source: img.pageUrl
          });
          if (!wc.success) console.error("[save place] write cover", wc.error);
        };
        // Wait briefly so the fast path opens the card with its cover already
        // set; on a slow network stop blocking the card open and let the write
        // land in the background (the cover shows the next time the card opens).
        const img = await Promise.race([
          coverImport,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500))
        ]);
        if (img) await writeCover(img);
        else void coverImport.then(writeCover);
      }
      return (
        (await window.api.places.getByPath(renamed.filePath)) ??
        ({
          filePath: renamed.filePath,
          title: place.title,
          type: "place",
          geometry: place.geometry
        } satisfies PlaceRecord)
      );
    },
    []
  );

  const savePreviewPlaceToVault = useCallback(
    async (place: PlaceRecord | null, folderPathOverride?: string | null) => {
      if (place?.previewMarkdown === undefined || !place.geometry) return;
      const parentFolderPath =
        folderPathOverride !== undefined ? folderPathOverride : parentFolderForNewFiles;
      const created = await createPlaceFileFromPreview(place, parentFolderPath);
      if (!created) return;
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      if (selectedFolder) {
        setSelectedPlace(created);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        mapRef.current?.fitToPlace(created, getMapPadding(false));
      } else {
        setSelectedPlace(created);
        setPlaceMode("full");
        setFeatureScreenPos(null);
        dispatchNav({
          type: "navigate",
          entry: { kind: "place", place: created },
          newTab: false
        });
        mapRef.current?.fitToPlace(created, getMapPadding(true));
      }
    },
    [
      createPlaceFileFromPreview,
      parentFolderForNewFiles,
      selectedFolder,
      getMapPadding,
      dispatchNav
    ]
  );

  /** Save one or more list features (by overlay-point id) to the vault. Returns the ids
   *  that were successfully written so the list can mark them saved. Sequential so files
   *  landing in the same folder don't race on name collisions. */
  const handleSaveListFeatures = useCallback(
    async (rowIds: string[], folderPath: string | null): Promise<void> => {
      if (!activeListLayer) return;
      for (const id of rowIds) {
        const point = activeListLayer.points.find((p) => p.id === id);
        if (!point) continue;
        await createPlaceFileFromPreview(previewPlaceFromOverlayPoint(point), folderPath);
      }
    },
    [activeListLayer, createPlaceFileFromPreview]
  );

  const handleSaveSearchToVault = useCallback(
    async (folderPath: string | null) => {
      await savePreviewPlaceToVault(selectedPlace, folderPath);
    },
    [selectedPlace, savePreviewPlaceToVault]
  );

  const { handlePathRelocated, handleDeletedPath } = usePathSync({
    nav,
    dispatchNav,
    selectedPlace,
    selectedFolder,
    setSelectedFolder,
    setSelectedPlace,
    setActiveGeoJsonLayers,
    openEntry,
    clearPlace,
    onNavEmpty
  });

  usePlacesWatcher({ handleDeletedPath });

  // Place-card title renames are always single files; route them through the one
  // relocation function so every path-holding store stays in sync. Remember the
  // rename so the card's mount key stays stable — remounting on a title change
  // flashes the whole card.
  const [renameKeyAlias, setRenameKeyAlias] = useState<{ path: string; key: string } | null>(null);
  const handlePlaceRename = useCallback(
    (oldPath: string, newPath: string) => {
      setRenameKeyAlias((prev) => ({
        path: newPath,
        key: prev && prev.path === oldPath ? prev.key : oldPath
      }));
      handlePathRelocated(oldPath, newPath, false);
    },
    [handlePathRelocated]
  );
  // The alias only needs to outlive the rename while that place stays selected.
  // Drop it once selection moves off the path so a different place later
  // occupying it (delete + recreate) can't collide with the old mount key.
  if (renameKeyAlias && selectedPlace?.filePath !== renameKeyAlias.path) {
    setRenameKeyAlias(null);
  }
  const selectedPlaceCardKey =
    selectedPlace && renameKeyAlias?.path === selectedPlace.filePath
      ? renameKeyAlias.key
      : selectedPlace?.filePath;

  const isMini = selectedPlace !== null && placeMode === "mini";
  const isFull = selectedPlace !== null && placeMode === "full";

  /** MapView emits this per frame while the map moves with a selection; bail when the
   * projected position hasn't changed so idle map events don't re-render App. */
  const handleFeatureScreenPos = useCallback((x: number, y: number) => {
    setFeatureScreenPos((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  }, []);

  const handleDeletePlaceFile = useCallback(
    (filePath: string) => handleDeletedPath(filePath, "file"),
    [handleDeletedPath]
  );

  /** Mini card → full panel (vault files only; previews keep no expand affordance). */
  const handleExpandMiniCard = useCallback(() => {
    const place = selectedPlace;
    if (!place) return;
    setPlaceMode("full");
    setSelectedFolder(null);
    dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab: false });
    mapRef.current?.fitToPlace(place, getMapPadding(true));
  }, [selectedPlace, dispatchNav, getMapPadding]);

  const handleClosePeek = useCallback(() => {
    setMapPeekPlace(null);
    setSelectionPulseAnchor(null);
  }, []);

  const handleSavePeekToVault = useCallback(
    async (folderPath: string | null) => {
      await savePreviewPlaceToVault(mapPeekPlace, folderPath);
    },
    [mapPeekPlace, savePreviewPlaceToVault]
  );

  const handleExpandPeek = useCallback(() => {
    if (!mapPeekPlace) return;
    setMapPeekPlace(null);
    handleSelectPlaceFromSidebar(mapPeekPlace, false);
  }, [mapPeekPlace, handleSelectPlaceFromSidebar]);

  const handleSelectGeoJsonFromSidebar = useCallback(
    (filePath: string) => void handleSelectGeoJson(filePath),
    [handleSelectGeoJson]
  );

  const handleMapClickEmpty = useCallback(
    (pos: { lng: number; lat: number }) => {
      // A blank stop is waiting for a map pick — that wins over clearing the selection.
      if (fillArmedStop(waypointAtPoint(pos))) {
        return;
      }
      if (isMini) {
        clearPlace();
        return;
      }
      if (mapPeekPlace) {
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
      }
    },
    [isMini, mapPeekPlace, clearPlace, fillArmedStop]
  );

  /** Sidebar tree highlight: follow the active tab's place, not `selectedPlace` (Photon replaces that in mini mode). */
  const selectedFilePathForSidebar = useMemo(() => {
    const tab = nav.tabs[nav.activeTab];
    const entry = tab?.history[tab.cursor];
    if (entry?.kind !== "place") return undefined;
    const fp = entry.place.filePath;
    // Sidebar matches real vault paths only; preview ids are not files on disk.
    if (fp.startsWith("geocode-search:") || fp.startsWith("map-overlay:")) return undefined;
    return fp;
  }, [nav]);

  return (
    <>
      {/* Map: full viewport, goes under the top bar */}
      <div className="fixed inset-0 z-0">
        <MapView
          ref={mapRef}
          onSelectPlace={handleSelectPlaceFromMap}
          onCreatePlace={handleCreatePlace}
          onMapClickEmpty={isMini || mapPeekPlace || armedStop ? handleMapClickEmpty : undefined}
          selectedPlace={placeForMapHighlight}
          selectedFolder={selectedFolder}
          parentFolderForNewFiles={parentFolderForNewFiles}
          onSelectedFeaturePosition={handleFeatureScreenPos}
          overlayLayers={visibleOverlayLayers}
          focusedFeatureId={focusedFeatureId}
          showOverlay={visibleOverlayLayers.length > 0}
          // @ts-expect-error - activeGeoJsonLayers data shape matches RawFeatureCollection
          geoJsonLayers={activeGeoJsonLayers}
          selectionPulseAnchor={selectionPulseAnchor}
          linkedPlaces={linkedPlacesForMap}
          presentedPlaces={presentedPlaces}
          openPlace={mapPeekPlace ? selectedPlace : null}
          routeStops={routeStopDots}
          userLocation={userLocation}
          directionsHighlight={activeDirectionsEntry ? directionsHighlight : null}
          drawSession={drawSession}
          onDrawFinish={handleDrawFinish}
          onDrawEditChange={(geometry) => setEditedGeometry(JSON.stringify(geometry))}
          onDirectionsFromPoint={handleDirectionsFromPoint}
          onDirectionsToPoint={handleDirectionsToPoint}
          // Only offered when there's a directions tab open to add the stop to.
          onAddStopAtPoint={activeDirectionsEntry ? handleAddStopAtPoint : undefined}
          // Drag-to-reshape belongs to the open directions tab, not to a saved route's line.
          onRouteDrag={activeDirectionsEntry ? handleRouteDrag : undefined}
          onRouteDragEnd={activeDirectionsEntry ? handleRouteDragEnd : undefined}
          routeDragPreview={routeDragPreview}
        />
      </div>

      {/* Draw session banner — below the top bar, centred over the map area so the
          open panes don't cover it. */}
      {drawSession && (
        <div
          className="pointer-events-none fixed z-30 flex justify-center"
          style={{
            top: TOP_BAR_HEIGHT + 8,
            left:
              (projectSidebarOpen ? projectSidebarWidth : 0) + (mainPaneOpen ? mainPaneWidth : 0),
            right: 0
          }}
        >
          <DrawToolbar
            session={drawSession}
            canSave={editedGeometry !== null}
            onSave={saveEditedGeometry}
            onCancel={cancelDrawing}
          />
        </div>
      )}

      {/* Top bar */}
      <motion.div
        layoutRoot
        className="fixed top-0 inset-x-0 z-30 flex items-stretch text-sidebar-foreground"
        style={{ height: TOP_BAR_HEIGHT, WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {/* Left zone — panel toggle + search + back/forward, anchored to the sidebar's
            right edge when open, or immediately right of the traffic lights when collapsed. */}
        <div
          className={cn("flex shrink-0 items-center", isFullscreen ? "pl-2" : "pl-23")}
          style={projectSidebarOpen ? { width: projectSidebarWidth } : undefined}
        >
          {projectSidebarOpen && <div className="flex-1" aria-hidden />}
          <div
            className={cn(
              projectSidebarOpen
                ? "flex items-center gap-0.5 pr-3"
                : // Collapsed: a light floating cluster mirroring the mini place-card actions.
                  surfaceVariants({ variant: "cluster" })
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setProjectSidebarOpen((o) => !o)}
                  >
                    <PanelLeftIcon className="size-4" />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                Toggle sidebar
                <KbdGroup>
                  <Kbd>{modSymbol}</Kbd>
                  <Kbd>{"\\"}</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
            <GeocodeSearchPopover
              onSelectResult={handleGeocodeSearchResult}
              files={indexedFiles}
              onSelectFile={handleSearchSelectFile}
              onOpenResults={handleOpenSearchResults}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon" onClick={handleNavBack} disabled={!canBack}>
                    <ChevronLeftIcon />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                Back
                <KbdGroup>
                  <Kbd>{modSymbol}</Kbd>
                  <Kbd>[</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleNavForward}
                    disabled={!canForward}
                  >
                    <ChevronRightIcon />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                Forward
                <KbdGroup>
                  <Kbd>{modSymbol}</Kbd>
                  <Kbd>]</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* Tabs zone — tab strip, anchored just outside the sidebar's right edge. */}
        <div className="flex-1 min-w-0 flex items-center h-full min-h-0 px-2">
          <NavTabs
            tabs={navTabs}
            activeTabIndex={activeTabIndex}
            onTabActivate={handleNavTabActivate}
            onTabClose={handleCloseTab}
            onTabReorder={handleNavTabReorder}
            onNewNote={handleNewNoteInFolder}
            newNoteDefaultFolder={parentFolderForNewFiles}
          />
        </div>
        <div
          className="flex shrink-0 items-center pr-2"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <MapControls
            userLocation={userLocation}
            onUserLocationChange={handleUserLocationChange}
          />
        </div>
      </motion.div>

      {/* Left sidebar — full viewport height, flush left, sitting under the top-bar
          controls (its content is padded down to clear them). Sits above the content
          wrapper (z-20) so floating mini/peek cards tuck behind it, but below the
          resize rail (z-[25]) and top bar (z-30). */}
      <SidebarProvider
        name="sidebar-left"
        open={projectSidebarOpen}
        onOpenChange={setProjectSidebarOpen}
        keyboardShortcut={SIDEBAR_KB_PROJECT}
        className="fixed inset-0 z-[21] pointer-events-none bg-transparent"
        style={{ "--sidebar-width": `${projectSidebarWidth}px` } as React.CSSProperties}
      >
        <ProjectSidebar
          selectedFilePath={selectedFilePathForSidebar}
          selectedFolderPath={selectedFolder ?? undefined}
          onSelectPlace={handleSelectPlaceFromSidebar}
          onSelectFolder={handleSelectFolder}
          onSelectGeoJson={handleSelectGeoJsonFromSidebar}
          onDeletePath={handleDeletedPath}
          onRenamePath={handlePathRelocated}
          onMoved={handlePathRelocated}
          geometryKinds={geometryKinds}
          fileAppearance={fileAppearance}
        />
      </SidebarProvider>

      {/* Sidebar resize rail — spans the full sidebar height (top bar sits above it,
          so the controls at the sidebar edge stay clickable). */}
      {projectSidebarOpen && (
        <div
          className="fixed z-[25] pointer-events-auto"
          style={{ top: 0, bottom: 0, left: projectSidebarWidth, width: 0 }}
        >
          <ResizeHandle
            side="right"
            ariaLabel="Resize sidebar"
            offset={0}
            onPointerDown={startProjectSidebarResize}
          />
        </div>
      )}

      {/* Content wrapper: top offset + layout containment creates a new containing
          block so all fixed children are relative to this wrapper, not the viewport.
          Must not use a transform here: that promotes the whole chrome onto one
          compositor layer over the WebGL canvas, which makes Chromium drop the
          backdrop-filter surfaces for a frame on hover/scroll (UI flicker). */}
      <div
        className="fixed inset-x-0 bottom-0 z-20 pointer-events-none"
        style={{ top: TOP_BAR_HEIGHT, contain: "layout" }}
      >
        {/* Main pane — full-height place panel. */}
        {isFull && selectedPlace && (
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-auto pb-2 pl-2"
            style={{
              left: projectSidebarOpen ? projectSidebarWidth : 0,
              width: mainPaneWidth
            }}
          >
            <PlaceCard
              key={selectedPlaceCardKey}
              place={selectedPlace}
              mode="full"
              onClose={handlePlaceCardClose}
              onNavigate={handleSelectPlaceFromSidebar}
              onGetDirections={handleGetDirections}
              onOpenWikilink={handleOpenWikilink}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
              onStartDrawing={startDrawing}
              onEditGeometry={startEditingGeometry}
              onPlanRoute={handlePlanRoute}
              savedRoute={placesByPath.get(selectedPlace.filePath)?.route ?? null}
              activeDrawMode={
                drawSession?.filePath === selectedPlace.filePath ? drawSession.mode : null
              }
              onDelete={handleDeletePlaceFile}
              onOpenFolder={handleSelectFolder}
              onAppearanceChange={handleAppearanceChange}
            />
            {/* Rail tracks the card edges: offset = -(right padding), bottom = bottom padding. */}
            <ResizeHandle
              side="right"
              ariaLabel="Resize main pane"
              offset={0}
              className="bottom-2"
              onPointerDown={startMainPaneResize}
            />
          </div>
        )}

        {/* Working-set list — full-height pane sharing the main-pane slot. */}
        {activeListLayer && (
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-auto pb-2 pl-2"
            style={{
              left: projectSidebarOpen ? projectSidebarWidth : 0,
              width: mainPaneWidth
            }}
          >
            <FeaturesListPanel
              key={activeListLayer.id}
              layer={activeListLayer}
              placesByPath={placesByPath}
              defaultParentFolderPath={parentFolderForNewFiles}
              onClose={() => handleNavTabClose(activeTabIndex)}
              onOpenFeature={handleOpenListRow}
              onSaveFeatures={handleSaveListFeatures}
              onDismissFeature={handleDismissListFeature}
            />
            <ResizeHandle
              side="right"
              ariaLabel="Resize list pane"
              offset={0}
              className="bottom-2"
              onPointerDown={startMainPaneResize}
            />
          </div>
        )}

        {/* Directions — full-height pane sharing the main-pane slot. */}
        {activeDirectionsEntry && (
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-auto pb-2 pl-2"
            style={{
              left: projectSidebarOpen ? projectSidebarWidth : 0,
              width: mainPaneWidth
            }}
          >
            <DirectionsPanel
              key={activeDirectionsEntry.id}
              id={activeDirectionsEntry.id}
              stops={activeDirectionsEntry.stops}
              mode={activeDirectionsEntry.mode}
              files={indexedFiles}
              onChange={(next) =>
                dispatchNav({
                  type: "update-directions",
                  id: activeDirectionsEntry.id,
                  stops: next.stops,
                  mode: next.mode
                })
              }
              onRouteChange={handleDirectionsRouteChange}
              onHighlightSegment={handleDirectionsHighlight}
              targetFilePath={activeDirectionsEntry.targetFilePath ?? null}
              targetTitle={
                activeDirectionsEntry.targetFilePath
                  ? (placesByPath.get(activeDirectionsEntry.targetFilePath)?.title ?? null)
                  : null
              }
              indexLoaded={placesIndexLoaded}
              savedRoute={
                activeDirectionsEntry.targetFilePath
                  ? (placesByPath.get(activeDirectionsEntry.targetFilePath)?.route ?? null)
                  : null
              }
              defaultParentFolderPath={parentFolderForNewFiles}
              onSaveRoute={(payload) => handleSaveRoute(activeDirectionsEntry, payload)}
              onArmedStopChange={(index) =>
                setArmedStop(index === null ? null : { id: activeDirectionsEntry.id, index })
              }
              onClose={() => handleNavTabClose(activeTabIndex)}
            />
            <ResizeHandle
              side="right"
              ariaLabel="Resize directions pane"
              offset={0}
              className="bottom-2"
              onPointerDown={startMainPaneResize}
            />
          </div>
        )}

        {/* Mini place card — floats above the selected map feature */}
        {isMini && featureScreenPos && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: featureScreenPos.x,
              top: featureScreenPos.y - TOP_BAR_HEIGHT,
              transform: "translate(-50%, calc(-100% - 16px))"
            }}
          >
            <PlaceCard
              key={selectedPlaceCardKey}
              place={selectedPlace}
              mode="mini"
              onClose={handlePlaceCardClose}
              onNavigate={handleSelectPlaceFromSidebar}
              onGetDirections={handleGetDirections}
              onOpenWikilink={handleOpenWikilink}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
              onStartDrawing={startDrawing}
              onEditGeometry={startEditingGeometry}
              onPlanRoute={handlePlanRoute}
              savedRoute={placesByPath.get(selectedPlace.filePath)?.route ?? null}
              activeDrawMode={
                drawSession?.filePath === selectedPlace.filePath ? drawSession.mode : null
              }
              onSaveSearchToVault={
                selectedPlace.previewMarkdown !== undefined ? handleSaveSearchToVault : undefined
              }
              defaultParentFolderPath={parentFolderForNewFiles}
              onOpenFolder={handleSelectFolder}
              onAppearanceChange={handleAppearanceChange}
              onExpand={
                selectedPlace.previewMarkdown !== undefined ? undefined : handleExpandMiniCard
              }
            />
          </div>
        )}

        {/* Peek mini card — map selection while full PlaceCard is open. Sits below the
            full main pane (z-20) so the committed card stays on top when they overlap. */}
        {isFull && mapPeekPlace && featureScreenPos && (
          <div
            className="absolute pointer-events-none z-10"
            style={{
              left: featureScreenPos.x,
              top: featureScreenPos.y - TOP_BAR_HEIGHT,
              transform: "translate(-50%, calc(-100% - 16px))"
            }}
          >
            <PlaceCard
              key={mapPeekPlace.filePath}
              place={mapPeekPlace}
              mode="mini"
              onClose={handleClosePeek}
              onNavigate={handleSelectPlaceFromSidebar}
              onGetDirections={handleGetDirections}
              onOpenWikilink={handleOpenWikilink}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
              onStartDrawing={startDrawing}
              onEditGeometry={startEditingGeometry}
              onPlanRoute={handlePlanRoute}
              savedRoute={placesByPath.get(mapPeekPlace.filePath)?.route ?? null}
              activeDrawMode={
                drawSession?.filePath === mapPeekPlace.filePath ? drawSession.mode : null
              }
              onSaveSearchToVault={
                mapPeekPlace.previewMarkdown !== undefined ? handleSavePeekToVault : undefined
              }
              defaultParentFolderPath={parentFolderForNewFiles}
              onOpenFolder={handleSelectFolder}
              onAppearanceChange={handleAppearanceChange}
              onExpand={mapPeekPlace.previewMarkdown !== undefined ? undefined : handleExpandPeek}
            />
          </div>
        )}
      </div>
    </>
  );
}

export default App;
