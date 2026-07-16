import { Button } from "@mapos/ui/components/button";
import type { AiState, FetchedModel, ProviderView } from "@shared/ai-providers";
import { CheckCircle2Icon, ChevronRightIcon, Loader2Icon, LockIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ModelDetailSheet } from "./model-detail-sheet";
import { ProviderBadge } from "./provider-badge";

/** How many models a group shows before the "Show all" toggle. */
const COLLAPSE_COUNT = 4;

/** Whether listing a provider's models is worthwhile: known providers ship a catalog; custom
 * endpoints only yield a list once they have a usable token. (Mirrors `model-picker-list`.) */
function shouldFetch(p: ProviderView): boolean {
  return !!p.knownProvider || p.auth.configured;
}

/**
 * Models grouped inline under each configured provider — the body of the Settings AI Models tab and
 * the onboarding AI step. Each group lists its provider's models (newest-first as the provider
 * returns them); a row opens {@link ModelDetailSheet} to view capabilities and set the default.
 * Connecting/editing happens via the group's Edit action, never here.
 */
export function ProviderModelsList({
  state,
  onEditProvider,
  onSelected,
  onAddProvider
}: {
  state: AiState;
  onEditProvider: (provider: ProviderView) => void;
  /** Called after a default change, e.g. to reload the host's state. */
  onSelected: () => void | Promise<void>;
  /** When set, renders a "+ Add provider" action below the groups. */
  onAddProvider?: () => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<{ provider: ProviderView; model: FetchedModel } | null>(
    null
  );

  const active = state.active;
  const detailActive =
    !!detail && active?.providerId === detail.provider.id && active.model === detail.model.id;

  return (
    <div className="flex flex-col gap-5">
      {state.providers.map((p) => (
        <ProviderModelGroup
          key={p.id}
          provider={p}
          state={state}
          onEdit={() => onEditProvider(p)}
          onOpenModel={(model) => setDetail({ provider: p, model })}
        />
      ))}

      {onAddProvider && (
        <div className="flex justify-center">
          <Button variant="ghost" onClick={onAddProvider}>
            <PlusIcon className="size-4" />
            Add provider
          </Button>
        </div>
      )}

      <ModelDetailSheet
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        provider={detail?.provider ?? null}
        model={detail?.model ?? null}
        isActive={detailActive}
        onMadeDefault={onSelected}
      />
    </div>
  );
}

function ProviderModelGroup({
  provider,
  state,
  onEdit,
  onOpenModel
}: {
  provider: ProviderView;
  state: AiState;
  onEdit: () => void;
  onOpenModel: (model: FetchedModel) => void;
}): React.JSX.Element {
  const [models, setModels] = useState<FetchedModel[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  const canFetch = shouldFetch(provider);

  // Fetch on mount and refetch whenever the provider row changes — every getAiState() reload maps
  // fresh objects, so any ai:changed (edit, reconnect, secret swap) re-runs this. Keep the previous
  // list visible while refetching; only the initial load shows the spinner.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = canFetch ? await window.api.ai.listModels(provider.id) : null;
      // Providers return models oldest-first; reverse so the newest are at the top (and in the
      // collapsed view).
      if (!cancelled) setModels(result?.ok === true ? [...result.models].reverse() : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, canFetch]);

  const active = state.active;
  const visible = expanded ? models : models?.slice(0, COLLAPSE_COUNT);
  const canToggle = (models?.length ?? 0) > COLLAPSE_COUNT;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderBadge knownProvider={provider.knownProvider} label={provider.label} size="sm" />
          <span className="truncate font-medium text-sm">{provider.label}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit
        </Button>
      </div>

      {models === null ? (
        <div className="flex items-center gap-2 rounded-lg border px-3 py-4 text-muted-foreground text-sm">
          <Loader2Icon className="size-4 animate-spin" />
          Loading models…
        </div>
      ) : models.length === 0 ? (
        <div className="rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground text-sm">
          {provider.auth.configured
            ? "No models available."
            : "Connect this provider to see models."}
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border">
          {visible?.map((m) => {
            const isActive = active?.providerId === provider.id && active.model === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onOpenModel(m)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{m.id}</span>
                {isActive && (
                  <CheckCircle2Icon
                    className="size-4 shrink-0 text-emerald-500"
                    aria-label="Default model"
                  />
                )}
                {provider.auth.configured ? (
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <LockIcon
                    className="size-3.5 shrink-0 text-muted-foreground/60"
                    aria-label="Not connected"
                  />
                )}
              </button>
            );
          })}
          {canToggle && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="w-full px-3 py-1.5 text-center font-medium text-muted-foreground text-sm transition-colors hover:bg-hover"
            >
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
