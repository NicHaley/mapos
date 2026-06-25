import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from "@mapos/ui/components/command";
import type { ModelCapabilities } from "@shared/ai-models";
import type { AiState, CapabilitySource, ProviderView } from "@shared/ai-providers";
import { CheckIcon, Loader2Icon, LockIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CapabilityBadges } from "./capability-badges";
import { ProviderBadge } from "./provider-badge";

type PickerModel = {
  /** Model id passed to setActive (also shown to the user). */
  id: string;
  capabilities: ModelCapabilities;
  source?: CapabilitySource;
  selectable: boolean;
};

type PickerGroup = {
  key: string;
  title: string;
  /** Provider id used for setActive + active-match. */
  providerId: string;
  knownProvider: string | null;
  connected: boolean;
  models: PickerModel[];
};

/** Whether listing a provider's models is worthwhile: known providers ship a catalog; custom endpoints
 * only yield a list once they have a usable token. */
function shouldFetch(p: ProviderView): boolean {
  return !!p.knownProvider || p.auth.configured;
}

/**
 * The shared model selector body, built on the same Command primitives as the other search popovers
 * (e.g. the folder picker). Aggregates each configured provider's models into one searchable list
 * and sets the global active selection on pick. Select-only: models from a not-connected provider
 * render locked/disabled (connecting happens in the Providers list, never here).
 *
 * Mount this only while visible — it fetches model lists on mount. Both the settings sheet and the
 * in-chat switcher embed it so the picking experience stays identical.
 */
export function ModelPickerList({
  state,
  onSelected,
  onManageProviders,
  autoFocus = false,
  className,
  listClassName
}: {
  state: AiState;
  /** Called after a successful selection (e.g. to close the surrounding sheet/popover). */
  onSelected: () => void | Promise<void>;
  /** When set, appends a "Manage providers" action at the bottom of the list. */
  onManageProviders?: () => void;
  autoFocus?: boolean;
  /** Override the Command wrapper (e.g. drop the popover background inside a sheet). */
  className?: string;
  /** Override the scroll area height for the surrounding surface. */
  listClassName?: string;
}): React.JSX.Element {
  const [groups, setGroups] = useState<PickerGroup[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // Build the grouped catalog on mount and whenever the provider set changes.
  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    void (async () => {
      const providerGroups = await Promise.all(
        state.providers.map(async (p): Promise<PickerGroup> => {
          const models = shouldFetch(p) ? await window.api.ai.listModels(p.id) : null;
          const rows: PickerModel[] =
            models?.ok === true
              ? models.models.map((m) => ({
                  id: m.id,
                  capabilities: m.capabilities,
                  source: m.capabilitySource,
                  selectable: p.auth.configured
                }))
              : [];
          return {
            key: p.id,
            title: p.label,
            providerId: p.id,
            knownProvider: p.knownProvider,
            connected: p.auth.configured,
            models: rows
          };
        })
      );

      if (!cancelled) setGroups(providerGroups);
    })();
    return () => {
      cancelled = true;
    };
  }, [state.providers]);

  const active = state.active;

  async function select(g: PickerGroup, m: PickerModel): Promise<void> {
    if (!m.selectable) return;
    const key = `${g.providerId}:${m.id}`;
    setPending(key);
    const result = await window.api.ai.setActive(g.providerId, m.id, m.capabilities);
    setPending(null);
    if (result.ok) await onSelected();
  }

  return (
    <Command className={className}>
      <CommandInput placeholder="Search models…" autoFocus={autoFocus} />
      <CommandList className={listClassName}>
        {groups === null ? (
          <div className="flex items-center gap-2 px-2 py-6 text-muted-foreground text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            Loading models…
          </div>
        ) : (
          <>
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup
                key={g.key}
                heading={
                  <span className="flex items-center gap-1.5">
                    <ProviderBadge knownProvider={g.knownProvider} label={g.title} size="sm" />
                    <span className="uppercase tracking-wide">{g.title}</span>
                    {!g.connected && (
                      <span className="normal-case opacity-70">· Not connected</span>
                    )}
                  </span>
                }
              >
                {g.models.map((m) => {
                  const isActive = active?.providerId === g.providerId && active.model === m.id;
                  const isPending = pending === `${g.providerId}:${m.id}`;
                  return (
                    <CommandItem
                      key={m.id}
                      // Hide CommandItem's built-in trailing check (the last direct-child <svg>); we
                      // show our own active indicator and the capability badges own the right edge.
                      className="rounded-md [&>svg:last-child]:hidden"
                      value={`${g.title} ${m.id}`}
                      disabled={!m.selectable}
                      onSelect={() => void select(g, m)}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {isPending ? (
                          <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
                        ) : isActive ? (
                          <CheckIcon className="size-4 text-emerald-500" />
                        ) : !m.selectable ? (
                          <LockIcon className="size-3.5 text-muted-foreground/60" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{m.id}</span>
                      <CapabilityBadges caps={m.capabilities} source={m.source} compact />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
            {onManageProviders && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    // Keep only the leading settings icon; hide the built-in trailing check.
                    className="rounded-md text-muted-foreground [&>svg:last-child]:hidden"
                    value="manage providers"
                    onSelect={onManageProviders}
                  >
                    <SettingsIcon className="size-4" />
                    <span>Manage providers</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </>
        )}
      </CommandList>
    </Command>
  );
}
