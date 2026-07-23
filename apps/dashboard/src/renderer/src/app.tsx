import { Button } from "@mapos/ui/components/button";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { type SidebarKeyboardShortcutConfig, SidebarProvider } from "@mapos/ui/components/sidebar";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import { detailPropertiesFromGeocodeResult } from "@shared/geocode-detail";
import type { MapOverlayLayer, OverlayPoint } from "@shared/types";
import { orderDetailProperties } from "@shared/types";
import { bbox } from "@turf/bbox";
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
import type { GeocodeSearchResult } from "./lib/geocode-search";
import { geometryJsonToCreateArgs } from "./lib/geometry-wkt";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "./lib/place-utils";
import { waypointFromPlace } from "./lib/place-waypoint";
import { extractWikilinkTitles, flattenMdFiles, resolveWikilinkTarget } from "./lib/wikilinks";

const BASE_UNITS = 16;

const PROJECT_SIDEBAR_DEFAULT_WIDTH = 16 * BASE_UNITS;
// Wide enough that the sidebar-anchored controls (toggle + search + back/forward,
// plus the traffic-light inset) never overflow into the tab strip.
const PROJECT_SIDEBAR_MIN_WIDTH = 14 * BASE_UNITS;
const PROJECT_SIDEBAR_MAX_WIDTH = 30 * BASE_UNITS;
const MAIN_PANE_DEFAULT_WIDTH = 22 * BASE_UNITS;
const MAIN_PANE_MIN_WIDTH = 17 * BASE_UNITS;
const MAIN_PANE_MAX_WIDTH = 40 * BASE_UNITS;
const TOP_BAR_HEIGHT = 2.5 * BASE_UNITS;
const FIT_BUFFER = 2.5 * BASE_UNITS;

/** Above this many points, an overlay is treated as a bulk map layer, not a browsable list. */
const LIST_MAX_FEATURES = 200;

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

/** Directory containing a vault file path (browser-safe; avoids Node `path` in the renderer bundle). */
function parentFolderOfVaultFile(filePath: string): string {
  const n = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (n === -1) return ".";
  if (n === 0) return filePath.slice(0, 1);
  return filePath.slice(0, n);
}

/** Path looks like a real vault file (rules out preview/overlay/synthetic identifiers). */
function isVaultFilePath(fp: string | undefined | null): fp is string {
  if (!fp) return false;
  if (fp.startsWith("geocode-search:")) return false;
  if (fp.startsWith("map-overlay:")) return false;
  if (fp.startsWith("map-poi:")) return false;
  if (fp.startsWith("geojson-feature:")) return false;
  return true;
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
  /** Accumulated overlay layers currently rendered on the map (driven over map:overlay-add). */
  const [overlayLayers, setOverlayLayers] = useState<MapOverlayLayer[]>([]);
  // Route overlay for the active directions tab, lifted from DirectionsPanel so it draws
  // on the map (mirrors how a list tab's layer rides in visibleOverlayLayers).
  const [directionsRouteLayer, setDirectionsRouteLayer] = useState<MapOverlayLayer | null>(null);
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

  const addLayer = useCallback((layer: MapOverlayLayer) => {
    setOverlayLayers((prev) => [...prev.filter((l) => l.id !== layer.id), layer]);
  }, []);
  const clearLayers = useCallback(() => {
    setOverlayLayers([]);
    setFocusedFeatureId(null);
  }, []);

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
        // Frame the known endpoints; the panel refits to the full route once it computes.
        const ends = [entry.origin, entry.destination].filter(
          (w): w is DirectionsWaypoint => w !== null
        );
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

  const placesByPath = usePlacesIndex();

  /** A new overlay layer arrived (agent present/render, or user search). Pickable,
   *  human-scale result sets become a list ("working set") tab whose layer rides in the
   *  nav entry — drawn only while that tab is active, so closing the tab clears its markers.
   *  Everything else (routes, isochrones, bulk point dumps) is an ambient map layer that
   *  accumulates until explicitly cleared. */
  const handleOverlayLayer = useCallback(
    (layer: MapOverlayLayer) => {
      const pickable =
        (layer.points.length > 0 && layer.points.length <= LIST_MAX_FEATURES) ||
        (layer.vaultPaths?.length ?? 0) > 0;
      if (!pickable) {
        addLayer(layer);
        return;
      }
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
      if (layer.points.length > 0) {
        mapRef.current?.fitToGeoJson(pointsFeatureCollection(layer.points), getMapPadding(true));
      }
    },
    [addLayer, dispatchNav, getMapPadding]
  );

  useMapOverlaySync({ selectedPlaceRef, clearPlace, addLayer: handleOverlayLayer, clearLayers });

  /** Current active tab entry — drives which pane (place / list / folder) is shown. */
  const activeNavEntry = useMemo(() => {
    const tab = nav.tabs[nav.activeTab];
    return tab ? tab.history[tab.cursor] : undefined;
  }, [nav]);

  /** The overlay layer backing the active list tab (null unless a list tab is active). */
  const activeListLayer = activeNavEntry?.kind === "list" ? activeNavEntry.layer : null;

  /** The active directions tab entry (null unless one is active) — drives the panel. */
  const activeDirectionsEntry = activeNavEntry?.kind === "directions" ? activeNavEntry : null;

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

  /** Overlay layers drawn now: ambient layers (routes/isochrones/bulk) plus the active
   *  list tab's layer or the active directions tab's route. Both live in per-tab state, not
   *  in `overlayLayers`, so a closed or backgrounded tab draws nothing. */
  const visibleOverlayLayers = useMemo(() => {
    const extra = activeListLayer ?? activeDirectionsRoute;
    return extra ? [...overlayLayers, extra] : overlayLayers;
  }, [overlayLayers, activeListLayer, activeDirectionsRoute]);

  /** Directions panel reports its computed route (or null); frame it on the map. */
  const handleDirectionsRouteChange = useCallback(
    (layer: MapOverlayLayer | null) => {
      setDirectionsRouteLayer(layer);
      const line = layer?.lines[0];
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

  /** Open a Directions tab for the given destination. When `origin` is null, default it to
   *  the user's current location (blank if unavailable) — the app's Get-directions behavior. */
  const openDirectionsTab = useCallback(
    (destination: DirectionsWaypoint, origin: DirectionsWaypoint | null, mode: TravelMode) => {
      const open = (resolvedOrigin: DirectionsWaypoint | null): void => {
        dispatchNav({
          type: "navigate",
          entry: {
            kind: "directions",
            id: crypto.randomUUID(),
            label: "Directions",
            origin: resolvedOrigin,
            destination,
            mode
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
      };
      if (origin) {
        open(origin);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          open({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: "Your location" }),
        () => open(null),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    },
    [dispatchNav]
  );

  /** Get-directions button on a place card: destination = the place, origin = current location. */
  const handleGetDirections = useCallback(
    (place: PlaceRecord) => {
      const destination = waypointFromPlace(place);
      if (destination) openDirectionsTab(destination, null, "auto");
    },
    [openDirectionsTab]
  );

  /** Click a list row: open the mini place card over its marker (same as clicking the
   *  marker on the map). Overlay points become a preview card; vault rows open their place. */
  const handleOpenListRow = useCallback(
    (row: FeatureListRow) => {
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

  /** Vault places referenced by overlay layers (`vaultPaths`), resolved against the
   * live index. They may lie outside the selected folder, so the map draws them
   * alongside the overlay layers they arrived with. */
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
      const useClickPulse =
        Boolean(meta?.mapClickLngLat) && geometryUsesMapClickPulseAnchor(place.geometry);
      if (useClickPulse && meta?.mapClickLngLat) {
        setSelectionPulseAnchor({
          filePath: place.filePath,
          lng: meta.mapClickLngLat.lng,
          lat: meta.mapClickLngLat.lat
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
    [placeMode]
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
    // `present_directions`: open a Directions tab for the endpoints the agent resolved.
    window.api.nav.onOpenDirections(({ origin, destination, mode }) => {
      openDirectionsTab(destination, origin, mode);
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
      const points = results.slice(0, LIST_MAX_FEATURES).map((r) => {
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

  const commitVaultPointLocation = useCallback(
    async (filePath: string, lat: number, lng: number): Promise<boolean> => {
      const wkt = `POINT(${lng} ${lat})`;
      const write = await window.api.fs.writeFrontmatterProperty(filePath, "geometry", wkt);
      if (!write.success) {
        console.error("[commit location]", write.error);
        return false;
      }
      // `places.getByPath` reads the in-memory index updated by the file watcher, which uses
      // awaitWriteFinish — so it is often still stale immediately after a write. Merge the
      // geometry we know we just persisted instead of trusting getByPath alone.
      const geometryJson = JSON.stringify({ type: "Point", coordinates: [lng, lat] });
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
      mapRef.current?.fitToPlace(updated, getMapPadding(placeMode === "full"));
      return true;
    },
    [getMapPadding, placeMode, dispatchNav]
  );

  const clearVaultPointLocation = useCallback(
    async (filePath: string): Promise<boolean> => {
      const write = await window.api.fs.writeFrontmatterProperty(filePath, "geometry", null);
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
      const cleared = { ...base, geometry: undefined };
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      setSelectedPlace(cleared);
      dispatchNav({ type: "update-entry", filePath, place: cleared });
      mapRef.current?.invalidateFolderPlace(filePath);
      return true;
    },
    [dispatchNav]
  );

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

  const handleMapClickEmpty = useCallback(() => {
    if (isMini) {
      clearPlace();
      return;
    }
    if (mapPeekPlace) {
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
    }
  }, [isMini, mapPeekPlace, clearPlace]);

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
          onMapClickEmpty={isMini || mapPeekPlace ? handleMapClickEmpty : undefined}
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
          linkedPlaces={linkedPlaces}
          presentedPlaces={presentedPlaces}
          openPlace={mapPeekPlace ? selectedPlace : null}
          userLocation={userLocation}
        />
      </div>

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
            tabs={navTabsData}
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
              onDelete={handleDeletePlaceFile}
              onOpenFolder={handleSelectFolder}
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
              origin={activeDirectionsEntry.origin}
              destination={activeDirectionsEntry.destination}
              mode={activeDirectionsEntry.mode}
              files={indexedFiles}
              onChange={(next) =>
                dispatchNav({
                  type: "update-directions",
                  id: activeDirectionsEntry.id,
                  origin: next.origin,
                  destination: next.destination,
                  mode: next.mode
                })
              }
              onRouteChange={handleDirectionsRouteChange}
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
              onSaveSearchToVault={
                selectedPlace.previewMarkdown !== undefined ? handleSaveSearchToVault : undefined
              }
              defaultParentFolderPath={parentFolderForNewFiles}
              onOpenFolder={handleSelectFolder}
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
              onSaveSearchToVault={
                mapPeekPlace.previewMarkdown !== undefined ? handleSavePeekToVault : undefined
              }
              defaultParentFolderPath={parentFolderForNewFiles}
              onOpenFolder={handleSelectFolder}
              onExpand={mapPeekPlace.previewMarkdown !== undefined ? undefined : handleExpandPeek}
            />
          </div>
        )}
      </div>
    </>
  );
}

export default App;
