import { useEffect, useRef, useState } from "react";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatToggle } from "./components/ChatToggle";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectToggle } from "./components/ProjectToggle";
import MapView, { type MapViewHandle, type PlaceRecord } from "./components/MapView";
import { PlaceCard } from "./components/PlaceCard";
import { SidebarProvider } from "./components/ui/sidebar";

function App(): React.JSX.Element {
  const [selectedPlace, setSelectedPlace] = useState<PlaceRecord | null>(null);
  const mapRef = useRef<MapViewHandle>(null);

  useEffect(() => {
    if (selectedPlace) {
      mapRef.current?.flyTo(selectedPlace.lat, selectedPlace.lng);
    }
  }, [selectedPlace]);

  return (
    <>
      {/* Map: full viewport base layer */}
      <div className="fixed inset-0 z-0">
        <MapView ref={mapRef} onSelectPlace={setSelectedPlace} />
      </div>

      {/* Place detail card */}
      {selectedPlace && (
        <PlaceCard place={selectedPlace} onClose={() => setSelectedPlace(null)} />
      )}

      {/* Left sidebar overlay */}
      <SidebarProvider
        name="sidebar-left"
        defaultOpen={true}
        className="fixed inset-0 z-10 pointer-events-none bg-transparent"
      >
        <ProjectSidebar selectedFilePath={selectedPlace?.filePath} onSelectPlace={setSelectedPlace} />
        <ProjectToggle />
      </SidebarProvider>

      {/* Right sidebar overlay */}
      <SidebarProvider
        name="sidebar-right"
        defaultOpen={true}
        className="fixed inset-0 z-10 pointer-events-none bg-transparent"
        style={{ "--sidebar-width": "360px" } as React.CSSProperties}
      >
        <ChatSidebar />
        <ChatToggle />
      </SidebarProvider>
    </>
  );
}

export default App;
