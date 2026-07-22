import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { TooltipContent } from "@mapos/ui/components/tooltip";
import { modSymbol } from "../hooks/use-shortcuts";

/**
 * Shared tooltip body for every "New note" affordance so their copy + hotkey stay in sync.
 */
export function NewNoteTooltipContent({
  side = "bottom"
}: {
  side?: "top" | "bottom" | "left" | "right";
}): React.JSX.Element {
  return (
    <TooltipContent side={side}>
      New note
      <KbdGroup>
        <Kbd>{modSymbol}</Kbd>
        <Kbd>N</Kbd>
      </KbdGroup>
    </TooltipContent>
  );
}
