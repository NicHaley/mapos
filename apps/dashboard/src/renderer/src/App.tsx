import Chat from "./components/Chat";
import MapView from "./components/MapView";
import { AppSidebar } from "./components/AppSidebar";
import { LeftSidebar } from "./components/LeftSidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./components/ui/sidebar";

function App(): React.JSX.Element {
  return (
    <SidebarProvider name="sidebar-left" defaultOpen={true}>
      <LeftSidebar />
      <SidebarProvider
        name="sidebar-right"
        defaultOpen={true}
        style={{ "--sidebar-width": "360px" } as React.CSSProperties}
        className="flex-1 min-w-0"
      >
        <SidebarInset className="relative overflow-hidden">
          <MapView />
          <div className="absolute top-2 right-2 z-10">
            <SidebarTrigger className="rotate-180" />
          </div>
        </SidebarInset>
        <AppSidebar>
          <Chat />
        </AppSidebar>
      </SidebarProvider>
    </SidebarProvider>
  );
}

export default App;
