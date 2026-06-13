import { Button } from "@mapos/ui/components/button";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { type SidebarKeyboardShortcutConfig, SidebarProvider } from "@mapos/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";
import { cn } from "@mapos/ui/lib/utils";
import type { ConversationMeta, MapOverlayLayer } from "@shared/types";
import { orderDetailProperties } from "@shared/types";
import { detailPropertiesFromGeocodeResult } from "@shared/geocode-detail";
import { bbox } from "@turf/bbox";
import { PanelLeftIcon } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPane } from "./components/chat-pane";
import MapView, {
  type MapSelectPlaceMeta,
  type MapViewHandle,
  type PlaceRecord,
  type SelectionPulseAnchor
} from "./components/map-view";
import { NavTabs } from "./components/nav-tabs";
import { GeocodeSearchPopover } from "./components/geocode-search-popover";
import { PlaceCard } from "./components/place-card";
import { ProjectSidebar } from "./components/project-sidebar";
import { ResizeHandle } from "./components/resize-handle";
import { useChatStore } from "./hooks/use-chat-store";
import { useConversations } from "./hooks/use-conversations";
import { useFullscreen } from "./hooks/use-fullscreen";
import { useMapOverlaySync } from "./hooks/use-map-overlay-sync";
import { type NavEntry, folderLabel, useNavTabs } from "./hooks/use-nav-tabs";
import { useOverlayVaultSync } from "./hooks/use-overlay-vault-sync";
import { usePathSync } from "./hooks/use-path-sync";
import { usePlacesIndex } from "./hooks/use-places-index";
import { usePlacesWatcher } from "./hooks/use-places-watcher";
import { useResizableWidth } from "./hooks/use-resizable-width";
import { modSymbol, useShortcuts } from "./hooks/use-shortcuts";
import type { GeocodeSearchResult } from "./lib/geocode-search";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "./lib/place-utils";
import { extractWikilinkTitles, flattenMdFiles } from "./lib/wikilinks";

const BASE_UNITS = 16;

const PROJECT_SIDEBAR_DEFAULT_WIDTH = 14 * BASE_UNITS;
const PROJECT_SIDEBAR_MIN_WIDTH = 12 * BASE_UNITS;
const PROJECT_SIDEBAR_MAX_WIDTH = 30 * BASE_UNITS;
const MAIN_PANE_DEFAULT_WIDTH = 22 * BASE_UNITS;
const MAIN_PANE_MIN_WIDTH = 17 * BASE_UNITS;
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

function representativeLngLatFromGeometryJson(geometryJson: string): [number, number] | null {
  try {
    const geo = JSON.parse(geometryJson) as {
      type: string;
      coordinates: unknown;
    };
    if (geo.type === "Point" && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      const c = geo.coordinates as number[];
      const lng = c[0];
      const lat = c[1];
      if (typeof lng !== "number" || typeof lat !== "number") return null;
      return [lng, lat];
    }
    if (geo.type === "LineString" && Array.isArray(geo.coordinates)) {
      const [minLng, minLat, maxLng, maxLat] = bbox({
        type: "Feature",
        geometry: { type: "LineString", coordinates: geo.coordinates as [number, number][] },
        properties: {}
      });
      return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    }
    if (geo.type === "Polygon" && Array.isArray(geo.coordinates)) {
      const [minLng, minLat, maxLng, maxLat] = bbox({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: geo.coordinates as [number, number][][] },
        properties: {}
      });
      return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    }
  } catch {
    return null;
  }
  return null;
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
    .map((t) => cache.find((f) => f.title === t)?.filePath)
    .filter((p): p is string => Boolean(p) && p !== filePath);
  const records = await Promise.all(paths.map((p) => window.api.places.getByPath(p)));
  return records.filter((r): r is PlaceRecord => r !== null && Boolean(r.geometry));
}

function App(): React.JSX.Element {
  const [selectedPlace, setSelectedPlace] = useState<PlaceRecord | null>(null);
  const [placeMode, setPlaceMode] = useState<"mini" | "full">("mini");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(true);
  const [activeChatConvId, setActiveChatConvId] = useState<string | null>(null);
  const [featureScreenPos, setFeatureScreenPos] = useState<{ x: number; y: number } | null>(null);
  /** Map selection while full PlaceCard is open (floating mini card + highlight). */
  const [mapPeekPlace, setMapPeekPlace] = useState<PlaceRecord | null>(null);
  /** Last real vault file path (kept when switching to a Photon search preview). */
  const [lastVaultFilePath, setLastVaultFilePath] = useState<string | null>(null);
  /** Accumulated overlay layers across this conversation's result sets. */
  const [overlayLayers, setOverlayLayers] = useState<MapOverlayLayer[]>([]);
  /** Layer to emphasize on the map (the hovered chat card); null = all full opacity. */
  const [focusedLayerId, setFocusedLayerId] = useState<string | null>(null);
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
  const selectedPlaceRef = useRef(selectedPlace);
  selectedPlaceRef.current = selectedPlace;

  const { width: projectSidebarWidth, startDrag: startProjectSidebarResize } = useResizableWidth({
    storageKey: "mapos.projectSidebarWidth",
    defaultWidth: PROJECT_SIDEBAR_DEFAULT_WIDTH,
    minWidth: PROJECT_SIDEBAR_MIN_WIDTH,
    maxWidth: PROJECT_SIDEBAR_MAX_WIDTH
  });
  const { width: mainPaneWidth, startDrag: startMainPaneResize } = useResizableWidth({
    storageKey: "mapos.mainPaneWidth",
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

  const chatStore = useChatStore();
  const { conversations, refresh: refreshConversations } = useConversations(chatStore);

  /** convIds whose stream is currently in flight (renderer view); drives spinners on tabs and the sidebar list. */
  const streamingConvIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, c] of Object.entries(chatStore.state.byId)) {
      if (
        c.assistantPending ||
        c.streamingContent !== "" ||
        c.streamingThinking !== "" ||
        c.activeToolCalls.length > 0
      ) {
        ids.add(id);
      }
    }
    return ids;
  }, [chatStore.state]);

  const addLayer = useCallback((layer: MapOverlayLayer) => {
    setOverlayLayers((prev) => [...prev.filter((l) => l.id !== layer.id), layer]);
  }, []);
  const clearLayers = useCallback(() => {
    setOverlayLayers([]);
    setFocusedLayerId(null);
  }, []);
  /** Replace the on-screen layer set when switching/reopening a conversation. */
  const handleLayersRestore = useCallback((layers: MapOverlayLayer[]) => {
    setOverlayLayers(layers);
    setFocusedLayerId(null);
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
        setActiveChatConvId(null);
        setSelectedPlace(entry.place);
        setPlaceMode("full");
        setSelectedFolder(null);
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        mapRef.current?.fitToPlace(entry.place, getMapPadding(true));
      } else if (entry.kind === "folder") {
        setActiveChatConvId(null);
        setSelectedFolder(entry.folderPath);
        setSelectedPlace(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        mapRef.current?.fitToFolder(entry.folderPath, getMapPadding(false));
      } else {
        // chat: render chat pane in main-pane slot; clear place/folder selection.
        setActiveChatConvId(entry.convId);
        setSelectedPlace(null);
        setPlaceMode("mini");
        setSelectedFolder(null);
        setFeatureScreenPos(null);
        setMapPeekPlace(null);
        setSelectionPulseAnchor(null);
        // Lazy-load conversation; restore its saved overlay layers once loaded.
        void chatStore.loadConversation(entry.convId).then(handleLayersRestore);
      }
    },
    [getMapPadding, chatStore, handleLayersRestore]
  );

  const onNavEmpty = useCallback(() => {
    clearPlace();
    setSelectedFolder(null);
    setActiveChatConvId(null);
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

  usePlacesWatcher({ selectedPlaceRef, clearPlace });
  const placesByPath = usePlacesIndex();
  useMapOverlaySync({ selectedPlaceRef, clearPlace, addLayer, clearLayers });

  /** AI `pan_to` from chat: route through the map handle so the camera respects
   * sidebar/main-pane padding instead of centering behind them. */
  useEffect(() => {
    window.api.map.onPanTo(({ lat, lng, zoom }) => {
      const padding = getMapPadding(activeChatConvId !== null);
      mapRef.current?.flyTo(lat, lng, { zoom, padding });
    });
    return () => window.api.map.removeListeners();
  }, [getMapPadding, activeChatConvId]);

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

  const handlePlaceRename = useCallback(
    (oldPath: string, newPath: string) => {
      dispatchNav({ type: "relocate_path", oldPath, newPath, isDirectory: false });
      setActiveGeoJsonLayers((prev) =>
        prev.map((layer) => (layer.filePath === oldPath ? { ...layer, filePath: newPath } : layer))
      );
    },
    [dispatchNav]
  );

  const handleNewChat = useCallback(() => {
    const convId = crypto.randomUUID();
    const entry: NavEntry = { kind: "chat", convId, title: "New Chat" };
    dispatchNav({ type: "navigate", entry, newTab: true, activate: true });
    openEntry(entry);
  }, [dispatchNav, openEntry]);

  const handleSwitchChatConv = useCallback(
    (convId: string, title: string, newTab = false) => {
      const entry: NavEntry = { kind: "chat", convId, title };
      if (newTab) {
        dispatchNav({ type: "navigate", entry, newTab: true });
        return;
      }
      dispatchNav({ type: "navigate", entry, newTab: false });
      openEntry(entry);
    },
    [dispatchNav, openEntry]
  );

  const handleChatDeleted = useCallback(
    (convId: string) => {
      // The conversation file is gone; close any tabs showing it.
      let i = nav.tabs.length;
      while (i--) {
        const e = nav.tabs[i].history[nav.tabs[i].cursor];
        if (e.kind === "chat" && e.convId === convId) {
          handleNavTabClose(i);
        }
      }
      void refreshConversations();
    },
    [nav.tabs, handleNavTabClose, refreshConversations]
  );

  const handleSidebarDeleteChat = useCallback(
    async (convId: string) => {
      await chatStore.deleteConversation(convId);
      handleChatDeleted(convId);
    },
    [chatStore, handleChatDeleted]
  );

  const handleSidebarRenameChat = useCallback(
    async (convId: string, title: string) => {
      const result = await chatStore.renameConversation(convId, title);
      if (result.success) await refreshConversations();
      return result;
    },
    [chatStore, refreshConversations]
  );

  /** Topbar chat tabs cache their title in the nav entry (defaulted to "New Chat"
   * at creation). Sync it from the conversations index so the tab follows the
   * same `title || preview || "Chat"` rule the sidebar uses — without this the
   * topbar stays on "New Chat" until the tab is closed and reopened. */
  useEffect(() => {
    const convsById = new Map(conversations.map((c) => [c.id, c]));
    for (const tab of nav.tabs) {
      const current = tab.history[tab.cursor];
      if (current?.kind !== "chat") continue;
      const conv = convsById.get(current.convId);
      if (!conv) continue;
      const expected = conv.title || conv.preview || "Chat";
      if (expected !== current.title) {
        dispatchNav({ type: "update-chat-title", convId: current.convId, title: expected });
      }
    }
  }, [conversations, nav.tabs, dispatchNav]);

  useShortcuts([
    {
      def: { key: "w", meta: true, enabled: activeTabIndex >= 0 },
      handler: () => handleCloseTab(activeTabIndex)
    },
    {
      def: { code: "BracketLeft", meta: true, shift: true, enabled: navTabsData.length > 1 },
      handler: () =>
        handleNavTabActivate((activeTabIndex - 1 + navTabsData.length) % navTabsData.length)
    },
    {
      def: { code: "BracketRight", meta: true, shift: true, enabled: navTabsData.length > 1 },
      handler: () => handleNavTabActivate((activeTabIndex + 1) % navTabsData.length)
    },
    {
      def: { key: "o", meta: true },
      handler: handleNewChat
    }
  ]);

  /** Closing a chat tab keeps the stream running so the assistant message still completes
   * and persists to disk. The chat remains accessible via the sidebar conversation list,
   * with a streaming indicator while in flight. */
  const handleCloseTab = useCallback(
    (index: number) => {
      handleNavTabClose(index);
    },
    [handleNavTabClose]
  );

  function handlePlaceCardClose() {
    setMapPeekPlace(null);
    // Full place cards should close exactly like the active top-bar tab.
    if (placeMode !== "full" || activeTabIndex < 0) {
      clearPlace();
      return;
    }
    handleCloseTab(activeTabIndex);
  }

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
      setActiveChatConvId(null);
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

  /** Chat feature-list row click: pan to the feature and open it in mini mode. */
  const handleOpenFeatureFromChat = useCallback(
    (place: PlaceRecord) => {
      setSelectionPulseAnchor(null);
      setMapPeekPlace(null);
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      // Chat pane is open when this fires (the click came from it), so the main pane occupies left padding.
      mapRef.current?.fitToPlace(place, getMapPadding(true));
    },
    [getMapPadding]
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
      setActiveChatConvId(null);
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
      setActiveChatConvId(null);
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
    (place: PlaceRecord) => {
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
        mapRef.current?.fitToPlace(place, getMapPadding(true));
      }
    },
    [selectedFolder, getMapPadding]
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

  const handleSearchSelectConversation = useCallback(
    (conversation: ConversationMeta) => {
      handleSwitchChatConv(conversation.id, conversation.title || conversation.preview || "Chat");
    },
    [handleSwitchChatConv]
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

  const savePreviewPlaceToVault = useCallback(
    async (place: PlaceRecord | null) => {
      if (place?.previewMarkdown === undefined || !place.geometry) return;
      const lngLat = representativeLngLatFromGeometryJson(place.geometry);
      if (!lngLat) return;
      const [lng, lat] = lngLat;
      const create = await window.api.fs.createNoteFile({
        parentFolderPath: parentFolderForNewFiles,
        lat,
        lng,
        includePlaceFrontmatterDefaults: false
      });
      if (!create.success) {
        console.error("[save search]", create.error);
        return;
      }
      const baseName = filenameBaseFromPlaceTitle(place.title);
      const renamed = await renameCreatedPlaceToSlug(create.filePath, baseName);
      if (!renamed.ok) {
        console.error("[save search]", renamed.error);
        return;
      }
      // Persist the previewed details as frontmatter (canonical order, empties dropped)
      // so the saved file matches the preview card exactly.
      const properties = orderDetailProperties(place.properties);
      if (Object.keys(properties).length > 0) {
        const wp = await window.api.fs.writeFrontmatterProperties(renamed.filePath, properties);
        if (!wp.success) console.error("[save search] write properties", wp.error);
      }
      if (place.previewMarkdown.trim()) {
        const w = await window.api.fs.writePlaceBody(renamed.filePath, place.previewMarkdown);
        if (!w.success) console.error("[save search] write body", w.error);
      }
      const created =
        (await window.api.places.getByPath(renamed.filePath)) ??
        ({
          filePath: renamed.filePath,
          title: place.title,
          type: "place",
          geometry: place.geometry
        } satisfies PlaceRecord);
      setMapPeekPlace(null);
      setSelectionPulseAnchor(null);
      if (selectedFolder) {
        setSelectedPlace(created);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        mapRef.current?.fitToPlace(created, getMapPadding(false));
      } else {
        setActiveChatConvId(null);
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
    [parentFolderForNewFiles, selectedFolder, getMapPadding, dispatchNav]
  );

  const handleSaveSearchToVault = useCallback(async () => {
    await savePreviewPlaceToVault(selectedPlace);
  }, [selectedPlace, savePreviewPlaceToVault]);

  const { addLayerToVault } = useOverlayVaultSync();
  /** Add a result layer's features to the vault. The overlay stays on the map so the
   *  card's rows remain resolvable and visible afterward. */
  const handleAddLayerToVault = useCallback(
    async (layer: MapOverlayLayer, parentFolderPath: string | null) => {
      await addLayerToVault(layer, parentFolderPath);
    },
    [addLayerToVault]
  );

  const { handlePathRelocated, handleDeletedPath } = usePathSync({
    nav,
    dispatchNav,
    selectedPlace,
    selectedFolder,
    setSelectedFolder,
    setSelectedPlace,
    openEntry,
    clearPlace,
    onNavEmpty
  });

  const isMini = selectedPlace !== null && placeMode === "mini";
  const isFull = selectedPlace !== null && placeMode === "full";

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
          onSelectedFeaturePosition={(x, y) => setFeatureScreenPos({ x, y })}
          overlayLayers={overlayLayers}
          focusedLayerId={focusedLayerId}
          showOverlay={activeChatConvId !== null}
          // @ts-expect-error - activeGeoJsonLayers data shape matches RawFeatureCollection
          geoJsonLayers={activeGeoJsonLayers}
          selectionPulseAnchor={selectionPulseAnchor}
          linkedPlaces={linkedPlaces}
        />
      </div>

      {/* Top bar */}
      <motion.div
        layoutRoot
        className={cn(
          "fixed top-0 inset-x-0 z-30 flex items-center gap-1 pr-2 text-sidebar-foreground bg-sidebar/75 backdrop-blur-md border-b border-sidebar-border",
          isFullscreen ? "pl-2" : "pl-21"
        )}
        style={{ height: TOP_BAR_HEIGHT, WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setProjectSidebarOpen((o) => !o)}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="bottom">
            Project
            <KbdGroup>
              <Kbd>{modSymbol}</Kbd>
              <Kbd>{"\\"}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <GeocodeSearchPopover
            onSelectResult={handleGeocodeSearchResult}
            files={indexedFiles}
            onSelectFile={handleSearchSelectFile}
            conversations={conversations}
            onSelectConversation={handleSearchSelectConversation}
          />
        </div>
        <div className="flex-1 min-w-0 flex items-center h-full min-h-0">
          <NavTabs
            tabs={navTabsData}
            activeTabIndex={activeTabIndex}
            canBack={canBack}
            canForward={canForward}
            streamingConvIds={streamingConvIds}
            onTabActivate={handleNavTabActivate}
            onTabClose={handleCloseTab}
            onTabReorder={handleNavTabReorder}
            onBack={handleNavBack}
            onForward={handleNavForward}
          />
        </div>
      </motion.div>

      {/* Content wrapper: top offset + transform creates a new containing block
          so all fixed children are relative to this wrapper, not the viewport */}
      <div
        className="fixed inset-x-0 bottom-0 pointer-events-none"
        style={{ top: TOP_BAR_HEIGHT, transform: "translateZ(0)" }}
      >
        {/* Main pane — full-height place panel and chat tab share this column. */}
        {((isFull && selectedPlace) || activeChatConvId) && (
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-auto p-2"
            style={{
              left: projectSidebarOpen ? projectSidebarWidth : 0,
              width: mainPaneWidth
            }}
          >
            {isFull && selectedPlace && (
              <PlaceCard
                key={selectedPlace.filePath}
                place={selectedPlace}
                mode="full"
                onClose={handlePlaceCardClose}
                onNavigate={handleSelectPlaceFromSidebar}
                onRename={handlePlaceRename}
                onCommitPointLocation={commitVaultPointLocation}
                onClearPointLocation={clearVaultPointLocation}
                onDelete={(filePath) => handleDeletedPath(filePath, "file")}
              />
            )}
            {activeChatConvId && (
              <ChatPane
                key={activeChatConvId}
                convId={activeChatConvId}
                convTitle={(() => {
                  const c = conversations.find((c) => c.id === activeChatConvId);
                  return c?.title || c?.preview || "New Chat";
                })()}
                convState={chatStore.getConv(activeChatConvId)}
                overlayLayers={overlayLayers}
                focusLayer={setFocusedLayerId}
                defaultParentFolderPath={parentFolderForNewFiles}
                isSavedConversation={conversations.some((c) => c.id === activeChatConvId)}
                onAddLayerToVault={handleAddLayerToVault}
                onSubmit={(text) => chatStore.sendMessage(activeChatConvId, text)}
                onAbort={() => chatStore.abort(activeChatConvId)}
                onUndo={() => void chatStore.undo(activeChatConvId)}
                onClose={() => {
                  if (activeTabIndex >= 0) handleCloseTab(activeTabIndex);
                  else setActiveChatConvId(null);
                }}
                onDeleted={handleChatDeleted}
                onOpenFile={async (filePath) => {
                  const place = await window.api.places.getByPath(filePath);
                  if (place) handleSelectPlaceFromSidebar(place);
                }}
                placesByPath={placesByPath}
                selectedFilePath={selectedPlace?.filePath ?? null}
                onOpenFeature={handleOpenFeatureFromChat}
              />
            )}
            <ResizeHandle
              side="right"
              ariaLabel="Resize main pane"
              offset={-4}
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
              key={selectedPlace.filePath}
              place={selectedPlace}
              mode="mini"
              onClose={handlePlaceCardClose}
              onNavigate={handleSelectPlaceFromSidebar}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
              onSaveSearchToVault={
                selectedPlace.previewMarkdown !== undefined ? handleSaveSearchToVault : undefined
              }
              onExpand={
                selectedPlace.previewMarkdown !== undefined
                  ? undefined
                  : () => {
                      setPlaceMode("full");
                      setSelectedFolder(null);
                      dispatchNav({
                        type: "navigate",
                        entry: { kind: "place", place: selectedPlace },
                        newTab: false
                      });
                      mapRef.current?.fitToPlace(selectedPlace, getMapPadding(true));
                    }
              }
            />
          </div>
        )}

        {/* Peek mini card — map selection while full PlaceCard is open */}
        {isFull && mapPeekPlace && featureScreenPos && (
          <div
            className="absolute pointer-events-none z-30"
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
              onClose={() => {
                setMapPeekPlace(null);
                setSelectionPulseAnchor(null);
              }}
              onNavigate={handleSelectPlaceFromSidebar}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
              onSaveSearchToVault={
                mapPeekPlace.previewMarkdown !== undefined
                  ? async () => {
                      await savePreviewPlaceToVault(mapPeekPlace);
                    }
                  : undefined
              }
              onExpand={
                mapPeekPlace.previewMarkdown !== undefined
                  ? undefined
                  : () => {
                      setMapPeekPlace(null);
                      handleSelectPlaceFromSidebar(mapPeekPlace, false);
                    }
              }
            />
          </div>
        )}

        {/* Left sidebar overlay */}
        <SidebarProvider
          name="sidebar-left"
          open={projectSidebarOpen}
          onOpenChange={setProjectSidebarOpen}
          keyboardShortcut={SIDEBAR_KB_PROJECT}
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
          style={{ "--sidebar-width": `${projectSidebarWidth}px` } as React.CSSProperties}
        >
          <ProjectSidebar
            selectedFilePath={selectedFilePathForSidebar}
            selectedFolderPath={selectedFolder ?? undefined}
            activeChatConvId={activeChatConvId}
            conversations={conversations}
            streamingConvIds={streamingConvIds}
            onSelectPlace={handleSelectPlaceFromSidebar}
            onSelectFolder={handleSelectFolder}
            onSelectGeoJson={(p) => void handleSelectGeoJson(p)}
            onDeletePath={handleDeletedPath}
            onRenamePath={handlePathRelocated}
            onMoved={handlePathRelocated}
            onNewChat={handleNewChat}
            onSelectChat={handleSwitchChatConv}
            onDeleteChat={(convId) => void handleSidebarDeleteChat(convId)}
            onRenameChat={handleSidebarRenameChat}
            onStopChat={(convId) => chatStore.abort(convId)}
          />
        </SidebarProvider>

        {/* Sidebar resize rail — rendered outside the floating sidebar so it
            spans full content height (not constrained by Sidebar's p-2) and
            sits above the main pane (z-20) when chat/place pane is open. */}
        {projectSidebarOpen && (
          <div
            className="absolute z-[25] pointer-events-auto"
            style={{ top: 0, bottom: 0, left: projectSidebarWidth, width: 0 }}
          >
            <ResizeHandle
              side="right"
              ariaLabel="Resize sidebar"
              offset={4}
              onPointerDown={startProjectSidebarResize}
            />
          </div>
        )}
      </div>
    </>
  );
}

export default App;
