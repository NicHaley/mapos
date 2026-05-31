import { SearchIcon } from "lucide-react";
import { type CSSProperties, type ReactElement, useCallback, useState } from "react";

import { modSymbol, useShortcuts } from "@renderer/hooks/use-shortcuts";
import type { GeocodeSearchResult } from "@renderer/lib/geocode-search";
import type { ConversationMeta, PlaceRecord } from "@shared/types";
import { GeocodeSearchPanel } from "./geocode-search-panel";
import { Button } from "@mapos/ui/components/button";
import { Kbd, KbdGroup } from "@mapos/ui/components/kbd";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mapos/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mapos/ui/components/tooltip";

export function GeocodeSearchPopover({
  onSelectResult,
  files,
  onSelectFile,
  conversations,
  onSelectConversation,
  className
}: {
  onSelectResult: (result: GeocodeSearchResult) => void;
  files?: PlaceRecord[];
  onSelectFile?: (file: PlaceRecord) => void;
  conversations?: ConversationMeta[];
  onSelectConversation?: (conversation: ConversationMeta) => void;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  const handleSelect = useCallback(
    (r: GeocodeSearchResult) => {
      onSelectResult(r);
      setOpen(false);
    },
    [onSelectResult]
  );

  const handleSelectFile = useCallback(
    (file: PlaceRecord) => {
      onSelectFile?.(file);
      setOpen(false);
    },
    [onSelectFile]
  );

  const handleSelectConversation = useCallback(
    (conversation: ConversationMeta) => {
      onSelectConversation?.(conversation);
      setOpen(false);
    },
    [onSelectConversation]
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
          <GeocodeSearchPanel
            active={open}
            placeholder="Search places, files, conversations…"
            onSelectResult={handleSelect}
            files={files}
            onSelectFile={handleSelectFile}
            conversations={conversations}
            onSelectConversation={handleSelectConversation}
          />
        </PopoverContent>
      </Popover>
    </Tooltip>
  );
}
