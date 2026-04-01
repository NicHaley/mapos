import { MessageCircleIcon, PanelLeftIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ChatSidebar } from "./components/ChatSidebar";
import MapView, { type MapViewHandle, type PlaceRecord } from "./components/MapView";
import { NavTabs } from "./components/NavTabs";
import { PhotonSearchPopover } from "./components/PhotonSearchPopover";
import { PlaceCard } from "./components/PlaceCard";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Button } from "./components/ui/button";
import { SidebarProvider } from "./components/ui/sidebar";
import { type NavEntry, folderLabel, navReducer, useNavTabs } from "./hooks/useNavTabs";
import type { PhotonSearchResult } from "./lib/photon";

const PROJECT_SIDEBAR_WIDTH = 256;
const PLACE_CARD_WIDTH = 320;
const CHAT_SIDEBAR_WIDTH = 360;
const TOP_BAR_HEIGHT = 40;
const FIT_BUFFER = 40;

function placeFromPhotonSearchResult(r: PhotonSearchResult): PlaceRecord {
  const geometry = JSON.stringify({
    type: "Point",
    coordinates: [r.lng, r.lat]
  });
  const previewMarkdown = [
    r.secondaryLabel ? `*${r.secondaryLabel}*` : null,
    "Search result from OpenStreetMap (Photon). Not saved to your vault."
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    filePath: `photon-search:${r.id}`,
    title: r.primaryLabel,
    type: "Search",
    geometry,
    previewMarkdown
  };
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
  const mapRef = useRef<MapViewHandle>(null);
  const selectedFolderRef = useRef(selectedFolder);
  selectedFolderRef.current = selectedFolder;

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
    handleNavBack,
    handleNavForward
  } = useNavTabs({ openEntry, onEmpty: onNavEmpty });

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
      dispatchNav({
        type: "navigate",
        entry: { kind: "folder", folderPath, label: folderLabel(folderPath) },
        newTab: false
      });
      mapRef.current?.fitToFolder(
        folderPath,
        mapPadding(projectSidebarOpen, chatSidebarOpen, false)
      );
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
      setSelectedFolder(null);
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
      mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
    },
    [projectSidebarOpen, chatSidebarOpen]
  );

  const handleRenamePath = useCallback((oldPath: string, newPath: string) => {
    setSelectedFolder((prev) => {
      if (!prev) return prev;
      if (prev === oldPath) return newPath;
      if (prev.startsWith(`${oldPath}/`) || prev.startsWith(`${oldPath}\\`))
        return newPath + prev.slice(oldPath.length);
      return prev;
    });
  }, []);

  const handleDeletedPath = useCallback(
    (deletedPath: string, type: "file" | "directory") => {
      const isSameOrChildPath = (currentPath: string, parentPath: string) =>
        currentPath === parentPath ||
        currentPath.startsWith(`${parentPath}/`) ||
        currentPath.startsWith(`${parentPath}\\`);

      const isFolder = type === "directory";
      const nextNavState = navReducer(nav, { type: "remove_path", path: deletedPath, isFolder });
      dispatchNav({ type: "remove_path", path: deletedPath, isFolder });

      if (isFolder) {
        const wasAffected =
          (selectedFolder && isSameOrChildPath(selectedFolder, deletedPath)) ||
          (selectedPlace && isSameOrChildPath(selectedPlace.filePath, deletedPath));
        setSelectedFolder((prev) => (prev && isSameOrChildPath(prev, deletedPath) ? null : prev));
        setSelectedPlace((prev) =>
          prev && isSameOrChildPath(prev.filePath, deletedPath) ? null : prev
        );
        if (wasAffected) {
          const nextTab = nextNavState.tabs[nextNavState.activeTab];
          const nextEntry = nextTab?.history[nextTab.cursor];
          if (nextEntry) openEntry(nextEntry);
          else onNavEmpty();
        }
      } else {
        if (selectedPlace?.filePath === deletedPath) {
          const nextTab = nextNavState.tabs[nextNavState.activeTab];
          const nextEntry = nextTab?.history[nextTab.cursor];
          if (nextEntry) openEntry(nextEntry);
          else clearPlace();
        }
      }
    },
    [selectedPlace, selectedFolder, nav, dispatchNav, openEntry, clearPlace, onNavEmpty]
  );

  const isMini = selectedPlace !== null && placeMode === "mini";
  const isFull = selectedPlace !== null && placeMode === "full";

  return (
    <>
      {/* Map: full viewport, goes under the top bar */}
      <div className="fixed inset-0 z-0">
        <MapView
          ref={mapRef}
          onSelectPlace={handleSelectPlaceFromMap}
          onCreatePlace={handleCreatePlace}
          onMapClickEmpty={isMini ? clearPlace : undefined}
          selectedPlace={selectedPlace}
          selectedFolder={selectedFolder}
          onSelectedFeaturePosition={(x, y) => setFeatureScreenPos({ x, y })}
        />
      </div>

      {/* Top bar */}
      <div
        className="fixed top-0 inset-x-0 z-30 flex items-center gap-1 pl-20 pr-2 text-sidebar-foreground bg-sidebar/80 backdrop-blur-md border-b border-sidebar-border"
        style={{ height: TOP_BAR_HEIGHT, WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setProjectSidebarOpen((o) => !o)}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <PanelLeftIcon className="size-4" />
        </Button>
        <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <PhotonSearchPopover onSelectResult={handlePhotonSearchResult} />
        </div>
        <div
          className="flex-1 min-w-0 flex items-center h-full"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <NavTabs
            tabs={navTabsData}
            activeTabIndex={activeTabIndex}
            canBack={canBack}
            canForward={canForward}
            onTabActivate={handleNavTabActivate}
            onTabClose={handleNavTabClose}
            onBack={handleNavBack}
            onForward={handleNavForward}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setChatSidebarOpen((o) => !o)}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <MessageCircleIcon className="size-4" />
        </Button>
      </div>

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
              width: PLACE_CARD_WIDTH,
              transition: "left 200ms linear"
            }}
          >
            <PlaceCard
              place={selectedPlace}
              mode="full"
              onClose={clearPlace}
              onNavigate={handleSelectPlaceFromSidebar}
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
              place={selectedPlace}
              mode="mini"
              onClose={clearPlace}
              onNavigate={handleSelectPlaceFromSidebar}
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
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
          style={{ "--sidebar-width": `${PROJECT_SIDEBAR_WIDTH}px` } as React.CSSProperties}
        >
          <ProjectSidebar
            selectedFilePath={isFull ? selectedPlace?.filePath : undefined}
            selectedFolderPath={selectedFolder ?? undefined}
            onSelectPlace={handleSelectPlaceFromSidebar}
            onSelectFolder={handleSelectFolder}
            onDeletePath={handleDeletedPath}
            onRenamePath={handleRenamePath}
          />
        </SidebarProvider>

        {/* Right sidebar overlay */}
        <SidebarProvider
          name="sidebar-right"
          open={chatSidebarOpen}
          onOpenChange={setChatSidebarOpen}
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
          style={{ "--sidebar-width": `${CHAT_SIDEBAR_WIDTH}px` } as React.CSSProperties}
        >
          <ChatSidebar />
        </SidebarProvider>
      </div>
    </>
  );
}

export default App;
