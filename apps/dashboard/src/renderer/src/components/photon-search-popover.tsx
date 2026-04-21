import { SearchIcon } from "lucide-react";
import { type CSSProperties, type ReactElement, useCallback, useState } from "react";

import { modSymbol, useShortcuts } from "@renderer/hooks/use-shortcuts";
import type { PhotonSearchResult } from "@renderer/lib/photon";
import { PhotonSearchPanel } from "./photon-search-panel";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function PhotonSearchPopover({
  onSelectResult,
  className
}: {
  onSelectResult: (result: PhotonSearchResult) => void;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  const handleSelect = useCallback(
    (r: PhotonSearchResult) => {
      onSelectResult(r);
      setOpen(false);
    },
    [onSelectResult]
  );

  useShortcuts([{ def: { key: "k", meta: true }, handler: () => setOpen(true) }]);

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={handleOpenChange} modal={false}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Search places"
                  className={className}
                  style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
                >
                  <SearchIcon className="size-4" />
                </Button>
              }
            />
          }
        />
        <TooltipContent side="bottom">
          Search places
          <KbdGroup>
            <Kbd>{modSymbol}</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </TooltipContent>
        <PopoverContent className="w-96 p-0" align="start" side="bottom" sideOffset={6}>
          <PopoverTitle className="sr-only">Search places</PopoverTitle>
          <PhotonSearchPanel
            active={open}
            placeholder="Search map…"
            onSelectResult={handleSelect}
          />
        </PopoverContent>
      </Popover>
    </Tooltip>
  );
}
