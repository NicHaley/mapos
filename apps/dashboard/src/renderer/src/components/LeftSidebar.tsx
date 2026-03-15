import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "./ui/sidebar";
import { FolderIcon, MapIcon, BookmarkIcon, SearchIcon } from "lucide-react";

const navItems = [
  { icon: MapIcon, label: "Map" },
  { icon: SearchIcon, label: "Explore" },
  { icon: BookmarkIcon, label: "Collections" },
  { icon: FolderIcon, label: "Browse" },
];

export function LeftSidebar(): React.JSX.Element {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex-row items-center gap-2 px-3 py-3">
        <SidebarTrigger />
        <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase group-data-[collapsible=icon]:hidden">
          MapOS
        </span>
      </SidebarHeader>
      <SidebarContent>
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
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
