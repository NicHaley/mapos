import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger
} from "@mapos/ui/components/popover";
import { cn } from "@mapos/ui/lib/utils";
import type { AiState } from "@shared/ai-providers";
import { ChevronsUpDownIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { ModelPickerList } from "./model-picker-list";
import { ProviderBadge } from "./provider-badge";

/**
 * Compact, Cursor-style model switcher: a small trigger showing the active model that opens a
 * popover wrapping the shared {@link ModelPickerList}. Selecting sets the single global active
 * model, so changing it here changes it everywhere. Embedded in the chat composer (and onboarding)
 * so users never need the settings page just to switch models.
 *
 * When no provider is connected there's nothing to pick, so the trigger routes to provider setup
 * via {@link onConfigure} instead of opening an empty popover.
 */
export function ModelSwitcher({
  state,
  onSelected,
  onConfigure,
  className
}: {
  state: AiState;
  /** Called after a successful model selection (e.g. to refresh surrounding state). */
  onSelected: () => void | Promise<void>;
  /** Open provider setup. Used when nothing is connected, and for the "Manage providers" footer.
   * Omit in contexts that already show provider setup (e.g. onboarding). */
  onConfigure?: () => void;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const active = state.active;
  const hasConnected = state.providers.some((p) => p.auth.configured);
  const activeProvider = active
    ? state.providers.find((p) => p.id === active.providerId)
    : undefined;

  const triggerClass = cn(
    "flex h-7 max-w-[200px] items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground",
    className
  );

  if (!hasConnected) {
    return (
      <button type="button" onClick={onConfigure} disabled={!onConfigure} className={triggerClass}>
        <SparklesIcon className="size-3.5 shrink-0" />
        <span className="truncate">Connect AI</span>
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" className={triggerClass}>
            {active && (
              <ProviderBadge
                knownProvider={activeProvider?.knownProvider}
                label={active.providerLabel}
                size="sm"
              />
            )}
            <span className="truncate font-mono">{active ? active.model : "Choose a model"}</span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-[360px] overflow-hidden p-0"
      >
        <PopoverTitle className="sr-only">Change model</PopoverTitle>
        <ModelPickerList
          state={state}
          autoFocus
          listClassName="max-h-[min(50vh,340px)]"
          onManageProviders={
            onConfigure
              ? () => {
                  setOpen(false);
                  onConfigure();
                }
              : undefined
          }
          onSelected={async () => {
            await onSelected();
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
