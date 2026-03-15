import { BookmarkIcon, FolderIcon, MapIcon, SearchIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger
} from "./ui/sidebar";

const navItems = [{ icon: FolderIcon, label: "Browse" }];

export function LeftSidebar(): React.JSX.Element {
  return (
    <Sidebar collapsible="icon" variant="floating">
      <SidebarHeader className="flex-row items-center gap-2 px-3 py-3">
        <SidebarTrigger />
        <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase group-data-[collapsible=icon]:hidden">
          MapOS
        </span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {navItems.map(({ icon: Icon, label }) => (
              <SidebarMenuItem key={label}>
                <SidebarMenuButton tooltip={label}>
                  <Icon />
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
