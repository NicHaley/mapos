import { PanelLeftIcon } from "lucide-react";
import { Button } from "@mapos/ui/components/button";
import { useSidebar } from "@mapos/ui/components/sidebar";

export function ProjectToggle(): React.JSX.Element {
  const { open, toggleSidebar } = useSidebar();

  if (open) return <></>;

  return (
    <div className="pointer-events-auto fixed left-2 top-2 z-20">
      <Button variant="outline" size="icon" onClick={toggleSidebar}>
        <PanelLeftIcon />
      </Button>
    </div>
  );
}
