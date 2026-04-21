import type { MapOverlayPayload } from "@shared/types";
import { bbox } from "@turf/bbox";
import { MessageCircleIcon, PanelLeftIcon } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatSidebar } from "./components/chat-sidebar";
import MapView, { type MapViewHandle, type PlaceRecord } from "./components/map-view";
import { NavTabs } from "./components/nav-tabs";
import { PhotonSearchPopover } from "./components/photon-search-popover";
import { PlaceCard } from "./components/place-card";
import { ProjectSidebar } from "./components/project-sidebar";
import { Button } from "./components/ui/button";
import { Kbd, KbdGroup } from "./components/ui/kbd";
import { type SidebarKeyboardShortcutConfig, SidebarProvider } from "./components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { useMapOverlaySync } from "./hooks/use-map-overlay-sync";
import { type NavEntry, folderLabel, useNavTabs } from "./hooks/use-nav-tabs";
import { useOverlayVaultSync } from "./hooks/use-overlay-vault-sync";
import { usePathSync } from "./hooks/use-path-sync";
import { usePlacesWatcher } from "./hooks/use-places-watcher";
import { modSymbol, useShortcuts } from "./hooks/use-shortcuts";
import type { PhotonSearchResult } from "./lib/photon";
import { filenameBaseFromPlaceTitle, renameCreatedPlaceToSlug } from "./lib/place-utils";

const BASE_UNITS = 16;

const PROJECT_SIDEBAR_WIDTH = 14 * BASE_UNITS;
const PLACE_CARD_WIDTH = 22 * BASE_UNITS;
const CHAT_SIDEBAR_WIDTH = 22 * BASE_UNITS;
const TOP_BAR_HEIGHT = 2.5 * BASE_UNITS;
const FIT_BUFFER = 2.5 * BASE_UNITS;

const SIDEBAR_KB_PROJECT: SidebarKeyboardShortcutConfig = { shift: false };
const SIDEBAR_KB_CHAT: SidebarKeyboardShortcutConfig = { shift: true };

const EMPTY_MAP_OVERLAY: MapOverlayPayload = {
  layerName: "",
  points: [],
  lines: [],
  polygons: []
};

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

function placeFromPhotonSearchResult(r: PhotonSearchResult): PlaceRecord {
  const geometry = JSON.stringify({
    type: "Point",
    coordinates: [r.lng, r.lat]
  });
  return {
    filePath: `photon-search:${r.id}`,
    title: r.primaryLabel,
    type: "Search",
    geometry,
    /** Present (may be empty) so PlaceCard stays in preview mode without reading a file. */
    previewMarkdown: ""
  };
}

/** Directory containing a vault file path (browser-safe; avoids Node `path` in the renderer bundle). */
function parentFolderOfVaultFile(filePath: string): string {
  const n = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (n === -1) return ".";
  if (n === 0) return filePath.slice(0, 1);
  return filePath.slice(0, n);
}

function mapPadding(projectSidebarOpen: boolean, chatSidebarOpen: boolean, placeCardOpen: boolean) {
  return {
    left:
      (projectSidebarOpen ? PROJECT_SIDEBAR_WIDTH : 0) +
      (placeCardOpen ? PLACE_CARD_WIDTH : 0) +
      FIT_BUFFER,
    right: (chatSidebarOpen ? CHAT_SIDEBAR_WIDTH : 0) + FIT_BUFFER,
    top: TOP_BAR_HEIGHT + FIT_BUFFER,
    bottom: FIT_BUFFER
  };
}

function App(): React.JSX.Element {
  const [selectedPlace, setSelectedPlace] = useState<PlaceRecord | null>(null);
  const [placeMode, setPlaceMode] = useState<"mini" | "full">("mini");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(true);
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false);
  const [featureScreenPos, setFeatureScreenPos] = useState<{ x: number; y: number } | null>(null);
  /** Last real vault file path (kept when switching to a Photon search preview). */
  const [lastVaultFilePath, setLastVaultFilePath] = useState<string | null>(null);
  const [mapOverlay, setMapOverlay] = useState<MapOverlayPayload>(EMPTY_MAP_OVERLAY);
  /** Bumps when a non-empty overlay is pushed so chat can re-show "Add all". */
  const [mapOverlayNonce, setMapOverlayNonce] = useState(0);
  const [addAllOverlayBusy, setAddAllOverlayBusy] = useState(false);
  const [activeGeoJsonLayers, setActiveGeoJsonLayers] = useState<
    Array<{
      filePath: string;
      data: Record<string, unknown>;
      bbox: [number, number, number, number];
    }>
  >([]);
  const mapRef = useRef<MapViewHandle>(null);
  const selectedFolderRef = useRef(selectedFolder);
  selectedFolderRef.current = selectedFolder;
  const selectedPlaceRef = useRef(selectedPlace);
  selectedPlaceRef.current = selectedPlace;

  useEffect(() => {
    const p = selectedPlace?.filePath;
    if (!p) {
      setLastVaultFilePath(null);
      return;
    }
    if (!p.startsWith("photon-search:") && !p.startsWith("map-overlay:")) {
      setLastVaultFilePath(p);
    }
  }, [selectedPlace]);

  // MapView.emitFeaturePosition returns early when there is no geometry, so the ping would
  // otherwise keep the last screen position after a clear (or any selection without geometry).
  useEffect(() => {
    if (!selectedPlace?.geometry) {
      setFeatureScreenPos(null);
    }
  }, [selectedPlace]);

  const parentFolderForNewFiles = useMemo(
    () => selectedFolder ?? (lastVaultFilePath ? parentFolderOfVaultFile(lastVaultFilePath) : null),
    [selectedFolder, lastVaultFilePath]
  );

  const clearPlace = useCallback(() => {
    setSelectedPlace(null);
    setPlaceMode("mini");
    setFeatureScreenPos(null);
  }, []);

  // Open a nav entry without pushing to history (used by back/forward/tab switch)
  const openEntry = useCallback(
    (entry: NavEntry) => {
      if (entry.kind === "place") {
        setSelectedPlace(entry.place);
        setPlaceMode("full");
        setSelectedFolder(null);
        setFeatureScreenPos(null);
        mapRef.current?.fitToPlace(
          entry.place,
          mapPadding(projectSidebarOpen, chatSidebarOpen, true)
        );
      } else {
        setSelectedFolder(entry.folderPath);
        setSelectedPlace(null);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
        mapRef.current?.fitToFolder(
          entry.folderPath,
          mapPadding(projectSidebarOpen, chatSidebarOpen, false)
        );
      }
    },
    [projectSidebarOpen, chatSidebarOpen]
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

  usePlacesWatcher({ selectedPlaceRef, clearPlace });
  useMapOverlaySync({ selectedPlaceRef, clearPlace, setMapOverlay, setMapOverlayNonce });

  const handlePlaceRename = useCallback(
    (oldPath: string, newPath: string) => {
      dispatchNav({ type: "relocate_path", oldPath, newPath, isDirectory: false });
    },
    [dispatchNav]
  );

  useShortcuts([
    {
      def: { key: "w", meta: true, enabled: activeTabIndex >= 0 },
      handler: () => handleNavTabClose(activeTabIndex)
    }
  ]);

  function handlePlaceCardClose() {
    // Full place cards should close exactly like the active top-bar tab.
    if (placeMode !== "full" || activeTabIndex < 0) {
      clearPlace();
      return;
    }
    handleNavTabClose(activeTabIndex);
  }

  // Map feature click — show mini card; no-op when full panel is active
  const handleSelectPlaceFromMap = useCallback(
    (place: PlaceRecord) => {
      if (placeMode === "full") return;
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      if (!selectedFolderRef.current) {
        setSelectedFolder(null);
        mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
      }
    },
    [placeMode, projectSidebarOpen, chatSidebarOpen]
  );

  // Sidebar file click — navigate within active tab (or new tab on cmd/ctrl+click)
  const handleSelectPlaceFromSidebar = useCallback(
    (place: PlaceRecord, newTab = false) => {
      const alreadyOpen = placeMode === "full" && selectedPlace?.filePath === place.filePath;
      setSelectedPlace(place);
      setPlaceMode("full");
      setSelectedFolder(null);
      setFeatureScreenPos(null);
      dispatchNav({ type: "navigate", entry: { kind: "place", place }, newTab });
      if (!alreadyOpen) {
        mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
      }
    },
    [placeMode, selectedPlace, projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  // Sidebar folder click — navigate within active tab
  const handleSelectFolder = useCallback(
    (folderPath: string) => {
      setSelectedFolder(folderPath);
      setSelectedPlace(null);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      setActiveGeoJsonLayers([]);
      dispatchNav({
        type: "navigate",
        entry: { kind: "folder", folderPath, label: folderLabel(folderPath) },
        newTab: false
      });
      mapRef.current?.fitToFolder(
        folderPath,
        mapPadding(projectSidebarOpen, chatSidebarOpen, false)
      );
      void window.api.fs.geoJsonFilesInFolder(folderPath).then(async (paths) => {
        const results = await Promise.all(paths.map((p) => window.api.fs.readGeoJson(p)));
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
    },
    [projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  const handleSelectGeoJson = useCallback(
    async (filePath: string) => {
      const data = await window.api.fs.readGeoJson(filePath);
      if (!data) return;
      const layerBbox = bbox(data as unknown as Parameters<typeof bbox>[0]) as [
        number,
        number,
        number,
        number
      ];
      setActiveGeoJsonLayers([{ filePath, data, bbox: layerBbox }]);

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
      mapRef.current?.fitToGeoJson(data, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
    },
    [projectSidebarOpen, chatSidebarOpen, dispatchNav]
  );

  // New place file created from map context menu
  const handleCreatePlace = useCallback(
    (place: PlaceRecord) => {
      if (selectedFolder) {
        setSelectedPlace(place);
        setPlaceMode("mini");
        setFeatureScreenPos(null);
      } else {
        setSelectedPlace(place);
        setPlaceMode("full");
        setFeatureScreenPos(null);
        mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
      }
    },
    [selectedFolder, projectSidebarOpen, chatSidebarOpen]
  );

  const handlePhotonSearchResult = useCallback(
    (r: PhotonSearchResult) => {
      const place = placeFromPhotonSearchResult(r);
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
    },
    [projectSidebarOpen, chatSidebarOpen]
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
      setSelectedPlace(updated);
      dispatchNav({ type: "update-entry", filePath: updated.filePath, place: updated });
      mapRef.current?.fitToPlace(
        updated,
        mapPadding(projectSidebarOpen, chatSidebarOpen, placeMode === "full")
      );
      return true;
    },
    [projectSidebarOpen, chatSidebarOpen, placeMode, dispatchNav]
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
      setSelectedPlace(cleared);
      dispatchNav({ type: "update-entry", filePath, place: cleared });
      mapRef.current?.invalidateFolderPlace(filePath);
      return true;
    },
    [dispatchNav]
  );

  const handleSaveSearchToVault = useCallback(async () => {
    const place = selectedPlace;
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
    if (selectedFolder) {
      setSelectedPlace(created);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      mapRef.current?.fitToPlace(created, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
    } else {
      setSelectedPlace(created);
      setPlaceMode("full");
      setFeatureScreenPos(null);
      dispatchNav({
        type: "navigate",
        entry: { kind: "place", place: created },
        newTab: false
      });
      mapRef.current?.fitToPlace(created, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
    }
  }, [
    parentFolderForNewFiles,
    selectedFolder,
    selectedPlace,
    projectSidebarOpen,
    chatSidebarOpen,
    dispatchNav
  ]);

  const handleOverlayRestore = useCallback((overlay: MapOverlayPayload | null) => {
    if (overlay) {
      setMapOverlay(overlay);
      setMapOverlayNonce((n) => n + 1);
    } else {
      setMapOverlay(EMPTY_MAP_OVERLAY);
    }
  }, []);

  const { handleAddAllOverlayToVault } = useOverlayVaultSync({
    mapOverlay,
    parentFolderForNewFiles,
    setAddAllOverlayBusy
  });

  const { handleRenamePath, handlePathRelocated, handleDeletedPath } = usePathSync({
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
    if (isMini) clearPlace();
  }, [isMini, clearPlace]);

  /** Sidebar tree highlight: follow the active tab's place, not `selectedPlace` (Photon replaces that in mini mode). */
  const selectedFilePathForSidebar = useMemo(() => {
    const tab = nav.tabs[nav.activeTab];
    const entry = tab?.history[tab.cursor];
    if (entry?.kind !== "place") return undefined;
    const fp = entry.place.filePath;
    // Sidebar matches real vault paths only; preview ids are not files on disk.
    if (fp.startsWith("photon-search:") || fp.startsWith("map-overlay:")) return undefined;
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
          onMapClickEmpty={isMini ? handleMapClickEmpty : undefined}
          selectedPlace={selectedPlace}
          selectedFolder={selectedFolder}
          parentFolderForNewFiles={parentFolderForNewFiles}
          onSelectedFeaturePosition={(x, y) => setFeatureScreenPos({ x, y })}
          mapOverlay={{
            points: mapOverlay.points,
            lines: mapOverlay.lines,
            polygons: mapOverlay.polygons
          }}
          showOverlay={chatSidebarOpen}
          // @ts-expect-error - activeGeoJsonLayers data shape matches RawFeatureCollection
          geoJsonLayers={activeGeoJsonLayers}
        />
      </div>

      {/* Top bar */}
      <motion.div
        layoutRoot
        className="fixed top-0 inset-x-0 z-30 flex items-center gap-1 pl-20 pr-2 text-sidebar-foreground bg-sidebar/80 backdrop-blur-md border-b border-sidebar-border"
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
          <PhotonSearchPopover onSelectResult={handlePhotonSearchResult} />
        </div>
        <div className="flex-1 min-w-0 flex items-center h-full min-h-0" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <NavTabs
            tabs={navTabsData}
            activeTabIndex={activeTabIndex}
            canBack={canBack}
            canForward={canForward}
            onTabActivate={handleNavTabActivate}
            onTabClose={handleNavTabClose}
            onTabReorder={handleNavTabReorder}
            onBack={handleNavBack}
            onForward={handleNavForward}
          />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setChatSidebarOpen((o) => !o)}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <MessageCircleIcon className="size-4" />
              </Button>
            }
          />
          <TooltipContent side="bottom">
            Chat
            <KbdGroup>
              <Kbd>{modSymbol}</Kbd>
              <Kbd>⇧</Kbd>
              <Kbd>{"\\"}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      </motion.div>

      {/* Content wrapper: top offset + transform creates a new containing block
          so all fixed children are relative to this wrapper, not the viewport */}
      <div
        className="fixed inset-x-0 bottom-0 pointer-events-none"
        style={{ top: TOP_BAR_HEIGHT, transform: "translateZ(0)" }}
      >
        {/* Full-height place panel */}
        {isFull && selectedPlace && (
          <div
            className="absolute top-0 bottom-0 z-20 pointer-events-auto p-2"
            style={{
              left: projectSidebarOpen ? PROJECT_SIDEBAR_WIDTH : 0,
              width: PLACE_CARD_WIDTH
            }}
          >
            <PlaceCard
              key={selectedPlace.filePath}
              place={selectedPlace}
              mode="full"
              onClose={handlePlaceCardClose}
              onNavigate={handleSelectPlaceFromSidebar}
              onRename={handlePlaceRename}
              onCommitPointLocation={commitVaultPointLocation}
              onClearPointLocation={clearVaultPointLocation}
            />
          </div>
        )}

        {/* Ping dot — shown for both mini and full modes whenever we have a screen position */}
        {selectedPlace && featureScreenPos && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: featureScreenPos.x,
              top: featureScreenPos.y - TOP_BAR_HEIGHT,
              transform: "translate(-50%, -50%)"
            }}
          >
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-white shadow-sm" />
            </span>
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
                      mapRef.current?.fitToPlace(
                        selectedPlace,
                        mapPadding(projectSidebarOpen, chatSidebarOpen, true)
                      );
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
          style={{ "--sidebar-width": `${PROJECT_SIDEBAR_WIDTH}px` } as React.CSSProperties}
        >
          <ProjectSidebar
            selectedFilePath={selectedFilePathForSidebar}
            selectedFolderPath={selectedFolder ?? undefined}
            onSelectPlace={handleSelectPlaceFromSidebar}
            onSelectFolder={handleSelectFolder}
            onSelectGeoJson={(p) => void handleSelectGeoJson(p)}
            onDeletePath={handleDeletedPath}
            onRenamePath={handleRenamePath}
            onMoved={handlePathRelocated}
          />
        </SidebarProvider>

        {/* Right sidebar overlay */}
        <SidebarProvider
          name="sidebar-right"
          open={chatSidebarOpen}
          onOpenChange={setChatSidebarOpen}
          keyboardShortcut={SIDEBAR_KB_CHAT}
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
          style={{ "--sidebar-width": `${CHAT_SIDEBAR_WIDTH}px` } as React.CSSProperties}
        >
          <ChatSidebar
            mapOverlay={mapOverlay}
            mapOverlayNonce={mapOverlayNonce}
            onAddAllOverlayToVault={handleAddAllOverlayToVault}
            addAllOverlayBusy={addAllOverlayBusy}
            onOverlayRestore={handleOverlayRestore}
            onOpenFile={async (filePath) => {
              const place = await window.api.places.getByPath(filePath);
              if (place) handleSelectPlaceFromSidebar(place);
            }}
          />
        </SidebarProvider>
      </div>
    </>
  );
}

export default App;
