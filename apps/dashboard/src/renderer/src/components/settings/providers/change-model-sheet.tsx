import { Input } from "@mapos/ui/components/input";
import { cn } from "@mapos/ui/lib/utils";
import type { ModelCapabilities } from "@shared/ai-models";
import type { AiState, CapabilitySource, ProviderView } from "@shared/ai-providers";
import { CheckIcon, Loader2Icon, LockIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsSheet } from "../settings-sheet";
import { CapabilityBadges } from "./capability-badges";
import { ProviderBadge } from "./provider-badge";

type PickerModel = {
  /** Model id passed to setActive. */
  id: string;
  /** What's shown to the user (the raw model id). */
  display: string;
  capabilities: ModelCapabilities;
  source?: CapabilitySource;
  selectable: boolean;
  /** Right-aligned detail for unavailable rows, e.g. a download size. */
  detail?: string;
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
 * The single model selector. Aggregates each configured provider's models into one searchable list.
 * Select-only: models from a not-connected provider render locked/disabled. Connecting happens in
 * Sources, never here.
 */
export function ChangeModelSheet({
  open,
  onOpenChange,
  state,
  onSelected
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AiState;
  onSelected: () => void | Promise<void>;
}): React.JSX.Element {
  const [groups, setGroups] = useState<PickerGroup[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Plain autoFocus fires while the sheet is still offscreen (translate-x-full), and the
  // focus scroll-into-view drags the overflow-hidden dialog body sideways. preventScroll
  // keeps the background still during the slide-in. Stable identity so the ref only fires
  // on mount, not on every keystroke re-render.
  const focusOnMount = useCallback((el: HTMLInputElement | null) => {
    el?.focus({ preventScroll: true });
  }, []);

  // Build the grouped catalog whenever the sheet opens (or the provider set changes).
  useEffect(() => {
    if (!open) return;
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
                  display: m.id,
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
  }, [open, state.providers]);

  const active = state.active;

  const filtered = useMemo(() => {
    if (!groups) return null;
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => {
        const titleMatch = g.title.toLowerCase().includes(q);
        const models = titleMatch ? g.models : g.models.filter((m) => m.display.toLowerCase().includes(q));
        return { ...g, models };
      })
      .filter((g) => g.models.length > 0);
  }, [groups, query]);

  async function select(g: PickerGroup, m: PickerModel): Promise<void> {
    if (!m.selectable) return;
    const key = `${g.providerId}:${m.id}`;
    setPending(key);
    const result = await window.api.ai.setActive(g.providerId, m.id, m.capabilities);
    setPending(null);
    if (result.ok) {
      await onSelected();
      onOpenChange(false);
    }
  }

  return (
    <SettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Change model"
      description="Search every model — local & cloud"
      width={460}
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            ref={focusOnMount}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="pl-8"
          />
        </div>

        {!filtered && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading models…
          </div>
        )}

        {filtered?.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">No models match "{query}".</div>
        )}

        {filtered?.map((g) => (
          <div key={g.key} className="flex flex-col">
            <div className="flex items-center gap-2 px-1 py-1.5">
              <ProviderBadge knownProvider={g.knownProvider} label={g.title} size="sm" />
              <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {g.title}
              </span>
              {!g.connected && <span className="text-muted-foreground/70 text-xs">· Not connected</span>}
            </div>

            {g.models.length === 0 ? (
              <div className="px-2 py-1.5 text-muted-foreground/70 text-xs">
                {g.connected ? "No models found." : "Connect in Sources to list models."}
              </div>
            ) : (
              <div className="flex flex-col">
                {g.models.map((m) => {
                  const isActive = active?.providerId === g.providerId && active.model === m.id;
                  const key = `${g.providerId}:${m.id}`;
                  const isPending = pending === key;
                  return (
                    <button
                      type="button"
                      key={m.id}
                      disabled={!m.selectable}
                      onClick={() => void select(g, m)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                        m.selectable
                          ? "cursor-pointer hover:bg-accent/50"
                          : "cursor-default opacity-55",
                        isActive && "bg-accent"
                      )}
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
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{m.display}</span>
                      {m.detail && (
                        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                          {m.detail}
                        </span>
                      )}
                      <CapabilityBadges caps={m.capabilities} source={m.source} compact />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </SettingsSheet>
  );
}
