import { ChatSidebar } from "./components/ChatSidebar";
import { ChatToggle } from "./components/ChatToggle";
import { LeftSidebar } from "./components/LeftSidebar";
import MapView from "./components/MapView";
import { SidebarProvider } from "./components/ui/sidebar";

function App(): React.JSX.Element {
  return (
    <>
      {/* Map: full viewport base layer */}
      <div className="fixed inset-0 z-0">
        <MapView />
      </div>

      {/* Left sidebar overlay */}
      <SidebarProvider
        name="sidebar-left"
        defaultOpen={true}
        className="fixed inset-0 z-10 pointer-events-none bg-transparent"
      >
        <LeftSidebar />
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
