import { Sidebar, SidebarContent } from "./ui/sidebar";

interface AppSidebarProps {
  children: React.ReactNode;
}

export function AppSidebar({ children }: AppSidebarProps): React.JSX.Element {
  return (
    <Sidebar side="right" collapsible="offcanvas">
      <SidebarContent className="p-0">{children}</SidebarContent>
    </Sidebar>
  );
}
