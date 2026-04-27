import { PanelRightIcon } from "lucide-react";
import { Button } from "@mapos/ui/components/button";
import { useSidebar } from "@mapos/ui/components/sidebar";

export function ChatToggle(): React.JSX.Element {
  const { open, toggleSidebar } = useSidebar();

  if (open) return <></>;

  return (
    <div className="pointer-events-auto fixed right-2 top-2 z-20">
      <Button variant="outline" size="icon" onClick={toggleSidebar}>
        <PanelRightIcon />
      </Button>
    </div>
  );
}
