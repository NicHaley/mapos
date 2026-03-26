import { MessageCircleIcon, PanelLeftIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatSidebar } from "./components/ChatSidebar";
import MapView, { type MapViewHandle, type PlaceRecord } from "./components/MapView";
import { PlaceCard } from "./components/PlaceCard";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Button } from "./components/ui/button";
import { SidebarProvider } from "./components/ui/sidebar";

function App(): React.JSX.Element {
  const [selectedPlace, setSelectedPlace] = useState<PlaceRecord | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(true);
  const [chatSidebarOpen, setChatSidebarOpen] = useState(true);
  const mapRef = useRef<MapViewHandle>(null);

  const handleSelectPlace = useCallback((place: PlaceRecord) => {
    setSelectedPlace(place);
    setSelectedFolder(null);
  }, []);

  const handleSelectFolder = useCallback((folderPath: string) => {
    setSelectedFolder(folderPath);
    setSelectedPlace(null);
    mapRef.current?.fitToFolder(folderPath);
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

  useEffect(() => {
    if (selectedPlace) {
      mapRef.current?.flyTo(selectedPlace.lat, selectedPlace.lng);
    }
  }, [selectedPlace]);

  return (
    <>
      {/* Map: full viewport, goes under the top bar */}
      <div className="fixed inset-0 z-0">
        <MapView
          ref={mapRef}
          onSelectPlace={handleSelectPlace}
          selectedPlace={selectedPlace}
          selectedFolder={selectedFolder}
          projectSidebarOpen={projectSidebarOpen}
          chatSidebarOpen={chatSidebarOpen}
        />
      </div>

      {/* Top bar */}
      <div
        className="fixed top-0 inset-x-0 h-10 z-30 flex items-center justify-between pl-20 pr-2 text-sidebar-foreground bg-sidebar/60 backdrop-blur-md border-b border-sidebar-border"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
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

      {/* Content wrapper: top-10 offset + transform creates a new containing block
          so all fixed children are relative to this wrapper, not the viewport */}
      <div
        className="fixed top-10 inset-x-0 bottom-0 pointer-events-none"
        style={{ transform: "translateZ(0)" }}
      >
        {/* Place detail card */}
        {selectedPlace && (
          <PlaceCard
            place={selectedPlace}
            onClose={() => setSelectedPlace(null)}
            sidebarOpen={projectSidebarOpen}
          />
        )}

        {/* Left sidebar overlay */}
        <SidebarProvider
          name="sidebar-left"
          open={projectSidebarOpen}
          onOpenChange={setProjectSidebarOpen}
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
        >
          <ProjectSidebar
            selectedFilePath={selectedPlace?.filePath}
            selectedFolderPath={selectedFolder ?? undefined}
            onSelectPlace={handleSelectPlace}
            onSelectFolder={handleSelectFolder}
            onDeletePath={handleDeletedPath}
          />
        </SidebarProvider>

        {/* Right sidebar overlay */}
        <SidebarProvider
          name="sidebar-right"
          open={chatSidebarOpen}
          onOpenChange={setChatSidebarOpen}
          className="fixed inset-0 z-10 pointer-events-none bg-transparent"
          style={{ "--sidebar-width": "360px" } as React.CSSProperties}
        >
          <ChatSidebar />
        </SidebarProvider>
      </div>
    </>
  );
}

export default App;
