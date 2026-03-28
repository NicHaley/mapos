import { MessageCircleIcon, PanelLeftIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatSidebar } from "./components/ChatSidebar";
import MapView, { type MapViewHandle, type PlaceRecord } from "./components/MapView";
import { PlaceCard } from "./components/PlaceCard";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Button } from "./components/ui/button";
import { SidebarProvider } from "./components/ui/sidebar";

const PROJECT_SIDEBAR_WIDTH = 256;
const PLACE_CARD_WIDTH = 320;
const CHAT_SIDEBAR_WIDTH = 360;
const TOP_BAR_HEIGHT = 40;
const FIT_BUFFER = 40;

function mapPadding(
  projectSidebarOpen: boolean,
  chatSidebarOpen: boolean,
  placeCardOpen: boolean
) {
  return {
    left: (projectSidebarOpen ? PROJECT_SIDEBAR_WIDTH : 0) + (placeCardOpen ? PLACE_CARD_WIDTH : 0) + FIT_BUFFER,
    right: (chatSidebarOpen ? CHAT_SIDEBAR_WIDTH : 0) + FIT_BUFFER,
    top: TOP_BAR_HEIGHT + FIT_BUFFER,
    bottom: FIT_BUFFER,
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

  // Map feature click — show mini card; no-op when full panel is active
  const handleSelectPlaceFromMap = useCallback((place: PlaceRecord) => {
    if (placeMode === "full") return;
    setSelectedPlace(place);
    setPlaceMode("mini");
    setFeatureScreenPos(null);
    if (!selectedFolderRef.current) {
      setSelectedFolder(null);
      mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
    }
  }, [placeMode, projectSidebarOpen, chatSidebarOpen]);

  // Sidebar file click — show full panel and fly to the place
  const handleSelectPlaceFromSidebar = useCallback((place: PlaceRecord) => {
    const alreadyOpen = placeMode === "full" && selectedPlace?.filePath === place.filePath;
    setSelectedPlace(place);
    setPlaceMode("full");
    setSelectedFolder(null);
    setFeatureScreenPos(null);
    if (!alreadyOpen) {
      mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
    }
  }, [placeMode, selectedPlace, projectSidebarOpen, chatSidebarOpen]);

  // New place file created from map context menu
  const handleCreatePlace = useCallback((place: PlaceRecord) => {
    if (selectedFolder) {
      // Inside a collection — show mini card, keep folder active
      setSelectedPlace(place);
      setPlaceMode("mini");
      setFeatureScreenPos(null);
    } else {
      // Outside a collection — open full panel
      setSelectedPlace(place);
      setPlaceMode("full");
      setFeatureScreenPos(null);
      mapRef.current?.fitToPlace(place, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
    }
  }, [selectedFolder, projectSidebarOpen, chatSidebarOpen]);

  const handleSelectFolder = useCallback((folderPath: string) => {
    setSelectedFolder(folderPath);
    setSelectedPlace(null);
    setPlaceMode("mini");
    setFeatureScreenPos(null);
    mapRef.current?.fitToFolder(folderPath, mapPadding(projectSidebarOpen, chatSidebarOpen, false));
  }, [projectSidebarOpen, chatSidebarOpen]);

  const handleRenamePath = useCallback((oldPath: string, newPath: string) => {
    setSelectedFolder((prev) => {
      if (!prev) return prev;
      if (prev === oldPath) return newPath;
      if (prev.startsWith(`${oldPath}/`) || prev.startsWith(`${oldPath}\\`))
        return newPath + prev.slice(oldPath.length);
      return prev;
    });
  }, []);

  const handleDeletedPath = useCallback((deletedPath: string, type: "file" | "directory") => {
    const isSameOrChildPath = (currentPath: string, parentPath: string) =>
      currentPath === parentPath ||
      currentPath.startsWith(`${parentPath}/`) ||
      currentPath.startsWith(`${parentPath}\\`);

    if (type === "file") {
      setSelectedPlace((prev) => (prev?.filePath === deletedPath ? null : prev));
      return;
    }
    setSelectedFolder((prev) => (prev && isSameOrChildPath(prev, deletedPath) ? null : prev));
    setSelectedPlace((prev) =>
      prev && isSameOrChildPath(prev.filePath, deletedPath) ? null : prev
    );
  }, []);

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
        className="fixed top-0 inset-x-0 z-30 flex items-center justify-between pl-20 pr-2 text-sidebar-foreground bg-sidebar/60 backdrop-blur-md border-b border-sidebar-border"
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
              transition: "left 200ms linear",
            }}
          >
            <PlaceCard place={selectedPlace} mode="full" onClose={clearPlace} />
          </div>
        )}

        {/* Ping dot — shown for both mini and full modes whenever we have a screen position */}
        {selectedPlace && featureScreenPos && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: featureScreenPos.x,
              top: featureScreenPos.y - TOP_BAR_HEIGHT,
              transform: "translate(-50%, -50%)",
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
              transform: "translate(-50%, calc(-100% - 16px))",
            }}
          >
            <PlaceCard
              place={selectedPlace}
              mode="mini"
              onClose={clearPlace}
              onExpand={() => {
                setPlaceMode("full");
                setSelectedFolder(null);
                mapRef.current?.fitToPlace(selectedPlace, mapPadding(projectSidebarOpen, chatSidebarOpen, true));
              }}
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
